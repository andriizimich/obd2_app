// Smoke test for the diagnostics readers (src/obd/mode01.ts and, from
// stage 1 on, frames.ts / dtc.ts / mode03.ts / diagnostics.ts).
// Run with: npx tsx scripts/obd-diag-smoke.ts
// No hardware needed — feeds fabricated response streams.

import { Elm327Channel } from "../src/obd/at";
import { decodeOdometer, decodeStatus, extractPidData, readOdometer } from "../src/obd/mode01";
import { readDiagnosticsOver } from "../src/obd/diagnostics";
import { emptyDetail } from "../src/obd/reply";
import {
  decodeDtcPair,
  describeDtcStructurally,
  encodeDtc,
  estimateSeverity,
  groupForDtc,
  toFault,
} from "../src/obd/dtc";
import { DTC_DICTIONARY } from "../src/obd/dtc-dictionary";
import { reportText } from "../src/api/telegram";
import { BUILD_STAMP } from "../src/build";
import {
  detectProtocolCode,
  parseKwpVin,
  readVehicleInfoOver,
  stitchAdjacentOptions,
  stitchFragments,
  sweepIdentificationBlock,
} from "../src/obd/mode09";
import { unidentifiedVehicle } from "../src/obd/identify";
import type {
  Coverage,
  DiagnosticReport,
  FaultSeverity,
  Vehicle,
} from "../src/obd/types";

/** The car the fixtures describe: the HEALTHY table is a VW-shaped reply
 *  with 178 464 km on it. */
const VW: Vehicle = {
  vin: "WVW1JZXWXJP000001",
  make: "Volkswagen",
  model: "Passat",
  year: 2018,
  mileage: 178_464,
};

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

/**
 * Feed a fixture reply. `feed` only cuts complete lines, so a trailing `>`
 * prompt with no `\r` after it stays in the buffer and arrives glued to the
 * front of the NEXT reply (`>A6`) — which reads as a line the adapter never
 * sent. Terminate it here so fixtures can stay written the way an adapter
 * prints them.
 */
function feedReply(ch: Elm327Channel, reply: string): void {
  ch.feed(reply.endsWith("\r") ? reply : `${reply}\r`);
}

/** An Elm327Channel that answers `reply` to the next command. */
function channelFor(reply: string): { ch: Elm327Channel; sent: string[] } {
  const sent: string[] = [];
  const ch = new Elm327Channel((raw) => {
    sent.push(raw);
    setTimeout(() => feedReply(ch, reply), 0);
  });
  return { ch, sent };
}

/** An Elm327Channel driven by a per-command reply table, logging everything
 *  sent. An unknown command gets `fallback` — the adapter's way of saying
 *  "not that one". */
function tableChannel(
  replies: Record<string, string>,
  fallback = "NO DATA\r>",
): { ch: Elm327Channel; sent: string[] } {
  const sent: string[] = [];
  const ch = new Elm327Channel((raw) => {
    const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
    sent.push(cmd);
    setTimeout(() => feedReply(ch, replies[cmd] ?? fallback), 0);
  });
  return { ch, sent };
}

/** A table channel whose first `silent[cmd]` attempts at a command are
 *  answered with nothing at all — the adapter going quiet mid-pass, which is
 *  the one failure a second ask can change. `Infinity` keeps it quiet. */
function silentOnceChannel(
  replies: Record<string, string>,
  silent: Record<string, number>,
  fallback = "NO DATA\r>",
): { ch: Elm327Channel; sent: string[] } {
  const sent: string[] = [];
  const owed: Record<string, number> = { ...silent };
  const ch = new Elm327Channel((raw) => {
    const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
    sent.push(cmd);
    const left = owed[cmd] ?? 0;
    if (left > 0) {
      owed[cmd] = left - 1;
      return; // nothing comes back, so this read times out
    }
    setTimeout(() => feedReply(ch, replies[cmd] ?? fallback), 0);
  });
  return { ch, sent };
}

/** A table channel whose answers can be swapped mid-pass.
 *
 *  A bus that behaves differently on the other side of a reset or a pinned
 *  protocol is the whole subject of the recovery tests, and a fixed table
 *  cannot describe one: `set` is called from `onCommand`, which sees each
 *  command as it is sent, which is exactly when a real bus would change. */
function mutableChannel(
  initial: Record<string, string>,
  fallback = "NO DATA\r>",
  onCommand?: (cmd: string) => void,
): {
  ch: Elm327Channel;
  sent: string[];
  set: (replies: Record<string, string>, fallback?: string) => void;
} {
  let replies = initial;
  let miss = fallback;
  const sent: string[] = [];
  const ch = new Elm327Channel((raw) => {
    const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
    sent.push(cmd);
    onCommand?.(cmd);
    setTimeout(() => feedReply(ch, replies[cmd] ?? miss), 0);
  });
  return {
    ch,
    sent,
    set(next, nextFallback = miss) {
      replies = next;
      miss = nextFallback;
    },
  };
}

/** Response lines for a healthy car: 3 stored codes, 1 pending, 1 permanent,
 *  lamp on, a real odometer, and auto-detected CAN 11-bit/500k (ATDPN "A6"). */
const HEALTHY: Record<string, string> = {
  ATAL: "OK\r>",
  ATDPN: "A6\r>",
  ATH1: "OK\r>",
  ATH0: "OK\r>",
  "03": "7E8 08 43 03 03 00 04 20 01 71\r>",
  "07": "7E9 04 47 01 07 01\r>",
  "0A": "7E8 04 4A 01 03 01\r>",
  "0101": "7E8 06 41 01 83 07 65 04\r>",
  "01A6": "7E8 06 41 A6 00 1B 3B 40\r>",
};

const coverageOf = (report: DiagnosticReport, request: string): Coverage | undefined =>
  report.coverage.find((c) => c.request === request);

const FAST = { timeoutMs: 150 };

