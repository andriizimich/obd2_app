// Smoke test for the frame layer and the DTC parsers — the riskiest pure
// logic in the diagnostic pass, because every assumption in it came from
// documentation rather than from a real adapter.
// Run with: npx tsx scripts/obd-frames-smoke.ts
// No hardware needed: every stream below is fabricated.

import {
  describeNegativeResponse,
  headerShapeFor,
  isNoiseLine,
  moduleLabel,
  negativeResponse,
  parseFrames,
  parseMessages,
  readLineFrame,
  saidNoData,
  stripLinePrefix,
} from "../src/obd/frames";
import { decodeDtcPair, encodeDtc } from "../src/obd/dtc";
import { parseDtcPayload, parseDtcReply } from "../src/obd/mode03";
import { parseStatus } from "../src/obd/mode01";
import { parseVinBlocks, parseVinReadings } from "../src/obd/mode09";
import { isVinChar } from "../src/utils/vin";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const codes = (lines: string[], mode: 0x03 | 0x07 | 0x0a = 0x03, opts = {}) =>
  parseDtcReply(lines, mode, opts)
    .flatMap((set) => set.codes)
    .join(",");

/** Bytes as two-digit hex, so an expectation reads like the adapter's line
 *  rather than like a list of decimals. */
const hex = (bytes: number[] | undefined) =>
  (bytes ?? []).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

