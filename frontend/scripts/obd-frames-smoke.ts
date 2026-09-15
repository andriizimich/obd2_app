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
  saidNoData,
  stripLinePrefix,
} from "../src/obd/frames";
import { decodeDtcPair, encodeDtc } from "../src/obd/dtc";
import { parseDtcPayload, parseDtcReply } from "../src/obd/mode03";

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
    check(
      "frames: legacy ISO 9141 header is three address bytes",
      frames[0]?.header === 0x486b10 &&
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
  // An anchor naming more pairs than the reply actually holds is not an
  // anchor. Without this, a lost CAN frame turns into confident nonsense.

  {
    const short = parseDtcPayload([0x43, 0x05, 0x03, 0x00], 0x43);
    check(
      "frames: a truncated block yields no codes and is reported",
      short.codes.length === 0 && short.truncated === 1,
      JSON.stringify(short),
    );
    const empty = parseDtcPayload([0x43, 0x00], 0x43);
    check(
      "frames: `43 00` is a valid empty block",
      empty.codes.length === 0 && empty.truncated === 0,
      JSON.stringify(empty),
    );
    // 0x4A is a legal data byte, so a bare search finds phantom anchors.
    const phantom = parseDtcPayload([0x4a, 0x05, 0x4a, 0x00], 0x4a);
    check(
      "frames: a data byte that looks like an anchor is rejected",
      phantom.codes.length === 0 && phantom.truncated === 1,
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

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll frame checks passed.");
}

main();