async function main() {
  // ---------- odometer decoding (mode 01, PID A6) ----------

  const KM = 178_464; // 0x001B3B40 / 10

  check("odometer: 4 bytes big-endian, 0.1 km resolution", decodeOdometer([0x00, 0x1b, 0x3b, 0x40]) === KM, String(decodeOdometer([0x00, 0x1b, 0x3b, 0x40])));
  check("odometer: short frame rejected", decodeOdometer([0x00, 0x1b]) === null);
  check("odometer: empty rejected", decodeOdometer([]) === null);
  // 0xFFFFFFFF = 429 496 729.5 km — a real odometer tops out around 2 000 000.
  check("odometer: absurd value hits the guard rail", decodeOdometer([0xff, 0xff, 0xff, 0xff]) === null);
  // All-zero is a padding frame, not a brand-new car: a blank beats a lie.
  check("odometer: zero rejected as padding", decodeOdometer([0, 0, 0, 0]) === null);

  // ---------- anchor scan ----------

  check(
    "odometer: anchor finds a bare `41 A6`",
    JSON.stringify(extractPidData([0x41, 0xa6, 0x00, 0x1b, 0x3b, 0x40], 0xa6)) === JSON.stringify([0x00, 0x1b, 0x3b, 0x40]),
  );
  check("odometer: no anchor yields null", extractPidData([0x41, 0x0c, 0x1a, 0xf8], 0xa6) === null);
  check("odometer: truncated after anchor yields null", extractPidData([0x41, 0xa6, 0x00, 0x1b], 0xa6) === null);

  // ---------- readOdometer over a channel ----------

  {
    const { ch, sent } = channelFor("41 A6 00 1B 3B 40\r>");
    const km = await readOdometer(ch);
    check("odometer: bare single frame", km === KM, String(km));
    check("odometer: queried PID A6", sent[0] === "01A6\r", JSON.stringify(sent));
  }

  {
    // CAN reply: 11-bit header and the 06 PCI length byte ahead of the payload.
    const { ch } = channelFor("7E8 06 41 A6 00 1B 3B 40\r>");
    check("odometer: CAN header + PCI byte", (await readOdometer(ch)) === KM);
  }

  {
    // Last frame of a multi-frame reply is padded, so the value must come
    // from the four bytes after the anchor and nothing else.
    const { ch } = channelFor("41 A6 00 1B 3B 40 AA AA\r>");
    check("odometer: ISO-TP tail padding ignored", (await readOdometer(ch)) === KM);
  }

  {
    // A clone with echo still on, and the multi-line index prefixes.
    const { ch } = channelFor("01A6\r0: 41 A6 00 1B 3B 40\r\r>");
    check("odometer: echo and `0:` prefix", (await readOdometer(ch)) === KM);
  }

  {
    const { ch } = channelFor("NO DATA\r>");
    check("odometer: NO DATA resolves null, does not throw", (await readOdometer(ch)) === null);
  }

  {
    const { ch } = channelFor("?\r>");
    check("odometer: `?` resolves null, does not throw", (await readOdometer(ch)) === null);
  }

  {
    // A different PID answering must not be mistaken for the odometer.
    const { ch } = channelFor("41 0C 0F A0 00 00\r>");
    check("odometer: unrelated PID ignored", (await readOdometer(ch)) === null);
  }

  {
    let rejected = false;
    const ch = new Elm327Channel(() => {});
    try {
      await readOdometer(ch, 120);
    } catch {
      rejected = true;
    }
    check("odometer: silent adapter rejects (caller catches)", rejected);
  }

  // ---------- PID 01: the lamp and the ECU's own count ----------

  {
    const on = decodeStatus([0x83, 0x07, 0x65, 0x04]);
    check(
      "status: MIL on, 3 stored codes, spark ignition",
      on?.milOn === true && on.dtcCount === 3 && on.compressionIgnition === false,
      JSON.stringify(on),
    );
    const off = decodeStatus([0x00, 0x00, 0x00, 0x00]);
    check(
      "status: MIL off, no codes",
      off?.milOn === false && off.dtcCount === 0,
      JSON.stringify(off),
    );
    check(
      "status: bit 3 of byte B is compression ignition",
      decodeStatus([0x00, 0x08, 0x00, 0x00])?.compressionIgnition === true,
    );
    check("status: a short frame is refused", decodeStatus([0x83]) === null);
  }

  // ---------- the full pass over a healthy car ----------

  {
    const { ch, sent } = tableChannel(HEALTHY);
    const report = await readDiagnosticsOver(ch, FAST);

    check("pass: headers were turned on", report.headersOn === true);
    check(
      "pass: ATDPN's auto-detect prefix is stripped",
      report.protocol === "ISO 15765-4 (CAN 11-bit/500k)",
      String(report.protocol),
    );
    check(
      "pass: odometer reaches the report",
      report.mileage === 178_464,
      String(report.mileage),
    );
    check(
      "pass: the lamp state comes from PID 01",
      report.status?.milOn === true && report.status.dtcCount === 3,
      JSON.stringify(report.status),
    );

    check(
      "pass: five codes, all three lists represented",
      report.faults.length === 5,
      report.faults.map((f) => `${f.code}/${f.status}`).join(" "),
    );
    check(
      "pass: stored / pending / permanent are told apart",
      report.faults.filter((f) => f.status === "stored").length === 3 &&
        report.faults.find((f) => f.code === "P0701")?.status === "pending" &&
        report.faults.find((f) => f.code === "P0301")?.status === "permanent",
      report.faults.map((f) => `${f.code}:${f.status}`).join(" "),
    );
    check(
      "pass: codes are attributed to the module that sent them",
      report.faults.find((f) => f.code === "P0701")?.module === "Transmission" &&
        report.faults.find((f) => f.code === "P0300")?.module === "Engine",
      report.faults.map((f) => `${f.code}:${f.module}`).join(" "),
    );
    check(
      "pass: every stage reports coverage",
      report.coverage.length === 5 &&
        report.coverage.every((c) => c.status === "ok"),
      report.coverage.map((c) => `${c.request}:${c.status}`).join(" "),
    );
    check(
      "pass: the ECU's count agrees, so no discrepancy note",
      report.notes.length === 0,
      report.notes.join(" | "),
    );
    check(
      "pass: raw lines are kept for the debug surface",
      report.rawLines.length > 0,
      report.rawLines.join(" | "),
    );

    // The header state is process-wide, so it must go back off before the
    // pass returns — mode 09's connect-time reads assume the default.
    check(
      "pass: ATH1 is sent before the first read and ATH0 after the last",
      sent.indexOf("ATH1") > -1 &&
        sent.indexOf("ATH1") < sent.indexOf("03") &&
        sent.indexOf("ATH0") > sent.indexOf("01A6"),
      sent.join(" "),
    );
  }

  // ---------- an adapter that has not found the protocol yet ----------
  // Measured on the same car as the dump above: one pass answered `A5` and
  // the next called the protocol unknown, because ATAL had just reset the
  // adapter and nothing had been asked of the bus since. The retry is what
  // turns that into a protocol line instead of a warning about CAN.

  {
    const sent: string[] = [];
    let dpn = 0;
    const ch = new Elm327Channel((raw) => {
      const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
      sent.push(cmd);
      const reply =
        cmd === "ATDPN"
          ? dpn++ === 0
            ? "AUTO\r>" // nothing on the bus yet — no code to report
            : "A5\r>"
          : (HEALTHY[cmd] ?? "NO DATA\r>");
      setTimeout(() => feedReply(ch, reply), 0);
    });
    const report = await readDiagnosticsOver(ch, FAST);

    check(
      "protocol: an adapter that answers AUTO is asked again after a bus request",
      sent.join(",").includes("ATDPN,0100,ATDPN"),
      sent.join(","),
    );
    check(
      "protocol: the retry's answer is the one reported",
      report.protocol?.includes("KWP2000, fast init") === true,
      report.protocol ?? undefined,
    );
    check(
      "protocol: no unknown-protocol warning is raised",
      !report.notes.some((n) => n.includes("Protocol unknown")),
      report.notes.join(" | "),
    );
  }

  // ---------- the connect-time reads ----------
  // `readVehicleInfoOver` runs right after ATAL and asks for four things in a
  // row. What it must never do is put a request on the car's bus that the car
  // never asked for: a `0100` "wake" sat in front of `ATDPN` here for one
  // build, on the theory that a just-reset adapter answers `AUTO` until it has
  // carried a message, and that build read nothing at all from a car that had
  // answered minutes earlier on the same adapter. The theory was not measured
  // — on the run where every read worked, `ATDPN` answered first try with no
  // wake, which is the opposite of what it predicts.

  {
    const sent: string[] = [];
    const ch = new Elm327Channel((raw) => {
      const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
      sent.push(cmd);
      const reply =
        cmd === "ATDPN"
          ? // The measured car: the adapter cannot name the protocol it is on.
            "AUTO\r>"
          : cmd === "0902"
            ? "80 F1 12 14 49 02 01 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31 9A\r>"
            : (HEALTHY[cmd] ?? "NO DATA\r>");
      setTimeout(() => feedReply(ch, reply), 0);
    });
    const info = await readVehicleInfoOver(ch);

    check(
      "connect: nothing is put on the car's bus that the car did not ask for",
      !sent.includes("0100"),
      sent.join(","),
    );
    // The dash is the honest answer to `AUTO`, and it costs nothing: the read
    // that matters still lands. A protocol name is a label on the screen; the
    // VIN is the identification.
    check(
      "connect: an unnameable protocol is a dash, and the VIN read still lands",
      info.protocol === null && info.vin === "WVWZZZ1JZXW000001",
      `${info.protocol ?? "null"} / ${info.vin ?? "null"}`,
    );
  }

  // …and the protocol still comes through when the adapter does know it. The
  // two blocks differ only in the ATDPN reply, so together they pin the
  // behaviour to the adapter's answer rather than to the request sequence.
  {
    const sent: string[] = [];
    const ch = new Elm327Channel((raw) => {
      const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
      sent.push(cmd);
      const reply =
        cmd === "ATDPN"
          ? "A5\r>"
          : cmd === "0902"
            ? "80 F1 12 14 49 02 01 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31 9A\r>"
            : (HEALTHY[cmd] ?? "NO DATA\r>");
      setTimeout(() => feedReply(ch, reply), 0);
    });
    const info = await readVehicleInfoOver(ch);
    check(
      "connect: an adapter that knows its protocol is named, and is not woken",
      !sent.includes("0100") && info.protocol?.includes("KWP2000, fast init") === true,
      sent.join(","),
    );
  }

  // Every identification factor is best-effort, so one lost answer is a lost
  // car: a `0902` that goes unanswered once is the difference between a named
  // vehicle on the dashboard and "Unknown". One repeat is what stands between
  // the two, and after the channel's drain a second silence means the car is
  // not talking rather than that the moment was bad.
  {
    const sent: string[] = [];
    let silences = 1;
    const ch = new Elm327Channel((raw) => {
      const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
      sent.push(cmd);
      if (cmd === "0902" && silences > 0) {
        silences -= 1;
        return; // the adapter goes quiet on the one read that names the car
      }
      const reply =
        cmd === "0902"
          ? "80 F1 12 14 49 02 01 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31 9A\r>"
          : (HEALTHY[cmd] ?? "NO DATA\r>");
      setTimeout(() => feedReply(ch, reply), 0);
    });
    const info = await readVehicleInfoOver(ch, 150);

    check(
      "connect: a VIN read that timed out is asked again, and the car is named",
      sent.filter((cmd) => cmd === "0902").length === 2 &&
        info.vin === "WVWZZZ1JZXW000001",
      `${sent.filter((cmd) => cmd === "0902").length}×0902 — ${info.vin ?? "null"}`,
    );
  }

  // ---------- the prompt is a byte, not a line ending ----------
  // The adapter prints `>` when it is done and puts nothing after it, so two
  // consecutive commands arrive as `A5\r>OK\r` — one answer, one prompt, and
  // the next answer already coming. Splitting on \r alone keeps the prompt in
  // the buffer until the next \r turns up, and it lands in front of whatever
  // arrived next: `>A5`, `>OK`, `>7F 09 12`. That is not cosmetic. `ATDPN`
  // answers `A5` and is the only line that names the bus; a parser handed
  // `>A5` recognises no protocol at all, which is exactly what a real car
  // reported while the protocol was on the wire the whole time.

  {
    let commands = 0;
    const ch = new Elm327Channel(() => {
      commands += 1;
      // Deliberately no \r after the prompt: this is how the adapter prints
      // it, and the fixture has to print it the same way or it proves nothing.
      setTimeout(() => ch.feed(commands === 1 ? "OK\r>" : "A5\r>"), 0);
    });
    const first = await ch.command("ATAL", 500);
    const second = await ch.command("ATDPN", 500);
    check(
      "channel: a prompt with no \\r does not glue onto the next reply",
      first.join("|") === "OK" && second.join("|") === "A5",
      `${JSON.stringify(first)} then ${JSON.stringify(second)}`,
    );
    check(
      "channel: the protocol code is readable from the line the adapter sent",
      detectProtocolCode(second) === "5",
      String(detectProtocolCode(second)),
    );
  }

  // ---------- the VIN behind the maker's own service ----------
  // EOBD required mode 09 PID 02 only from the 2002 model year for petrol and
  // 2004 for diesel. An older car answers `7F 09 12` — "not supported" — and
  // holds the same VIN behind KWP2000 `1A 90`, which answers `5A 90` plus the
  // seventeen characters. The car that produced the "no VIN was read" report
  // is one of those: it refused 0902 and answered 0904.

  {
    check(
      "kwp vin: the anchor and the characters behind it",
      parseKwpVin([
        "5A 90 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31 2E",
      ]) === "WVWZZZ1JZXW000001",
    );
    check(
      "kwp vin: a length byte between the anchor and the characters is skipped",
      parseKwpVin([
        "5A 90 11 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31",
      ]) === "WVWZZZ1JZXW000001",
    );
    check(
      "kwp vin: a refusal is not a VIN",
      parseKwpVin(["7F 1A 12"]) === null &&
        parseKwpVin(["NO DATA"]) === null,
    );

    // The seventeen characters do not fit in one frame: a KWP2000 frame
    // carries at most seven data bytes, so `5A 90` plus **five** characters
    // is a whole one. The parser that returned the first run of three or
    // more characters and stopped turned the frames that came after the
    // first — which were on the wire — into a car it could not name: the
    // `B3338` of a real report is exactly the payload of frame one.
    const VIN = "WVWZZZ1JZXW000001";
    const hex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
    const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const kwp = (chunk: string) => `5A 90 ${chars(chunk).map(hex).join(" ")}`;
    const chunked = (size: number) => VIN.match(new RegExp(`.{1,${size}}`, "g")) ?? [];

    // Shape one: the maker repeats the anchor on every frame. The anchor's
    // first byte is `0x5A` — the letter Z, which *is* a legal VIN character —
    // so a run only stops at the next anchor if it is looking for it. Read
    // as plain data, that Z joins the run in front of it and every character
    // after it lands one place too far right.
    check(
      "kwp vin: an anchor repeated on each frame is joined, not cut at the first",
      parseKwpVin(chunked(5).map(kwp)) === VIN,
      JSON.stringify(chunked(5).map(kwp)),
    );

    // Shape two: the anchor is sent once and the rest streams behind it.
    check(
      "kwp vin: an anchor sent once with the characters behind it reads whole",
      parseKwpVin([
        kwp(VIN.slice(0, 5)),
        // The seven-byte frames that follow carry data only — no anchor to
        // find them by, which is the whole reason a run has to reach across
        // the frame boundary rather than start again at each one.
        ...(VIN.slice(5).match(/.{1,7}/g) ?? []).map((c) =>
          chars(c).map(hex).join(" "),
        ),
      ]) === VIN,
    );

    // Shape three: headers on, so each frame carries a legacy header and a
    // trailing checksum — the framing a run has to step over to reach the
    // next frame's characters.
    const legacy = (data: number[]) => {
      const body = [0x80 | data.length, 0xf1, 0x12, ...data];
      return [...body, body.reduce((a, b) => a + b, 0) & 0xff]
        .map(hex)
        .join(" ");
    };
    check(
      "kwp vin: headers on — header and checksum come off before the join",
      parseKwpVin(chunked(5).map((c) => legacy([0x5a, 0x90, ...chars(c)]))) === VIN,
    );

    // …and one frame is still one frame. Five characters is a fragment and
    // must read as one: it is a real answer from a car that stopped talking,
    // not a wrong VIN.
    check(
      "kwp vin: a lone first frame is a fragment, not a whole VIN",
      parseKwpVin([kwp("B3338")]) === "B3338",
    );

    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "5A 90 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31 2E\r>",
    });
    const info = await readVehicleInfoOver(ch);
    check(
      "connect: a car that refuses the mode 09 VIN is asked in the other dialect",
      sent.includes("1A 90") && info.vin === "WVWZZZ1JZXW000001",
      `${sent.join(",")} — ${info.vin ?? "null"}`,
    );
    check(
      "connect: both VIN questions stay on the record",
      info.reads?.find((r) => r.request === "0902")?.status === "unsupported" &&
        info.reads?.find((r) => r.request === "1A 90")?.status === "ok",
      JSON.stringify(info.reads?.filter((r) => r.request.includes("90"))),
    );
    check(
      "connect: the fragment is attributed to the read that produced it",
      info.vinFrom === "1A 90",
      String(info.vinFrom),
    );
    check(
      "connect: the standard PID claims the VIN when it is the one that answers",
      (await readVehicleInfoOver(
        tableChannel({ ...HEALTHY, "0902": "49 02 01 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31\r>" }).ch,
      )).vinFrom === "0902",
    );
    check(
      "connect: no VIN means no source either",
      (await readVehicleInfoOver(tableChannel({ ...HEALTHY, "0902": "NO DATA" }).ch))
        .vinFrom === null,
    );
    // The reply rides along with the read that caused it. A fragment that
    // looks wrong is either a car answering in a layout nothing anticipated
    // or a parser anchored on the wrong bytes, and only the bytes settle it.
    check(
      "connect: each read keeps the adapter's own words",
      info.reads?.find((r) => r.request === "1A 90")?.raw?.[0]?.startsWith("5A 90") === true &&
        info.reads?.find((r) => r.request === "0902")?.raw?.[0] === "7F 09 12",
      JSON.stringify(info.reads?.map((r) => [r.request, r.raw])),
    );
    check(
      // The failure case is the one the words are for: `NO DATA`, `UNABLE TO
      // CONNECT` and a bare timeout are three different problems that the
      // status alone renders as one dash.
      "connect: a read that came back empty keeps the words that came back",
      (await readVehicleInfoOver(tableChannel({ ...HEALTHY, "090A": "NO DATA" }).ch))
        .reads?.find((r) => r.request === "090A")?.raw?.[0] === "NO DATA",
    );
  }

  // The car of 2026-09-17, through the whole connect path rather than through
  // the parser alone. Every fixture above is built to exercise one branch;
  // these are the two replies that car actually produced — `0904` numbering
  // each of its messages and dropping a `7F 09 78` between the identifiers,
  // `090A` refusing — and what the screens show comes from here, not from
  // `parseCalid` in isolation.
  {
    const { ch } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "5A 90 42 33 33 33 38 FF 00\r>",
      "0904":
        "49 04 01 37 35 33 39\r" +
        "49 04 02 30 37 33 00\r" +
        "49 04 03 00 00 00 00\r" +
        "49 04 04 00 00 00 00\r" +
        "7F 09 78\r" +
        "49 04 05 37 35 35 38\r" +
        "49 04 06 33 36 33 00\r" +
        "49 04 07 00 00 00 00\r>",
      "090A": "7F 09 12\r>",
    });
    const info = await readVehicleInfoOver(ch);

    check(
      "connect: the measured car's own 0904 yields its two CALIDs",
      JSON.stringify(info.calid) === JSON.stringify(["7539073", "7558363"]),
      JSON.stringify(info.calid),
    );
    check(
      "connect: a refused ECU name is no name, not the reply's own bytes",
      info.ecuName === null,
      String(info.ecuName),
    );
    check(
      "connect: the identification reads stay on the record with their words",
      info.reads?.find((r) => r.request === "0904")?.status === "ok" &&
        info.reads?.find((r) => r.request === "0904")?.raw?.length === 8,
      JSON.stringify(info.reads?.map((r) => [r.request, r.status, r.raw?.length])),
    );
  }

  {
    // The same refusal on a CAN car: mode 09 VIN is mandatory there, the
    // service does not exist, and the request would be one frame of noise on
    // somebody else's bus.
    const { ch, sent } = tableChannel({ ...HEALTHY, "0902": "7F 09 12\r>" });
    const info = await readVehicleInfoOver(ch);
    check(
      "connect: a CAN car is not asked a KWP2000 service",
      !sent.includes("1A 90") && !sent.includes("21 81") && info.vin === null,
      sent.join(","),
    );
  }

  // ---------- every dialect a car can answer in ----------
  // The cascade is universal on purpose. The car in front of it is one car,
  // and which request names it is a property of that car — a 2004 K-line car
  // and a 2015 CAN car share no VIN request at all. These pin each dialect,
  // the bus it is allowed on, and the two ways a cascade does worse than the
  // single request it replaced.
  const DIALECT_VIN = "WVWZZZ1JZXW000001";
  const dialectHex = [...DIALECT_VIN]
    .map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");

  {
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "7F 1A 12\r>",
      "21 81": `61 81 ${dialectHex}\r>`,
    });
    const info = await readVehicleInfoOver(ch);
    check(
      "cascade: a car that refuses 1A 90 too answers the local identifier 21 81",
      info.vin === DIALECT_VIN && info.vinFrom === "21 81",
      `${sent.join(",")} — ${info.vin ?? "null"} from ${info.vinFrom ?? "null"}`,
    );
  }

  {
    // The refusal is a fact about the car, not a gap in the app: `7F 21 11`
    // is the ECU saying this service does not exist, and it has to reach the
    // record as that. Read as unrecognised bytes it said the opposite — that
    // bytes came back and the app could not understand them.
    const { ch } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "7F 1A 12\r>",
      "21 81": "7F 21 11\r>",
    });
    const info = await readVehicleInfoOver(ch);
    const refused = info.reads?.find((r) => r.request === "21 81");
    check(
      "cascade: a refused dialect is recorded as unsupported with its reason",
      refused?.status === "unsupported" &&
        refused.detail === "mode 0x21 rejected: service not supported",
      JSON.stringify(refused),
    );
  }

  {
    // …and because a refusal is an answer, it does not spend the connect's
    // single retry. That retry belongs to the read that genuinely went quiet:
    // here the two dialects before it are refused, `21 81` is the one that
    // says nothing the first time, and the car is still named.
    const { ch, sent } = silentOnceChannel(
      {
        ...HEALTHY,
        ATDPN: "A5\r>",
        "0902": "7F 09 12\r>",
        "1A 90": "7F 1A 12\r>",
        "21 81": `61 81 ${dialectHex}\r>`,
      },
      { "21 81": 1 },
    );
    const info = await readVehicleInfoOver(ch, 150);
    check(
      "cascade: a refused dialect does not spend the retry a silent one needs",
      info.vin === DIALECT_VIN && sent.filter((c) => c === "21 81").length === 2,
      `${sent.join(",")} — ${info.vin ?? "null"}`,
    );
  }

  {
    // Trap one, and the reason the cascade is not a chain of `else if`: a
    // fragment used to end the search. A car answering three characters to
    // `0902` and the whole VIN to `1A 90` was read as `WVW` and nothing else,
    // because `0902` had spoken.
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "49 02 01 57 56 57\r>",
      "1A 90": "5A 90 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31 2E\r>",
    });
    const info = await readVehicleInfoOver(ch);
    check(
      "cascade: a fragment does not end a search a whole VIN answers",
      sent.includes("1A 90") && info.vin === DIALECT_VIN,
      `${sent.join(",")} — ${info.vin ?? "null"}`,
    );
  }

  {
    // …and a whole VIN does end it. The dialects behind it describe the same
    // car, and every one of them is a request on a bus this app is a guest
    // on.
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": `49 02 01 ${dialectHex}\r>`,
    });
    await readVehicleInfoOver(ch);
    check(
      "cascade: a whole VIN ends the cascade and asks the car nothing else",
      !sent.includes("1A 90") &&
        !sent.includes("21 81") &&
        !sent.includes("22 F1 90"),
      sent.join(","),
    );
  }

  {
    // Trap two: a dialect nobody here has watched answer has to arrive
    // whole. The bytes behind `61 81` are whatever that ECU keeps under that
    // identifier, so a fragment of them is a guess — and this one is longer
    // than the real fragment beside it, which is how it would have won.
    const { ch } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "5A 90 42 33 33 33 38 FF 00\r>",
      "21 81": "61 81 41 42 43 44 45 46 47\r>",
    });
    const info = await readVehicleInfoOver(ch);
    check(
      "cascade: a measured fragment beats a longer guess from an unseen dialect",
      info.vin === "B3338" && info.vinFrom === "1A 90",
      `${info.vin ?? "null"} from ${info.vinFrom ?? "null"}`,
    );
  }

  {
    // The CAN half of the cascade, and the read mode 09 does not replace:
    // UDS `ReadDataByIdentifier` on F190, the VIN identifier by standard.
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      "0902": "7F 09 12\r>",
      "22 F1 90": `62 F1 90 ${dialectHex}\r>`,
    });
    const info = await readVehicleInfoOver(ch);
    check(
      "cascade: a CAN car that refuses the standard read answers UDS F190",
      info.vin === DIALECT_VIN && info.vinFrom === "22 F1 90",
      `${sent.join(",")} — ${info.vin ?? "null"} from ${info.vinFrom ?? "null"}`,
    );
  }

  {
    // J1850 is neither bus: `1A`/`21` are KWP2000 services it does not have,
    // and `22 F1 90` is a UDS request it cannot answer. A car there gets the
    // standard read and nothing else — the sets are not complements.
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A2\r>",
      "0902": "7F 09 12\r>",
    });
    await readVehicleInfoOver(ch);
    check(
      "cascade: a J1850 car is asked for the VIN the standard way only",
      !sent.includes("1A 90") &&
        !sent.includes("21 81") &&
        !sent.includes("22 F1 90"),
      sent.join(","),
    );
  }

  {
    // The sweep's skip is wired to the cascade now rather than to a
    // hard-coded "did the fallback run": whichever dialect claimed option
    // `0x90` has to keep the sweep from asking the same question again.
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "5A 90 42 33 33 33 38 FF 00\r>",
    });
    await readVehicleInfoOver(ch, undefined, { sweepIdentification: true });
    // `1A 90` legitimately appears twice now — once as the dialect, once as
    // the repeat that exists because a single KWP2000 frame is smaller than
    // a VIN. What must not happen is the *sweep* asking it a third time, so
    // the window between the sweep's first and last option is what is read.
    const sweepFrom = sent.indexOf("1A 80");
    const sweepTo = sent.indexOf("0101");
    const duringSweep = sent.slice(sweepFrom, sweepTo === -1 ? undefined : sweepTo);
    check(
      "cascade: the sweep does not re-ask the option a dialect already asked",
      sweepFrom !== -1 && !duringSweep.includes("1A 90"),
      sent.join(","),
    );
  }

  // ---------- the identification sweep ----------
  // The car of 2026-09-17, byte for byte: KWP2000 fast init, `0902` refused
  // with `7F 09 12`, and `1A 90` answering with exactly one frame — `5A 90`
  // plus the five characters `B3338`, padded to the end of that frame with
  // `FF 00`. A KWP2000 frame carries seven data bytes, so five characters is
  // the whole of what that option holds. Five is not a VIN and no world
  // manufacturer code begins with `B3`, so the car sits on the dashboard as
  // "Unknown" while whatever else it knows waits under the neighbouring
  // identification options.

  // The connect does not run the sweep on its own any more — the 16:52 car of
  // 2026-09-17 answered none of eighteen options and then scanned nothing at
  // all, and reading codes is what this app is for (see `ID_SWEEP_AT_CONNECT`
  // in mode09.ts). Both halves of that decision are tested, because both can
  // regress: a sweep that never fires, and a connect that fires one behind
  // the driver's back.
  {
    const toHex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
    const answering = (option: string, chunk: string) =>
      `5A ${option} ${[...chunk].map((c) => toHex(c.charCodeAt(0))).join(" ")}`;
    const FULL = "WVWZZZ1JZXW000001";

    // Driven by hand, because nothing else calls it now.
    {
      const { ch, sent } = tableChannel({
        ATDPN: "A5\r>",
        "1A 8F": `${answering("8F", FULL)}\r>`,
      });
      const reads: Coverage[] = [];
      const sweep = await sweepIdentificationBlock(ch, reads, [], 700, 0x90);

      check(
        "sweep: a one-frame VIN sends the sweep looking, and the whole one wins",
        sweep.vin === FULL && sweep.vinFrom === "1A 8F",
        `${sweep.vin ?? "null"} from ${sweep.vinFrom ?? "null"}`,
      );
      check(
        "sweep: the option that answered keeps its own words",
        reads.find((r) => r.request === "1A 8F")?.raw?.[0] ===
          answering("8F", FULL),
        JSON.stringify(reads.map((r) => [r.request, r.raw])),
      );
      // The one that answered is a row. Everything else the sweep asked was
      // refused, and thirty rows of "not supported" would push it off the
      // screen — the sweep's reads go to the scratch list for that reason.
      check(
        "sweep: options that refused are not rows on the screen",
        JSON.stringify(reads.map((r) => r.request)) ===
          JSON.stringify(["1A 8F"]),
        JSON.stringify(reads.map((r) => r.request)),
      );
      check(
        "sweep: an option already asked is not asked twice",
        !sent.includes("1A 90"),
        sent.join(","),
      );
    }

    // The stop condition on its own: the very first option answers with a
    // whole VIN, and nothing after it is asked. Seventeen characters are the
    // VIN; the rest of the block is somebody else's business.
    {
      const { ch, sent } = tableChannel({
        ATDPN: "A5\r>",
        "1A 80": `${answering("80", FULL)}\r>`,
      });
      const sweep = await sweepIdentificationBlock(ch, [], [], 700, null);
      check(
        "sweep: the first whole VIN ends it — the options after it are not asked",
        sweep.vin === FULL && sweep.vinFrom === "1A 80" && !sent.includes("1A 81"),
        `${sweep.vin ?? "null"} from ${sweep.vinFrom ?? "null"}: ${sent.join(",")}`,
      );
    }

    // …and the other half of the decision, through the whole connect: asked
    // for, the sweep runs and a whole VIN beats the fragment that sent it
    // looking. This is the read the scan makes once the codes are in hand.
    {
      const { ch } = tableChannel({
        ...HEALTHY,
        ATDPN: "A5\r>",
        "0902": "7F 09 12\r>",
        "1A 90": "5A 90 42 33 33 33 38 FF 00\r>",
        "1A 8F": `${answering("8F", FULL)}\r>`,
      });
      const info = await readVehicleInfoOver(ch, undefined, {
        sweepIdentification: true,
      });
      check(
        "sweep: asked for, it runs and the whole VIN wins over the fragment",
        info.vin === FULL &&
          info.vinFrom === "1A 8F" &&
          info.reads?.find((r) => r.request === "1A 80-9F")?.status === "ok",
        `${info.vin ?? "null"} from ${info.vinFrom ?? "null"}; reads ${JSON.stringify(info.reads?.map((r) => r.request))}`,
      );
    }
  }

  // ---------- reading the same question more than once ----------
  // One KWP2000 frame is seven data bytes and `5A 90` spends one of them, so a
  // VIN that lives under `1A 90` cannot arrive in a single frame. Whether the
  // five characters the measured car returns are the whole of what that
  // identifier holds or the first frame of something longer is not a fact
  // about those five bytes — it is a fact about the *next* answer, which is
  // why there is a next answer at all.

  {
    const same = stitchFragments(["B3338", "B3338", "B3338"]);
    check(
      "stitch: an ECU that repeats itself is not being cut short",
      same.vin === "B3338" && same.stable === true,
      JSON.stringify(same),
    );

    const grew = stitchFragments(["WVWZZZ", "WVWZZZ1JZ", "WVWZZZ1JZXW000001"]);
    check(
      "stitch: answers that keep growing are frames arriving one at a time",
      grew.vin === "WVWZZZ1JZXW000001" && grew.stable === false,
      JSON.stringify(grew),
    );

    const prefix = stitchFragments(["WVWZZZ1JZXW000001", "WVWZZZ"]);
    check(
      "stitch: a later short answer does not shorten a whole one",
      prefix.vin === "WVWZZZ1JZXW000001" && prefix.stable === true,
      JSON.stringify(prefix),
    );

    // Two answers that agree on nothing — a bus with two modules talking over
    // each other. Not stable, and the longer one is kept: it is the one that
    // might still be a VIN's worth of characters.
    const diverged = stitchFragments(["WVWZZZ", "1JZXW00"]);
    check(
      "stitch: answers that contradict each other are not called stable",
      diverged.vin === "1JZXW00" && diverged.stable === false,
      JSON.stringify(diverged),
    );

    check(
      "stitch: nothing read is not a result",
      stitchFragments([]).vin === "" && stitchFragments([""]).vin === "",
      JSON.stringify(stitchFragments([""])),
    );
  }

  {
    // The identification block's second shape: the VIN is not under one option
    // but spread across consecutive ones, each holding what fits in a frame.
    const split = stitchAdjacentOptions([
      { option: 0x90, text: "WVWZZZ1JZ" },
      { option: 0x91, text: "XW000001" },
    ]);
    check(
      "stitch: a VIN split across consecutive options is put back together",
      split?.vin === "WVWZZZ1JZXW000001" && split.from === "1A 90-91",
      JSON.stringify(split),
    );

    // A gap is not a join. Options 0x90 and 0x92 are not neighbours, and the
    // characters between them are unknown — concatenating them would invent a
    // VIN out of two unrelated fields.
    check(
      "stitch: options that are not neighbours are not joined",
      stitchAdjacentOptions([
        { option: 0x90, text: "WVWZZZ1JZ" },
        { option: 0x92, text: "XW000001" },
      ]) === null,
      "joined across a gap",
    );

    // Order of arrival is whatever the sweep produced; the block's own order
    // is what counts.
    const unsorted = stitchAdjacentOptions([
      { option: 0x91, text: "XW000001" },
      { option: 0x90, text: "WVWZZZ1JZ" },
    ]);
    check(
      "stitch: the options are joined in the block's order, not the reply's",
      unsorted?.vin === "WVWZZZ1JZXW000001",
      JSON.stringify(unsorted),
    );

    check(
      "stitch: an option holding a whole VIN needs no joining",
      stitchAdjacentOptions([{ option: 0x8F, text: "WVWZZZ1JZXW000001" }])?.from ===
        "1A 8F",
      JSON.stringify(stitchAdjacentOptions([{ option: 0x8f, text: "WVWZZZ1JZXW000001" }])),
    );

    check(
      "stitch: characters that do not add up to a VIN are not a VIN",
      stitchAdjacentOptions([
        { option: 0x90, text: "B3338" },
        { option: 0x91, text: "FF" },
      ]) === null,
      "a short pair became a VIN",
    );
  }

  // The question the functional request cannot ask: *which* module holds the
  // VIN. The measured car has two controllers (`0x12` and `0x18`), and a
  // functional `1A 90` is heard by both at once, so their frames interleave
  // into one reply the parser can only read runs out of.
  {
    const MODULE_VIN = "WVWZZZ1JZXW000001";
    const toHex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
    const answered = (option: string, text: string) =>
      `5A ${option} ${[...text].map((c) => toHex(c.charCodeAt(0))).join(" ")}`;

    const sent: string[] = [];
    let header = "81 F1 F1"; // what the adapter is set to before the read
    const ch = new Elm327Channel((raw) => {
      const cmd = raw.replace(/\r$/, "").trim().toUpperCase();
      sent.push(cmd);
      const set = /^AT SH (.*)$/.exec(cmd);
      if (set) {
        header = set[1];
        setTimeout(() => feedReply(ch, "OK\r>"), 0);
        return;
      }
      let reply = "NO DATA\r>";
      if (cmd === "ATDPN") reply = "A5\r>";
      else if (cmd === "0902") reply = "7F 09 12\r>"; // pre-2002: mode 09 refused
      else if (cmd === "1A 90") {
        // Broadcast, both controllers answer at once and only a frame's worth
        // survives. Addressed to 0x12, the same question arrives whole.
        reply =
          header === "80 12 F1"
            ? `${answered("90", MODULE_VIN)}\r>`
            : `${answered("90", "B3338")}\r>`;
      }
      setTimeout(() => feedReply(ch, reply), 0);
    });

    const info = await readVehicleInfoOver(ch, undefined, {
      moduleAddresses: [0x12, 0x18],
    });
    check(
      "modules: a scan's addresses turn the broadcast VIN read into one question per module",
      sent.includes("AT SH 80 12 F1"),
      sent.join(","),
    );
    check(
      "modules: the addressed module's VIN beats the interleaved fragment",
      info.vin === MODULE_VIN && info.vinFrom === "1A 90 @0x12",
      `${info.vin ?? "null"} from ${info.vinFrom ?? "null"}`,
    );
    // The loop stops the moment a module hands over a whole VIN: `0x18` is a
    // second module to wake up for a question that has already been answered.
    check(
      "modules: the second module is not asked once the first has the VIN",
      !sent.includes("AT SH 80 18 F1"),
      sent.join(","),
    );
    check(
      "modules: the adapter is left on the functional header a scan needs",
      sent.lastIndexOf("AT SH 81 F1 F1") > sent.lastIndexOf("AT SH 80 12 F1"),
      sent.join(","),
    );
  }

  {
    // A CAN car, with modules the scan has named: the header above is ISO
    // 14230's three-byte one, and a CAN bus is not addressed that way. Asking
    // nothing is the answer — the `22 F1 90` dialect above already covers it.
    // (`HEALTHY` answers `ATDPN` with `A6`.)
    const { ch, sent } = tableChannel({ ...HEALTHY, "1A 90": "5A 90 42 33 33 33 38 FF 00\r>" });
    await readVehicleInfoOver(ch, undefined, { moduleAddresses: [0x12] });
    check(
      "modules: a CAN car is not asked with a KWP2000 header",
      !sent.some((cmd) => cmd.startsWith("AT SH 80")),
      sent.join(","),
    );
  }

  {
    // No scan has run, so no module has been named — and nothing is guessed.
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "1A 90": "5A 90 42 33 33 33 38 FF 00\r>",
    });
    await readVehicleInfoOver(ch);
    check(
      "modules: with no scan behind it, no module is addressed",
      !sent.some((cmd) => cmd.startsWith("AT SH 80")),
      sent.join(","),
    );
  }

  // The other half, through the whole connect rather than by reading the
  // constant: this is the car the sweep was written for — one frame of VIN and
  // nothing else — and a connect that swept would sweep here. `1A 90` itself
  // does not count as a sweep: the VIN fallback asks it, and the sweep once
  // skipped it for that reason.
  {
    const { ch, sent } = tableChannel({
      ...HEALTHY,
      ATDPN: "A5\r>",
      "0902": "7F 09 12\r>",
      "1A 90": "5A 90 42 33 33 33 38 FF 00\r>",
    });
    const info = await readVehicleInfoOver(ch);
    const swept = sent.filter(
      (cmd) => /^1A (8[0-9A-F]|9[0-9A-F])$/.test(cmd) && cmd !== "1A 90",
    );
    check(
      "connect: the identification block is not swept behind the driver's back",
      swept.length === 0 &&
        !info.reads?.some((r) => r.request === "1A 80-9F"),
      `${swept.join(",") || "nothing asked"}; reads ${JSON.stringify(info.reads?.map((r) => r.request))}`,
    );
    // The sweep is off at connect, not gone: a car that gave five characters
    // still gives five characters, and the report still labels it as a
    // fragment. The sweep's own caller — the scan's re-identification — is
    // exercised above, with the option set.
    check(
      "connect: with the sweep off, the fragment is still the answer",
      info.vin === "B3338" && info.vinFrom === "1A 90",
      `${info.vin ?? "null"} from ${info.vinFrom ?? "null"}`,
    );
  }

  // ---------- what the connect-time reads recorded ----------
  // The vehicle screen shows four dashes whether the ECU answered NO DATA, the
  // adapter refused, or nothing came back at all — and the scan's report says
  // nothing about the connect path, so a car whose scan reads fine and
  // identifies not at all leaves no evidence anywhere. These are the checks
  // that the evidence now exists.

  {
    const { ch } = tableChannel({ ...HEALTHY, "0902": "NO DATA\r>" });
    const info = await readVehicleInfoOver(ch);
    const vinRead = info.reads?.find((r) => r.request === "0902");
    check(
      "connect: a read the ECU does not support is recorded as unsupported",
      vinRead?.status === "unsupported" &&
        vinRead.detail === "the ECU answered NO DATA",
      JSON.stringify(vinRead),
    );
    // Every read is recorded, once, in the order it was sent — a missing or
    // duplicated entry would make the list a decoration rather than a record
    // of what the adapter was actually asked.
    //
    // This car is CAN (`A6`) and refused the standard VIN read, so the one
    // VIN request in the list is the UDS dialect: the KWP2000 ones would be
    // noise on this bus. That the position is the VIN's and not an extra row
    // at the end is the point — the cascade asks where the read used to be.
    check(
      "connect: every read is recorded, once, in the order it was sent",
      info.reads?.map((r) => r.request).join(",") ===
        "ATDPN,ATST 64,0902,22 F1 90,0904,090A,01A6",
      JSON.stringify(info.reads?.map((r) => r.request)),
    );
  }

  {
    // Every read times out. The adapter is alive enough to be written to and
    // says nothing back — the failure this whole evidence trail exists for.
    const sent: string[] = [];
    const ch = new Elm327Channel((raw) => {
      sent.push(raw.replace(/\r$/, "").trim().toUpperCase());
    });
    const info = await readVehicleInfoOver(ch, 5);
    check(
      "connect: silence is recorded per read, not as one blank vehicle",
      // Eight, not six: an adapter that never named the protocol leaves every
      // KWP2000 dialect eligible, and they are asked like everything else —
      // `0902`, `1A 90` and `21 81` where there used to be two. A silent bus
      // is what that costs, and the bus is silent either way. The eighth line
      // is the timing knob: a silent adapter does not answer `ATAT`/`ATST`
      // either, and that line is an error like the rest — filing it under
      // "the adapter does not implement ATST" would name a missing feature
      // on a dongle whose only problem is that it is not talking.
      info.reads?.length === 8 &&
        info.reads.every((r) => r.status === "error" && /timeout/i.test(r.detail ?? "")),
      JSON.stringify(info.reads),
    );
    check(
      "connect: a silent adapter still yields a full vehicle object",
      info.vin === null && info.calid.length === 0 && info.protocol === null,
      JSON.stringify(info),
    );
  }

  // ---------- what a read that produced nothing actually says ----------
  // The four ways a read can come back empty have four different fixes, so
  // they have to be four different sentences. The one that matters most is
  // the last: bytes arrived, the app did not understand them. Calling that
  // "no readable reply" blames the adapter for the app's own gap, and it
  // reads identically to a channel that was never answered — which sends the
  // next person to look at the adapter instead of at the parser.

  {
    const silent = emptyDetail(["OK", ">"], {});
    check(
      "reply: an answer of nothing but OK is no readable reply",
      silent.status === "error" && silent.detail === "no readable reply",
      JSON.stringify(silent),
    );

    const noData = emptyDetail(["NO DATA"], {});
    check(
      "reply: NO DATA is unsupported, not an error",
      noData.status === "unsupported" && noData.detail === "the ECU answered NO DATA",
      JSON.stringify(noData),
    );

    const refused = emptyDetail(["UNABLE TO CONNECT"], {});
    check(
      "reply: the adapter's own refusal is quoted back",
      refused.status === "error" && refused.detail === "the adapter answered UNABLE TO CONNECT",
      JSON.stringify(refused),
    );

    const garbled = emptyDetail(["7E8 06 49 02 01 57 56 57 5A 5A 5A 31 4A"], {});
    check(
      "reply: bytes the app cannot parse are quoted, not called silence",
      garbled.status === "error" &&
        garbled.detail.includes("none of it was recognised") &&
        garbled.detail.includes("7E8 06 49 02 01"),
      JSON.stringify(garbled),
    );

    // A reply is quoted into one line of a report, so the quote is capped and
    // the reader can see that it was cut rather than wonder where it went.
    const long = emptyDetail([Array.from({ length: 90 }, () => "41").join(" ")], {});
    check(
      "reply: a quoted reply is truncated, not pasted whole",
      (long.detail ?? "").length <= 180 && (long.detail ?? "").endsWith("…"),
      String((long.detail ?? "").length),
    );
  }

  // ---------- one bad moment must not cost the whole pass ----------
  // A read that comes back with nothing is not a fact about the car; it is
  // what one bad moment on a noisy bus looks like. Repeating that question
  // costs one command, and not repeating it costs the whole stage — the codes
  // it would have returned are simply never seen. The repeat is spent once per
  // pass and never on a stage that answered: `NO DATA` and a refusal are the
  // car and the adapter speaking, and asking again cannot change either.

  {
    const { ch, sent } = silentOnceChannel(HEALTHY, { "03": 1 });
    const report = await readDiagnosticsOver(ch, FAST);
    check(
      "retry: a stage that timed out is asked again",
      sent.filter((cmd) => cmd === "03").length === 2,
      sent.join(" "),
    );
    check(
      "retry: the second answer is the one recorded",
      coverageOf(report, "03")?.status === "ok" &&
        report.faults.filter((f) => f.status === "stored").length === 3,
      `${JSON.stringify(coverageOf(report, "03"))} — ${report.faults.length} faults`,
    );
  }

  {
    const { ch, sent } = silentOnceChannel({ ...HEALTHY, "07": "NO DATA\r>" }, {});
    const report = await readDiagnosticsOver(ch, FAST);
    check(
      "retry: NO DATA is an answer, so it is not asked twice",
      sent.filter((cmd) => cmd === "07").length === 1 &&
        coverageOf(report, "07")?.status === "unsupported",
      `${sent.filter((cmd) => cmd === "07").length} sends, ${JSON.stringify(coverageOf(report, "07"))}`,
    );
  }

  {
    // One command for the whole pass. Five stages that each repeat themselves
    // would double the worst case on a car with the ignition off, and after
    // the channel's drain the second silence means the same thing as the
    // first: nobody is there.
    const { ch, sent } = silentOnceChannel(HEALTHY, { "03": 1, "07": Infinity });
    const report = await readDiagnosticsOver(ch, FAST);
    check(
      "retry: one repeat for the whole pass, not one per stage",
      sent.filter((cmd) => cmd === "03").length === 2 &&
        sent.filter((cmd) => cmd === "07").length === 1 &&
        coverageOf(report, "07")?.status === "error",
      `${sent.filter((cmd) => cmd === "03").length}×03 ${sent.filter((cmd) => cmd === "07").length}×07`,
    );
  }

  // ---------- an ECU that refuses ATH1 ----------

  {
    const { ch } = tableChannel({
      ...HEALTHY,
      ATH1: "?\r>",
      // With headers refused, the adapter prints no address — and two
      // modules' lists arrive merged.
      "03": "43 02 03 00 04 20\r43 01 07 01\r>",
      "07": "47 00\r>",
      "0A": "NO DATA\r>",
    });
    const report = await readDiagnosticsOver(ch, FAST);

    check("headers refused: reported as off", report.headersOn === false);
    check(
      "headers refused: the codes still decode",
      report.faults.map((f) => f.code).join(",") === "P0300,P0420,P0701",
      report.faults.map((f) => f.code).join(","),
    );
    check(
      "headers refused: attribution is absent rather than invented",
      report.faults.every((f) => f.module === null && f.moduleId === null),
    );
    check(
      "headers refused: `47 00` is an empty list, not a failure",
      coverageOf(report, "07")?.status === "empty",
      JSON.stringify(coverageOf(report, "07")),
    );
    check(
      "headers refused: NO DATA is unsupported, not empty",
      coverageOf(report, "0A")?.status === "unsupported",
      JSON.stringify(coverageOf(report, "0A")),
    );
  }

  // ---------- the ECU's own count disagrees with mode 03 ----------

  {
    const { ch } = tableChannel({
      ...HEALTHY,
      "03": "7E8 06 43 02 03 00 04 20\r>", // two codes, not three
    });
    const report = await readDiagnosticsOver(ch, FAST);
    check(
      "reconciliation: a short mode 03 list is reported, not smoothed over",
      report.notes.some((n) => n.includes("3 stored code") && n.includes("2 came back")),
      report.notes.join(" | "),
    );
  }

  // ---------- nothing works ----------

  {
    // Every command answers NO DATA: an OBD-II car whose ECUs say nothing.
    const { ch } = tableChannel({}, "NO DATA\r>");
    const report = await readDiagnosticsOver(ch, FAST);
    check(
      "silent ECU: resolves with nothing, throws nothing",
      report.faults.length === 0 &&
        report.mileage === null &&
        report.status === null,
    );
    check(
      "silent ECU: every stage says unsupported, none says ok",
      report.coverage.length === 5 &&
        report.coverage.every((c) => c.status === "unsupported"),
      report.coverage.map((c) => `${c.request}:${c.status}`).join(" "),
    );
  }

  {
    // The adapter's own writes fail — a dead link, not a silent car.
    const ch = new Elm327Channel(() => {
      throw new Error("BLE write failed");
    });
    let report: DiagnosticReport | null = null;
    try {
      report = await readDiagnosticsOver(ch, FAST);
    } catch (err) {
      check("dead adapter: pass does not reject", false, String(err));
    }
    check(
      "dead adapter: every stage reports the write error",
      report !== null &&
        report.coverage.length === 5 &&
        report.coverage.every((c) => c.status === "error"),
      report?.coverage.map((c) => `${c.request}:${c.status}`).join(" ") ?? "null",
    );
    // The failed write must not wedge the channel. Without the guard in
    // at.ts the in-flight slot stays occupied, and this second command is
    // refused as "already in flight" — which reads as a dead adapter long
    // after the link recovered.
    let second: string | null = null;
    try {
      await ch.command("ATI", 100);
    } catch (err) {
      second = err instanceof Error ? err.message : String(err);
    }
    check(
      "dead adapter: the channel is not left wedged",
      second === "BLE write failed",
      String(second),
    );
  }

  // ---------- the deadline ----------

  {
    const { ch } = tableChannel(HEALTHY);
    const report = await readDiagnosticsOver(ch, { ...FAST, deadlineMs: 0 });
    check(
      "deadline: stages past the budget are skipped, not faked",
      report.coverage.length === 5 &&
        report.coverage.every((c) => c.status === "skipped"),
      report.coverage.map((c) => `${c.request}:${c.status}`).join(" "),
    );
  }

  {
    const { ch } = tableChannel(HEALTHY);
    const report = await readDiagnosticsOver(ch, {
      ...FAST,
      faultsOnly: true,
    });
    check(
      "faultsOnly: the two optional reads are not requested",
      report.coverage.length === 3 && report.mileage === null && report.status === null,
      report.coverage.map((c) => c.request).join(" "),
    );
  }

  // ---------- what the bytes alone say about a code ----------

  check(
    "structure: an SAE code names its subsystem",
    describeDtcStructurally("P0300").subsystem === "Ignition system or misfire" &&
      describeDtcStructurally("P0300").generic === true,
    JSON.stringify(describeDtcStructurally("P0300")),
  );
  check(
    "structure: a manufacturer code is not decoded as an SAE one",
    describeDtcStructurally("P1234").generic === false &&
      describeDtcStructurally("P1234").summary.includes("manufacturer"),
    describeDtcStructurally("P1234").summary,
  );
  check(
    "structure: a chassis code has no subsystem table, only a system",
    describeDtcStructurally("C0300").system === "C" &&
      describeDtcStructurally("C0300").subsystem === null,
  );
  check(
    "structure: an unknown code still yields a usable title",
    describeDtcStructurally("B1318").systemName === "Body",
  );

  check(
    "group: derived from the code's own bytes",
    groupForDtc("P0740") === "transmission" &&
      groupForDtc("P0420") === "emissions" &&
      groupForDtc("P0300") === "engine" &&
      groupForDtc("C1201") === "brakes" &&
      groupForDtc("B1318") === "body" &&
      groupForDtc("U0100") === "electrical",
    ["P0740", "P0420", "P0300", "C1201", "B1318", "U0100"]
      .map(groupForDtc)
      .join(","),
  );
  check(
    "severity: structural, and honest about being an estimate",
    estimateSeverity("U0100") === "high" &&
      estimateSeverity("C1201") === "high" &&
      estimateSeverity("P0300") === "high" &&
      estimateSeverity("P0171") === "medium" &&
      estimateSeverity("B1318") === "low",
    ["U0100", "C1201", "P0300", "P0171", "B1318"].map(estimateSeverity).join(","),
  );

  // ---------- the bundled dictionary ----------
  // Hand-written tables rot: a typo in a code string is invisible on review
  // and only surfaces on a car that reports that exact code. Everything a
  // machine can check about the table is checked here.

  {
    const codes = Object.keys(DTC_DICTIONARY);
    const severities = new Set<FaultSeverity>(["low", "medium", "high"]);

    check(
      "dictionary: holds a useful number of codes",
      codes.length >= 120,
      `${codes.length} codes`,
    );

    const badShape = codes.filter((code) => {
      const pair = encodeDtc(code);
      return !pair || decodeDtcPair(pair[0], pair[1]) !== code;
    });
    check(
      "dictionary: every key round-trips through the byte encoding",
      badShape.length === 0,
      badShape.slice(0, 5).join(","),
    );

    const entries = codes.map((c) => [c, DTC_DICTIONARY[c]] as const);
    const badSeverity = entries.filter(([, e]) => !severities.has(e.severity)).map(([c]) => c);
    const badText = entries
      .filter(([, e]) => !e.title.trim() || !e.description.trim() || e.description.length > 160)
      .map(([c]) => c);
    const badCauses = entries.filter(([, e]) => (e.causes?.length ?? 0) > 3).map(([c]) => c);

    check("dictionary: every severity is real", badSeverity.length === 0, badSeverity.slice(0, 5).join(","));
    check("dictionary: every entry has a title and a short description", badText.length === 0, badText.slice(0, 5).join(","));
    check("dictionary: causes are capped at three", badCauses.length === 0, badCauses.slice(0, 5).join(","));

    // The codes a first reading is most likely to hit. If the table misses
    // these it misses the point.
    const mustHave = ["P0300", "P0301", "P0171", "P0420", "P0442", "P0455", "P0401", "U0100", "P0700"];
    const missing = mustHave.filter((c) => !DTC_DICTIONARY[c]);
    check("dictionary: covers the common codes", missing.length === 0, missing.join(","));

    const withCauses = entries.filter(([, e]) => (e.causes?.length ?? 0) > 0);
    check(
      "dictionary: causes stay selective rather than on every code",
      withCauses.length > 0 && withCauses.length < codes.length / 2,
      `${withCauses.length}/${codes.length}`,
    );
  }

  // ---------- toFault: dictionary first, structure after ----------

  {
    const stored = toFault("p0300", "stored", 0x7e8);
    check(
      "toFault: the dictionary supplies the title",
      stored.title === DTC_DICTIONARY.P0300.title && stored.known === true,
      stored.title,
    );
    check(
      "toFault: the code is normalised to upper case",
      stored.code === "P0300",
      stored.code,
    );
    check(
      "toFault: module label comes from the CAN id",
      stored.module === "Engine" && stored.moduleId === 0x7e8,
      String(stored.module),
    );
    check(
      "toFault: causes are copied, not handed out by reference",
      Array.isArray(stored.causes) && stored.causes !== DTC_DICTIONARY.P0300.causes,
    );
    // Group stays structural even where the dictionary has an entry: the
    // rule is right for codes the table will never hold.
    check(
      "toFault: group comes from the structural rule, not the table",
      stored.group === groupForDtc("P0300"),
      stored.group,
    );

    const unknown = toFault("P1234", "pending", null);
    check(
      "toFault: an unknown code falls back and says so",
      unknown.known === false &&
        unknown.title === describeDtcStructurally("P1234").subsystem &&
        unknown.description.includes("not in the bundled dictionary") &&
        unknown.causes === undefined,
      unknown.title,
    );
    check(
      "toFault: an unknown code still carries status and an estimated severity",
      unknown.status === "pending" && unknown.severity === estimateSeverity("P1234"),
      `${unknown.status}/${unknown.severity}`,
    );
    check(
      "toFault: no module id means no module label",
      unknown.moduleId === null && unknown.module === null,
      String(unknown.module),
    );
  }

  // ---------- the progress contract the scan screen is built on ----------
  // The bar is painted from these numbers, so a pass that dropped a stage
  // would leave it short without ever saying so. Emitted before each read —
  // the bar must never claim work that has not happened yet.

  {
    const { ch } = tableChannel(HEALTHY);
    const seen: { stage: string; index: number; total: number }[] = [];
    const report = await readDiagnosticsOver(ch, {
      ...FAST,
      onProgress: (p) => seen.push({ ...p }),
    });

    check(
      "progress: five stages, numbered from zero",
      seen.length === 5 && seen.every((p, i) => p.index === i && p.total === 5),
      seen.map((p) => `${p.index + 1}/${p.total}`).join(" "),
    );
    check(
      "progress: every stage is labelled",
      seen.every((p) => p.stage.trim().length > 0),
      seen.map((p) => p.stage).join(" | "),
    );
    check(
      "progress: one line of coverage per stage, so nothing is skipped quietly",
      report.coverage.length === seen.length,
      `${report.coverage.length} vs ${seen.length}`,
    );
  }

  // A codes-only pass deliberately drops the two mode 01 stages — the screen
  // shows a shorter bar rather than a stalled one.
  {
    const { ch } = tableChannel(HEALTHY);
    const seen: number[] = [];
    await readDiagnosticsOver(ch, {
      ...FAST,
      faultsOnly: true,
      onProgress: (p) => seen.push(p.total),
    });
    check("progress: faultsOnly drops the mode 01 stages", seen.every((t) => t === 3), seen.join(","));
  }

  // ---------- the measured car, end to end ----------
  // The only real dump this app has ever seen, driven through the whole pass.
  // Two modules answer every request; the lamp belongs to the one the app used
  // to ignore, and its mode 03 reply carries exactly the two codes its own
  // PID 01 announced. Every frame below is a byte-for-byte capture, checksum
  // included.

  {
    const KWP2000: Record<string, string> = {
      ATAL: "OK\r>",
      ATDPN: "A5\r>",
      ATH1: "OK\r>",
      ATH0: "OK\r>",
      // Frames are separated by `\r` and the prompt stands alone at the end —
      // a `>` written between them glues onto the next frame's first token
      // and the header with it.
      "03": "87 F1 18 43 00 00 00 00 00 00 D3\r87 F1 12 43 04 01 12 46 00 00 2A\r>",
      "07": "82 F1 12 47 00 CC\r>",
      "0A": "83 F1 18 7F 0A 11 26\r>",
      "0101": "86 F1 18 41 01 00 04 00 00 D5\r86 F1 12 41 01 82 46 80 00 13\r>",
      "01A6": "83 F1 12 7F 01 12 18\r>",
    };
    const { ch } = tableChannel(KWP2000);
    const report = await readDiagnosticsOver(ch, FAST);

    check(
      "measured: the lamp that was lit is reported lit",
      report.status?.milOn === true && report.status?.dtcCount === 2,
      JSON.stringify(report.status),
    );
    check(
      "measured: the coverage line names both answering modules",
      coverageOf(report, "0101")?.detail?.includes("ECU 18") === true &&
        coverageOf(report, "0101")?.detail?.includes("ECU 12") === true,
      coverageOf(report, "0101")?.detail,
    );
    check(
      "measured: both stored codes come back, attributed",
      report.faults.map((f) => `${f.code}/${f.module}/${f.status}`).join(",") ===
        "P0401/ECU 12/stored,P1246/ECU 12/stored",
      report.faults.map((f) => `${f.code}/${f.module}/${f.status}`).join(","),
    );
    // Two codes announced, two read, and the report must be silent about it.
    // Both notes that would appear here are warnings — "the list is cut
    // short" and "the count does not match" — and a clean bill of health is
    // only honest when neither is raised on a car that has neither fault.
    check(
      "measured: a complete list raises neither the short-list nor the count note",
      !report.notes.some((n) => n.includes("cut short")) &&
        !report.notes.some((n) => n.includes("came back from mode 03")),
      report.notes.join(" | "),
    );
    check(
      "measured: a refused mode is unsupported, not a failed read",
      coverageOf(report, "0A")?.status === "unsupported" &&
        coverageOf(report, "07")?.status === "empty",
      `${coverageOf(report, "0A")?.status} / ${coverageOf(report, "07")?.status}`,
    );
    check(
      "measured: a refused odometer is unsupported and says why",
      coverageOf(report, "01A6")?.status === "unsupported" &&
        coverageOf(report, "01A6")?.detail?.includes("2019") === true,
      coverageOf(report, "01A6")?.detail,
    );

    // The report that goes to the chat: the lamp, the car, and one line per
    // fault — which is what was asked for and what the bot did not do.
    const text = reportText({ ...VW, make: "Hyundai", model: "Tucson" }, report);
    const faultLines = text.split("\n").filter((l) => l.startsWith("• "));
    check(
      "measured: the chat report names the car and the lamp",
      text.includes("Hyundai Tucson") && text.includes("Check engine light: ON"),
      text.split("\n").slice(0, 3).join(" | "),
    );
    check(
      "measured: each fault is exactly one line",
      faultLines.length === 2 &&
        faultLines[0]?.includes("P0401") === true &&
        faultLines[1]?.includes("P1246") === true,
      faultLines.join(" ⏎ "),
    );
    check(
      "measured: the unread odometer prints no mileage line",
      !text.includes("Mileage"),
      text.split("\n").slice(0, 4).join(" | "),
    );
    // P1246 is not in the bundled table, so its title is the category its own
    // bytes name — "Fuel and air metering (injector circuit)" — which reads
    // like a diagnosis on a line that has no room for the sentence the results
    // screen prints underneath. P0401 is in the table and must stay unmarked,
    // or the marker stops meaning anything.
    check(
      "measured: an undecoded code is marked, a decoded one is not",
      faultLines[0]?.includes("not decoded") === false &&
        faultLines[1]?.includes("not decoded") === true,
      faultLines.join(" ⏎ "),
    );
    // The five characters that came off `1A 90` went out as `🔑 VIN: B3338` —
    // a report stating a VIN the car never gave — while the dashboard printed
    // the same five as "Partial VIN · 5 of 17 characters". Both are now the
    // same claim in the same words.
    const partial = reportText({ ...VW, vin: "B3338" }, report);
    check(
      "measured: a fragment is reported as a partial VIN, never as a VIN",
      partial.includes("🔑 Partial VIN: B3338 (5 of 17 characters)") &&
        !partial.includes("🔑 VIN: B3338"),
      partial.split("\n").find((l) => l.includes("VIN")) ?? "no VIN line",
    );
    check(
      "measured: a whole VIN is still reported as one",
      text.includes("🔑 VIN: WVW1JZXWXJP000001") && !text.includes("Partial VIN"),
      text.split("\n").find((l) => l.includes("VIN")) ?? "no VIN line",
    );
  }

  // ---------- the Telegram message ----------
  // This text is the whole point of the app for the person receiving it, and
  // it is the one place where a fabricated "all clear" would be believed.

  {
    const { ch } = tableChannel(HEALTHY);
    const report = await readDiagnosticsOver(ch, FAST);
    const text = reportText(VW, report);

    check(
      "telegram: a real pass carries the car, the odometer and the codes",
      text.includes("Volkswagen") &&
        text.includes("178 464 km") &&
        text.includes("P0300") &&
        text.includes("P0701"),
      text.split("\n").slice(0, 4).join(" | "),
    );
    check(
      "telegram: the lamp and the code counts are stated",
      text.includes("Check engine light: ON") &&
        text.includes("5 fault(s) — 3 stored · 1 pending · 1 permanent"),
      text.split("\n").find((l) => l.includes("fault(s)")),
    );
    check(
      "telegram: pending is told apart from stored",
      text.includes("[pending · "),
      text.split("\n").find((l) => l.includes("P0701")),
    );
    check(
      "telegram: the message names the build that produced it",
      text.includes(`build ${BUILD_STAMP}`),
      text.split("\n").slice(-1)[0],
    );
    check(
      "telegram: what was and was not read is spelled out",
      text.includes("Read: 03 ✓"),
      text.split("\n").find((l) => l.startsWith("Read:")),
    );

    // The case that matters most: an ECU that answered nothing must not be
    // delivered to the chat as a clean car. The details vary because a real
    // all-failed pass does not fail one way — the adapter can refuse, hang,
    // or relay the ECU's own NO DATA — and the reader has to be able to tell
    // those apart, since each one means something different to do next.
    const silent: DiagnosticReport = {
      ...report,
      faults: [],
      mileage: null,
      status: null,
      notes: [],
      // The transcript of the case this was written for: the adapter answers
      // every AT command with OK and then has nothing at all to say about the
      // vehicle. Nothing here is a noise line, so no refusal is detected and
      // every read lands on the same "no readable reply".
      rawLines: ["OK", "OK", "OK"],
      coverage: report.coverage.map((c, i) => ({
        ...c,
        status: "unsupported" as const,
        detail:
          i === 0
            ? "the adapter answered UNABLE TO CONNECT"
            : i === 1
              ? 'ELM327: timeout waiting for "07"'
              : "the ECU answered NO DATA",
      })),
    };
    const silentText = reportText(VW, silent);
    check(
      "telegram: nothing read is never sent as a clean bill of health",
      silentText.includes("Nothing could be read") &&
        !silentText.includes("No fault codes"),
      silentText.split("\n")[4],
    );
    check(
      "telegram: an all-failed pass says why each read failed, not just that it did",
      silentText.includes("UNABLE TO CONNECT") &&
        silentText.includes('timeout waiting for "07"') &&
        silentText.includes("NO DATA"),
      silentText.split("\n").filter((l) => l.trimStart().startsWith("•")).join(" | "),
    );
    check(
      "telegram: an unread odometer prints no mileage line at all",
      !silentText.includes("Mileage"),
      silentText.split("\n").slice(1, 3).join(" | "),
    );

    // Connecting before the engine is running identifies nothing, and the
    // placeholder that comes back must not be dressed up as a reading.
    const blankText = reportText(unidentifiedVehicle(null, null), silent);
    check(
      "telegram: an unidentified car is not printed as “Unknown”",
      !blankText.includes("Unknown") && blankText.includes("Vehicle: not identified"),
      blankText.split("\n").slice(0, 3).join(" | "),
    );
    check(
      "telegram: an all-failed pass carries the adapter's own output",
      silentText.includes("Adapter output:") && silentText.includes("| OK"),
      silentText.split("\n").filter((l) => l.includes("| OK")).join(" | "),
    );
    // "The adapter sent nothing" and "the adapter sent bytes we could not
    // parse" print the same coverage detail and mean opposite things, so the
    // empty transcript has to be stated rather than shown as a blank block.
    const muteText = reportText(VW, { ...silent, rawLines: [] });
    check(
      "telegram: an empty transcript is stated, not left blank",
      muteText.includes("not a single data line came back"),
      muteText.split("\n").find((l) => l.includes("Adapter output")),
    );
    check(
      "telegram: an unread car is not blamed for the adapter's silence",
      blankText.includes("no VIN was read") &&
        !blankText.includes("the ECU returned no VIN"),
      blankText.split("\n").find((l) => l.includes("Vehicle:")),
    );

    // A healthy car that was actually read says so, and says how it knows.
    const clean = reportText(VW, { ...silent, coverage: report.coverage });
    check(
      "telegram: a healthy read car does say no codes",
      clean.includes("No fault codes reported"),
      clean.split("\n")[4],
    );
    check(
      "telegram: a pass that read something keeps the short roll call",
      !clean.includes("UNABLE TO CONNECT") &&
        !clean.includes("NO DATA") &&
        !clean.includes("Adapter output"),
      clean.split("\n").find((l) => l.includes("Read:")),
    );

    // Telegram caps at 4096 and rejects the whole message, so a long list has
    // to be trimmed rather than refused.
    const many = Array.from({ length: 25 }, (_, i) => ({
      code: `P${String(300 + i).padStart(4, "0")}`,
      group: "engine" as const,
      title: "Synthetic code for the budget check",
      description: "",
      severity: "medium" as const,
    }));
    const longText = reportText(VW, { ...report, faults: many });
    check(
      "telegram: 25 codes still fit the budget",
      longText.length <= 3500,
      `${longText.length} chars`,
    );
    check(
      "telegram: the trimmed list says how many codes it dropped",
      longText.includes("P0300") &&
        longText.includes("and 13 more") &&
        longText.includes("Read: 03 ✓"),
      longText.split("\n").slice(-4).join(" | "),
    );

    // A title is data off a car, and the body is parsed as HTML.
    const hostile = reportText(VW, {
      ...report,
      faults: [{ ...many[0], title: "a <b>bold</b> lie & more" }],
    });
    check(
      "telegram: code titles are HTML-escaped",
      hostile.includes("&lt;b&gt;") && !hostile.includes("<b>"),
      hostile.split("\n").find((l) => l.includes("bold")),
    );
  }

  // ---------- a bus the adapter cannot get onto ----------
  // The car of 2026-09-17 20:31 answered `BUS BUSY` to everything: the adapter
  // was alive and the ECU was not driving the line. Pinning a protocol asks
  // that adapter to speak a different dialect, which it cannot do while it
  // cannot transmit — the only step left is a reset of its own state, and the
  // cost of that reset is that everything the pass set up goes with it.
  {
    const VW_VIN = "WVWZZZ1JZXW000001";
    const VW_0902 =
      "49 02 01 57 56 57 5A 5A 5A 31 4A 5A 58 57 30 30 30 30 30 31\r>";
    /** The bus on the other side of a reset: it answers, and the adapter
     *  replies to `ATZ`/`ATE0` the way one that just came up does. */
    const RECOVERED: Record<string, string> = {
      ...HEALTHY,
      "0902": VW_0902,
      ATZ: "ELM327 v1.5\r>",
      ATE0: "OK\r>",
    };

    {
      let c: ReturnType<typeof mutableChannel>;
      c = mutableChannel({}, "BUS BUSY\r>", (cmd) => {
        if (cmd === "ATZ") c.set(RECOVERED, "NO DATA\r>");
      });
      const info = await readVehicleInfoOver(c.ch, undefined, {
        sweepIdentification: true,
      });
      const row = info.reads?.find((r) => r.request === "ATZ");
      check(
        "reset: `BUS BUSY` gets the adapter reset, not a pinned protocol",
        c.sent.includes("ATZ") &&
          !c.sent.includes("ATSP5") &&
          !c.sent.includes("ATSP3"),
        c.sent.join(","),
      );
      check(
        "reset: the pass after it is the one that counts",
        info.vin === VW_VIN && row?.status === "ok",
        `${info.vin ?? "null"}; ${row?.status ?? "no row"} — ${row?.detail ?? ""}`,
      );
      check(
        "reset: echo goes back off before anything is parsed",
        c.sent.indexOf("ATE0") > c.sent.indexOf("ATZ"),
        c.sent.join(","),
      );
    }

    // Nothing heard, but nobody blaming the bus: the dialect is still the
    // first question and the reset is the one after it.
    {
      let c: ReturnType<typeof mutableChannel>;
      c = mutableChannel({}, "UNABLE TO CONNECT\r>", (cmd) => {
        if (cmd === "ATZ") c.set(RECOVERED, "NO DATA\r>");
      });
      const info = await readVehicleInfoOver(c.ch, undefined, {
        sweepIdentification: true,
      });
      check(
        "recovery order: the protocol is pinned first, the adapter reset after",
        c.sent.includes("ATSP5") &&
          c.sent.includes("ATSP3") &&
          c.sent.indexOf("ATZ") > c.sent.indexOf("ATSP3"),
        c.sent.join(","),
      );
      check(
        "recovery order: the bus that came back after the reset is the one reported",
        info.vin === VW_VIN,
        String(info.vin),
      );
    }

    // …and the flag that decides whether any of this runs has to count what
    // the car said, not the commands the app wrote into `reads` itself. Both
    // pins are spent before the second one works; while an accepted command
    // counted as "heard", the loop stopped at `ATSP5` and the recovery it was
    // meant to start ended on its first step.
    {
      let c: ReturnType<typeof mutableChannel>;
      c = mutableChannel({}, "UNABLE TO CONNECT\r>", (cmd) => {
        if (cmd === "ATSP3") c.set(RECOVERED, "NO DATA\r>");
      });
      const info = await readVehicleInfoOver(c.ch, undefined, {
        sweepIdentification: true,
      });
      check(
        "recovery: a pin the adapter accepted is not the bus answering",
        c.sent.includes("ATSP3") && info.vin === VW_VIN,
        `${info.vin ?? "null"}: ${c.sent.join(",")}`,
      );
    }

    // A reset the adapter does not clear is the end of it: the line is held by
    // something `ATZ` cannot reach, and a retry pass would only spend another
    // minute saying so.
    {
      const c = mutableChannel({}, "BUS BUSY\r>");
      const info = await readVehicleInfoOver(c.ch, undefined, {
        sweepIdentification: true,
      });
      const row = info.reads?.find((r) => r.request === "ATZ");
      const passes = c.sent.filter((cmd) => cmd === "0902").length;
      check(
        "reset: a reset that did not clear the bus ends the recovery",
        row?.status === "error" && passes === 1,
        `${row?.status ?? "no row"} (${row?.detail ?? ""}); 0902 asked ${passes}×`,
      );
    }

    // The common case pays nothing: a car that answers never sees `ATZ`.
    {
      const c = tableChannel({ ...HEALTHY, "0902": VW_0902 });
      const info = await readVehicleInfoOver(c.ch, undefined, {
        sweepIdentification: true,
      });
      check(
        "reset: a bus that answers is never reset",
        !c.sent.includes("ATZ") && info.vin === VW_VIN,
        c.sent.join(","),
      );
    }

    // …and neither does the connect-time read, which is not allowed the long
    // recovery at all: two extra passes are exactly what a driver waiting on
    // the handshake cannot pay.
    {
      const c = tableChannel({}, "BUS BUSY\r>");
      await readVehicleInfoOver(c.ch);
      check(
        "reset: connect time does not reset the adapter either",
        !c.sent.includes("ATZ"),
        c.sent.join(","),
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll diagnostics checks passed.");
}

main();