function main() {
  // ---------- 1. the anchor scan: PCI byte present or absent ----------
  // Clone firmware disagrees about whether the ISO-TP PCI length byte is
  // printed. Both spellings of the same reply must decode identically —
  // this pair is the entire reason the parser anchors instead of slicing.

  check(
    "frames: bare payload decodes",
    codes(["43 02 03 00 04 20"]) === "P0300,P0420",
    codes(["43 02 03 00 04 20"]),
  );
  check(
    "frames: leading PCI byte is skipped, same result",
    codes(["06 43 02 03 00 04 20"]) === "P0300,P0420",
    codes(["06 43 02 03 00 04 20"]),
  );
  check(
    "frames: CAN header + PCI byte",
    codes(["7E8 06 43 02 03 00 04 20"], 0x03, { headers: true }) ===
      "P0300,P0420",
  );

  // ---------- 2. a long list is not truncated ----------
  // More than three codes do not fit in one CAN frame. A flat byte read
  // would stop at the third and never say so.

  const LONG = [
    "014", // bare frame counter some clones print — not a header
    "0: 43 08 03 00 03 01 03 02",
    "1: 03 03 04 20 01 71 04 55 07 40",
  ];
  check(
    "frames: multi-frame list with 0:/1: prefixes yields all 8",
    codes(LONG) === "P0300,P0301,P0302,P0303,P0420,P0171,P0455,P0740",
    codes(LONG),
  );
  check(
    "frames: the frame-counter line is not read as a header",
    parseFrames(LONG).every((frame) => frame.header === null),
  );
  check(
    "frames: 0:/1: prefixes are stripped, not parsed",
    stripLinePrefix("0: 43 08") === "43 08" &&
      stripLinePrefix("1:03 03") === "03 03",
  );

  // ---------- 3. two modules, headers on ----------
  // Without frame boundaries these merge into one unattributed list.

  {
    const lines = ["7E8 06 43 02 03 00 04 20", "7E9 04 43 01 07 01"];
    const sets = parseDtcReply(lines, 0x03, { headers: true });
    check("frames: two modules stay two messages", sets.length === 2, String(sets.length));
    check(
      "frames: engine and transmission are told apart",
      sets[0]?.module === "Engine" &&
        sets[1]?.module === "Transmission" &&
        sets[0]?.moduleId === 0x7e8 &&
        sets[1]?.moduleId === 0x7e9,
      JSON.stringify(sets.map((s) => [s.module, s.moduleId])),
    );
    check(
      "frames: each module keeps its own codes",
      sets[0]?.codes.join(",") === "P0300,P0420" &&
        sets[1]?.codes.join(",") === "P0701",
      JSON.stringify(sets.map((s) => s.codes.join(","))),
    );
  }

  // Headers off: the same two modules merge into one unattributed payload,
  // and BOTH lists still have to come out — that is what searching for
  // every anchor rather than the first buys.
  check(
    "frames: merged modules with headers off still yield both lists",
    codes(["43 02 03 00 04 20", "43 01 07 01"]) === "P0300,P0420,P0701",
    codes(["43 02 03 00 04 20", "43 01 07 01"]),
  );

  // ---------- 4/5. header width comes from ATDPN, not from guessing ----------

  check(
    "frames: ATDPN codes map to header shapes",
    headerShapeFor("6") === "can11" &&
      headerShapeFor("7") === "can29" &&
      headerShapeFor("3") === "legacy" &&
      headerShapeFor(null) === "can11",
  );

  {
    const lines = ["18 DA F1 10 06 43 02 03 00 04 20"];
    const frames = parseFrames(lines, { protocolCode: "7", headers: true });
    // The four address bytes come off; the PCI byte stays in the payload and
    // the anchor scan walks past it. That is the whole design in one line.
    check(
      "frames: 29-bit header is four address bytes",
      frames[0]?.header === 0x18daf110 &&
        hex(frames[0]?.data) === "06 43 02 03 00 04 20",
      `${frames[0]?.header?.toString(16)} [${hex(frames[0]?.data)}]`,
    );
    check(
      "frames: 29-bit source address 0x10 reads as Engine",
      moduleLabel(frames[0]?.header ?? null) === "Engine",
    );
    check(
      "frames: 29-bit header packed into one token",
      parseFrames(["18DAF110 06 43 02 03 00 04 20"], {
        protocolCode: "7",
        headers: true,
      })[0]?.header === 0x18daf110,
    );
  }

  {
    const lines = ["48 6B 10 43 02 03 00 04 20"];
    const frames = parseFrames(lines, { protocolCode: "3", headers: true });
    // ISO 9141 carries no PCI byte, so the payload starts at the service
    // byte — which is exactly why a fixed offset would have to know the
    // protocol and an anchor scan does not.
    // The header is three address bytes (`Fmt Target Source`) and the module
    // is the source, the third one — so the id is 0x10, not the packed
    // header. That is what makes `moduleLabel` a lookup rather than a guess.
    check(
      "frames: legacy ISO 9141 header is three address bytes",
      frames[0]?.header === 0x10 &&
        hex(frames[0]?.data) === "43 02 03 00 04 20",
      `${frames[0]?.header?.toString(16)} [${hex(frames[0]?.data)}]`,
    );
    check(
      "frames: legacy source address 0x10 reads as Engine",
      moduleLabel(frames[0]?.header ?? null) === "Engine",
    );
    // The same bytes under the wrong protocol code eat four payload bytes
    // instead of three and lose the anchor entirely — which is why ATDPN is
    // read before anything else.
    check(
      "frames: the wrong protocol code loses the reply",
      codes(lines, 0x03, { protocolCode: "7", headers: true }) === "",
    );
  }

  // ---------- the measured car ----------
  // A KWP2000 vehicle whose raw dump is the only real evidence this parser
  // has ever had: two modules answered, and the lamp that was lit belonged
  // to the one the app was not reading. The checksums below are computed the
  // way the adapter computes them (sum of the preceding bytes, mod 256) —
  // the last one reproduces the capture byte for byte.

  {
    const kwp = { protocolCode: "5", headers: true };
    const status = parseStatus(
      ["86 F1 18 41 01 00 04 00 00 D5", "86 F1 12 41 01 82 46 80 00 13"],
      kwp,
    );
    check(
      "measured: both answering modules are kept",
      status?.modules?.length === 2 &&
        status.modules.map((m) => m.moduleId).join(",") === "24,18",
      JSON.stringify(status?.modules),
    );
    check(
      "measured: the lamp is on and the counts add up",
      status?.milOn === true && status?.dtcCount === 2,
      JSON.stringify(status),
    );
    check(
      "measured: an unnamed address is reported as itself",
      (status?.modules ?? []).map((m) => m.module).join(",") === "ECU 18,ECU 12",
      (status?.modules ?? []).map((m) => m.module).join(","),
    );

    const sets = parseDtcReply(
      ["87 F1 12 43 04 01 12 46 00 00 2A"],
      0x03,
      kwp,
    );
    check(
      "measured: the stored reply decodes to the codes it carried",
      sets[0]?.codes.join(",") === "P0401,P1246",
      JSON.stringify(sets[0]),
    );
    // The frame is `87 F1 12 43 04 01 12 46 00 00 2A`: the trailing `2A` is
    // the KWP2000 checksum and must be stripped, not read as a third pair.
    // Keeping it would make the payload eight bytes — even again — and the
    // checksum would decode as a real-looking code.
    check(
      "measured: the checksum byte does not become a third code",
      sets[0]?.codes.length === 2 && sets[0]?.truncated === 0,
      JSON.stringify(sets[0]),
    );

    const refusal = parseMessages(["84 F1 18 7F 0A 11 27"], kwp);
    check(
      "measured: the mode 0A refusal is a refusal, not payload",
      negativeResponse(refusal[0]?.payload ?? [])?.nrc === 0x11,
      JSON.stringify(refusal[0]?.payload),
    );
  }

  check(
    "frames: unknown 7E-range header is reported as itself",
    moduleLabel(0x7ef) === "ECU 7EF" && moduleLabel(null) === null,
  );
  check(
    "frames: 7EA is brakes, 7EB is body",
    moduleLabel(0x7ea) === "ABS / Brakes" && moduleLabel(0x7eb) === "Body / SRS",
  );

  // ---------- 6. negative responses ----------
  // The old flat path turned `7F 03 12` into byte soup; a `7F` is not an
  // anchor, so the refusal has to be detected explicitly.

  {
    const refusal = negativeResponse([0x7f, 0x03, 0x12]);
    check(
      "frames: `7F 03 12` is recognised as a refusal",
      refusal !== null && refusal.nrc === 0x12 && refusal.mode === 0x03,
      JSON.stringify(refusal),
    );
    check(
      "frames: a refusal survives the sentence wrapper",
      describeNegativeResponse([0x7f, 0x03, 0x12])?.includes("not supported") ===
        true,
      describeNegativeResponse([0x7f, 0x03, 0x12]) ?? "null",
    );
    check(
      "frames: a refusal yields zero codes, not garbage",
      codes(["7F 03 12"]) === "" && parseDtcPayload([0x7f, 0x03, 0x12], 0x43).codes.length === 0,
    );
    check(
      "frames: a 7F inside ordinary data is not a refusal",
      negativeResponse([0x43, 0x02, 0x7f, 0x00, 0x04, 0x20]) === null,
    );
    const sets = parseDtcReply(["7F 03 12"], 0x03);
    check(
      "frames: the refusing module is reported with its refusal",
      sets.length === 1 && sets[0].negative !== null && sets[0].codes.length === 0,
    );
  }

  // ---------- 7/8. what is not a reply ----------

  check(
    "frames: NO DATA is recognised",
    saidNoData(["NO DATA"]) && !saidNoData(["43 00"]),
  );
  check(
    "frames: adapter chatter yields no frames",
    parseFrames([
      "SEARCHING...",
      "BUS INIT: OK",
      "UNABLE TO CONNECT",
      "STOPPED",
      "?",
      "OK",
      "NO DATA",
      "",
    ]).length === 0,
  );
  check(
    "frames: chatter lines are classified as noise",
    isNoiseLine("SEARCHING...") &&
      isNoiseLine("bus init: ok") &&
      isNoiseLine("CAN ERROR") &&
      !isNoiseLine("43 02 03 00 04 20"),
  );

  // ---------- 9. mode 0A answers in the same shape ----------

  check(
    "frames: mode 0A carries permanent codes",
    codes(["4A 01 03 01"], 0x0a) === "P0301",
    codes(["4A 01 03 01"], 0x0a),
  );
  check(
    "frames: mode 0A with zero codes is an empty list, not a failure",
    codes(["4A 00"], 0x0a) === "",
  );
  check(
    "frames: mode 0A does not answer to the mode 03 anchor",
    codes(["4A 01 03 01"], 0x03) === "",
  );

  // ---------- the truncation guard ----------
  // An anchor that opens a payload and names more pairs than the reply holds
  // is a real answer that got cut (measured on a KWP2000 car); an anchor
  // anywhere else that names too many is data wearing a service byte.

  {
    const short = parseDtcPayload([0x43, 0x05, 0x03, 0x00], 0x43);
    check(
      "frames: a block cut short keeps the codes it carried",
      short.codes.join(",") === "P0300" && short.truncated === 1,
      JSON.stringify(short),
    );
    // The measured frame, verbatim: `87 F1 12 43 04 01 12 46 00 00 2A`
    // (checksum verified). Read as `<count=4>` it is 2.5 pairs — no count
    // satisfies it — and it decodes P0112/C0600, one byte off from the real
    // list. The byte behind the anchor is therefore not a count, and the
    // module's own PID 01 agrees: it holds two codes, and the pairs say two.
    const measured = parseDtcPayload(
      [0x43, 0x04, 0x01, 0x12, 0x46, 0x00, 0x00],
      0x43,
    );
    check(
      "frames: a count-less KWP2000 reply decodes as pairs, not one byte off",
      measured.codes.join(",") === "P0401,P1246" && measured.truncated === 0,
      JSON.stringify(measured),
    );
    // The same two codes in the standard encoding. The count byte is there
    // and fits, so it is honoured — the two shapes must not be confused.
    const counted = parseDtcPayload([0x43, 0x02, 0x04, 0x01, 0x12, 0x46], 0x43);
    check(
      "frames: the same codes behind a count byte follow the count",
      counted.codes.join(",") === "P0401,P1246" && counted.truncated === 0,
      JSON.stringify(counted),
    );
    // And the same ECU's empty list: `87 F1 18 43 00 00 00 00 00 00 D3`.
    const none = parseDtcPayload(
      [0x43, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      0x43,
    );
    check(
      "frames: a count-less empty list is empty, not truncated",
      none.codes.length === 0 && none.truncated === 0,
      JSON.stringify(none),
    );
    const empty = parseDtcPayload([0x43, 0x00], 0x43);
    check(
      "frames: `43 00` is a valid empty block",
      empty.codes.length === 0 && empty.truncated === 0,
      JSON.stringify(empty),
    );
    // 0x4A is a legal data byte, so a bare search finds phantom anchors.
    // Rejected as an anchor, and explicitly not reported as truncation.
    const phantom = parseDtcPayload([0x43, 0x01, 0x03, 0x00, 0x4a, 0x05], 0x4a);
    check(
      "frames: a data byte that looks like an anchor is rejected",
      phantom.codes.length === 0 && phantom.truncated === 0,
      JSON.stringify(phantom),
    );
    check(
      "frames: padding after a real block is ignored",
      parseDtcPayload([0x43, 0x01, 0x03, 0x00, 0x00, 0x00, 0xaa, 0xaa], 0x43)
        .codes.join(",") === "P0300",
    );
  }

  // ---------- DTC pair encoding ----------

  // System bits 7-6: P=00, C=01, B=10, U=11 — so 0x51 is a C code and 0xC1
  // is a U code. Byte 2 packs two more characters at bits 7-4 and 3-0.
  check(
    "dtc: the five characters unpack from two bytes",
    decodeDtcPair(0x03, 0x00) === "P0300" &&
      decodeDtcPair(0x04, 0x20) === "P0420" &&
      decodeDtcPair(0x51, 0x01) === "C1101" &&
      decodeDtcPair(0x91, 0x38) === "B1138" &&
      decodeDtcPair(0xc1, 0x00) === "U0100",
    [
      decodeDtcPair(0x03, 0x00),
      decodeDtcPair(0x51, 0x01),
      decodeDtcPair(0x91, 0x38),
      decodeDtcPair(0xc1, 0x00),
    ].join(","),
  );
  check("dtc: 00 00 is list padding, not a code", decodeDtcPair(0, 0) === null);
  check(
    "dtc: encode is the inverse of decode",
    JSON.stringify(encodeDtc("P0300")) === JSON.stringify([0x03, 0x00]) &&
      JSON.stringify(encodeDtc("U0100")) === JSON.stringify([0xc1, 0x00]),
    JSON.stringify([encodeDtc("P0300"), encodeDtc("U0100")]),
  );
  check(
    "dtc: a non-code string does not encode",
    encodeDtc("P030") === null && encodeDtc("nonsense") === null,
  );

  // ---------- groupByModule keeps first-seen order ----------

  check(
    "frames: modules keep the order the adapter printed them",
    parseMessages(["7E9 04 43 01 07 01", "7E8 06 43 02 03 00 04 20"], {
      headers: true,
    })
      .map((m) => m.header)
      .join(",") === String(0x7e9) + "," + String(0x7e8),
  );

  // ---------- the VIN scan (mode 09 PID 02) ----------
  //
  // The VIN reader anchors on `49 02` instead of `43 <count>`, and its
  // failure mode is the quiet one: a byte of framing left in the string
  // yields a VIN that looks perfectly fine and is wrong. These checks are
  // that byte — and the shapes below are the ones real cars actually send.
  {
    const VIN = "WVWZZZ1JZXW000001";
    const hex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
    const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
    /** `49 02 01 <chunk>` — what one module answers 0902 with. */
    const anchor = (chunk: string) => [0x49, 0x02, 0x01, ...chars(chunk)];
    /** A legacy `Fmt Target Source <data> Checksum` frame, as a reply line. */
    const legacy = (module: number, data: number[]) => {
      const body = [0x80 | data.length, 0xf1, module, ...data];
      const sum = body.reduce((a, b) => a + b, 0) & 0xff;
      return { line: [...body, sum].map(hex).join(" "), checksum: sum };
    };

    // The measured shape: a KWP2000 car that repeats the anchor on every
    // frame and carries three characters behind each, read with headers off.
    const repeated = (VIN.match(/.{1,3}/g) ?? []).map(
      (chunk) => legacy(0x18, anchor(chunk)).line,
    );
    const readings = parseVinReadings(repeated);
    check(
      "vin: a module that repeats the anchor every frame is read whole",
      readings[0]?.vin === VIN && readings[0]?.complete === true,
      JSON.stringify(readings[0] ?? null),
    );
    check(
      "vin: the module address survives with headers off",
      readings[0]?.moduleId === 0x18,
      String(readings[0]?.moduleId),
    );

    // A checksum is one unlucky byte away from being a legal VIN character,
    // and a legal one joins the run — `49 02 01 WVW3` is two bytes away from
    // reading as a five-character answer. Sweeping source addresses until one
    // lands in `A-Z0-9`-minus-IOQ is what keeps this a test and not a hope.
    const trapFrame = () => {
      for (let module = 0x10; module <= 0xff; module++) {
        const frame = legacy(module, anchor(VIN.slice(0, 3)));
        if (isVinChar(String.fromCharCode(frame.checksum))) return frame;
      }
      return null;
    };
    const trap = trapFrame();
    if (trap === null) {
      check("vin: a source address with a VIN-looking checksum exists", false);
    } else {
      const trapped = parseVinReadings([trap.line]);
      check(
        "vin: a checksum that looks like a VIN character is still not data",
        trapped[0]?.vin === VIN.slice(0, 3),
        `${hex(trap.checksum)} → ${JSON.stringify(trapped[0]?.vin ?? null)}`,
      );
      // …and the same frame read as a headerless payload keeps it, which is
      // what proves the strip happened for the right reason (0xF1) rather
      // than by luck of the checksum's value.
      const raw = readLineFrame(trap.line);
      check(
        "vin: the legacy header is recognised from its own shape",
        raw?.header !== null && raw?.payload.length === 6,
        JSON.stringify(raw ?? null),
      );
    }

    // CAN, one frame, header and PCI byte present.
    const canSingle = [
      `7E8 06 49 02 01 ${chars(VIN).map(hex).join(" ")}`,
    ];
    const canRead = parseVinReadings(canSingle);
    check(
      "vin: a CAN frame with a header and a PCI byte reads whole",
      canRead[0]?.vin === VIN && canRead[0]?.moduleId === 0x7e8,
      JSON.stringify(canRead[0] ?? null),
    );

    // CAN, multi-frame, anchor sent ONCE — the other shape a real car
    // produces. Consecutive frames carry a PCI byte where a naïve reader
    // would end the run, and the VIN comes back three characters short.
    const canMulti = [
      `7E8 10 14 49 02 01 ${chars(VIN.slice(0, 13)).map(hex).join(" ")}`,
      `7E8 21 ${chars(VIN.slice(13, 16)).map(hex).join(" ")}`,
      `7E8 22 ${chars(VIN.slice(16)).map(hex).join(" ")}`,
    ];
    check(
      "vin: a CAN multi-frame reply is joined across its PCI bytes",
      parseVinReadings(canMulti)[0]?.vin === VIN,
      JSON.stringify(parseVinReadings(canMulti)[0]?.vin ?? null),
    );

    // Two modules answer one 0902 into one flat soup: one stopped at six
    // characters, the other sent all seventeen. The whole one wins, and the
    // two are never spliced into an eighteen-character "VIN".
    const mixed = parseVinReadings([
      legacy(0x18, anchor(VIN.slice(0, 6))).line,
      legacy(0x12, anchor(VIN)).line,
    ]);
    check(
      "vin: two answering modules are not spliced into one VIN",
      mixed[0]?.vin === VIN && mixed[0]?.moduleId === 0x12,
      JSON.stringify(mixed[0] ?? null),
    );

    // Fragments: three characters is a manufacturer, two are noise.
    const fragment = parseVinReadings([legacy(0x18, anchor(VIN.slice(0, 3))).line]);
    check(
      "vin: a three-character fragment is kept",
      fragment[0]?.vin === "WVW" && fragment[0]?.complete === false,
      JSON.stringify(fragment[0] ?? null),
    );
    check(
      "vin: two characters are not a reading",
      parseVinReadings([legacy(0x18, [0x49, 0x02, 0x01, 0x57, 0x56]).line]).length === 0,
    );

    // ISO-TP padding ends the run: a `00`/`AA` tail must not be appended.
    check(
      "vin: ISO-TP padding ends the run",
      parseVinBlocks([0x49, 0x02, 0x01, ...chars(VIN), 0xaa, 0xaa, 0x00])[0] === VIN,
    );

    // Nothing at all.
    check(
      "vin: silence and noise carry no VIN",
      parseVinReadings(["NO DATA", "SEARCHING...", ">", "014", "7F 09 12"]).length === 0,
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll frame checks passed.");
}

main();
