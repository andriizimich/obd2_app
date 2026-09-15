// Smoke test for the diagnostics readers (src/obd/mode01.ts and, from
// stage 1 on, frames.ts / dtc.ts / mode03.ts / diagnostics.ts).
// Run with: npx tsx scripts/obd-diag-smoke.ts
// No hardware needed — feeds fabricated response streams.

import { Elm327Channel } from "../src/obd/at";
import { decodeOdometer, decodeStatus, extractPidData, readOdometer } from "../src/obd/mode01";
import { readCompatibilityOver, readDiagnosticsOver } from "../src/obd/diagnostics";
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

  // ---------- the adapter compatibility check ----------

  {
    const { ch, sent } = tableChannel({
      ATI: "ELM327 v1.5\r>",
      ATDPN: "A6\r>",
      ATH1: "OK\r>",
      ATH0: "OK\r>",
      "0101": "41 01 83 07 65 04\r>",
      "01A6": "41 A6 00 1B 3B 40\r>",
      "03": "43 02 03 00 04 20\r>",
    });
    const lines = await readCompatibilityOver(ch, { timeoutMs: 150 });

    check(
      "compat: every command is asked, in order, headers off last",
      sent.join(",") === "ATI,ATDPN,ATH1,0101,01A6,03,ATH0",
      sent.join(","),
    );
    check(
      "compat: replies are kept verbatim, not parsed",
      lines.find((l) => l.command === "ATI")?.lines[0] === "ELM327 v1.5" &&
        lines.find((l) => l.command === "03")?.lines[0] === "43 02 03 00 04 20",
    );
    check(
      "compat: every step carries the question it asks",
      lines.length === 7 && lines.every((l) => l.label.length > 0),
      `${lines.length} steps`,
    );
  }

  {
    // An adapter that answers nothing: the check must still run to the end
    // and leave headers off, or the next scan inherits the wrong state.
    const { ch, sent } = tableChannel({});
    const lines = await readCompatibilityOver(ch, { timeoutMs: 60 });
    check(
      "compat: an unresponsive adapter still walks the whole list",
      sent.join(",") === "ATI,ATDPN,ATH1,0101,01A6,03,ATH0",
      sent.join(","),
    );
    check(
      "compat: a missing reply is shown as such, never as an empty success",
      lines.every((l) => l.lines.length > 0),
      JSON.stringify(lines[0]?.lines),
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
      text.includes("Check engine light ON") &&
        text.includes("5 fault(s) — 3 stored · 1 pending · 1 permanent"),
      text.split("\n").find((l) => l.includes("fault(s)")),
    );
    check(
      "telegram: pending is told apart from stored",
      text.includes("[pending]"),
      text.split("\n").find((l) => l.includes("P0701")),
    );
    check(
      "telegram: what was and was not read is spelled out",
      text.includes("Read: 03 ✓"),
      text.split("\n").find((l) => l.startsWith("Read:")),
    );

    // The case that matters most: an ECU that answered nothing must not be
    // delivered to the chat as a clean car.
    const silent: DiagnosticReport = {
      ...report,
      faults: [],
      mileage: null,
      status: null,
      notes: [],
      coverage: report.coverage.map((c) => ({ ...c, status: "unsupported" as const })),
    };
    const silentText = reportText(VW, silent);
    check(
      "telegram: nothing read is never sent as a clean bill of health",
      silentText.includes("Nothing could be read") &&
        !silentText.includes("No fault codes"),
      silentText.split("\n")[4],
    );
    check(
      "telegram: an unread odometer prints no mileage line at all",
      !silentText.includes("Mileage"),
      silentText.split("\n").slice(1, 3).join(" | "),
    );

    // A healthy car that was actually read says so, and says how it knows.
    const clean = reportText(VW, { ...silent, coverage: report.coverage });
    check(
      "telegram: a healthy read car does say no codes",
      clean.includes("No fault codes reported"),
      clean.split("\n")[4],
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

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll diagnostics checks passed.");
}

main();
