// Smoke test for the ELM327 framing layer (src/obd/at.ts).
// Run with: npx tsx scripts/elm327-smoke.ts
// No hardware needed — feeds recorded-style response streams.

import { Elm327Channel } from "../src/obd/at";
import {
  PROTOCOL_NAMES,
  ascii,
  extractBytes,
  extractMode49,
  readCalid,
  readEcuName,
  readVin,
} from "../src/obd/mode09";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  // 1. Echo + single-line response, no prompt (ATI style).
  {
    const sent: string[] = [];
    const ch = new Elm327Channel((raw) => void sent.push(raw));
    const p = ch.command("ATI");
    ch.feed("ATI\rELM327 v1.5\r");
    const lines = await p;
    check("single line, echo stripped", JSON.stringify(lines) === JSON.stringify(["ELM327 v1.5"]), JSON.stringify(lines));
    check("command sent with CR", sent[0] === "ATI\r", JSON.stringify(sent));
  }

  // 2. Multi-line response ended by ">" prompt (ATZ style).
  {
    const ch = new Elm327Channel(() => {});
    const p = ch.command("ATZ");
    ch.feed("ATZ\r\rELM327 v1.5\r\r>");
    const lines = await p;
    check("multi-line, prompt-terminated, blanks dropped", JSON.stringify(lines) === JSON.stringify(["ELM327 v1.5"]), JSON.stringify(lines));
  }

  // 3. Response split into arbitrary chunks mid-line.
  {
    const ch = new Elm327Channel(() => {});
    const p = ch.command("ATZ");
    ch.feed("AT");
    ch.feed("Z\rELM");
    ch.feed("327 v1.5\r");
    ch.feed("\r>");
    const lines = await p;
    check("chunked bytes reassembled", JSON.stringify(lines) === JSON.stringify(["ELM327 v1.5"]), JSON.stringify(lines));
  }

  // 4. Clone using bare \n line endings.
  {
    const ch = new Elm327Channel(() => {});
    const p = ch.command("ATI");
    ch.feed("ATI\nELM327 v1.5\n");
    const lines = await p;
    check("LF-only lines normalized", JSON.stringify(lines) === JSON.stringify(["ELM327 v1.5"]), JSON.stringify(lines));
  }

  // 5. Echo already off (after ATE0): no echo line to strip.
  {
    const ch = new Elm327Channel(() => {});
    const p = ch.command("ATE0");
    ch.feed("OK\r");
    const lines = await p;
    check("no-echo response kept", JSON.stringify(lines) === JSON.stringify(["OK"]), JSON.stringify(lines));
  }

  // 6. Echo matching is case-insensitive (clones echo verbatim).
  {
    const ch = new Elm327Channel(() => {});
    const p = ch.command("atz");
    ch.feed("ATZ\rELM327 v1.5\r>");
    const lines = await p;
    check("case-insensitive echo stripped", JSON.stringify(lines) === JSON.stringify(["ELM327 v1.5"]), JSON.stringify(lines));
  }

  // 7. Timeout when the adapter never answers.
  {
    const ch = new Elm327Channel(() => {});
    let rejected = false;
    try {
      await ch.command("ATZ", 150);
    } catch {
      rejected = true;
    }
    check("silent adapter times out", rejected);
  }

  // 8. Settle-timer resolution: response without prompt resolves after quiet gap.
  {
    const ch = new Elm327Channel(() => {});
    const p = ch.command("0100");
    ch.feed("0100\r41 00 BE 3F A8 13\r");
    const lines = await p;
    check("settle resolves prompt-less response", JSON.stringify(lines) === JSON.stringify(["41 00 BE 3F A8 13"]), JSON.stringify(lines));
  }

  // ---------- mode 09 parsers ----------

  const VIN = "WVWZZZ3CZWE000101";
  const vinHex = [...VIN].map((c) => c.charCodeAt(0).toString(16).toUpperCase());
  const vinResp = ["49", "02", "01", ...vinHex];

  // 9. VIN from a multi-line reply: frame counter + "N:" prefixes.
  {
    const bytes = extractBytes([
      "014",
      "0: " + vinResp.slice(0, 12).join(" "),
      "1: " + vinResp.slice(12).join(" "),
    ]);
    const block = extractMode49(bytes, 0x02);
    check(
      "mode09: VIN parsed from multi-line frames",
      block !== null && ascii(block.data).slice(0, 17) === VIN,
      block ? ascii(block.data).slice(0, 17) : "null",
    );
  }

  // 10. VIN from a CAN single frame with header + PCI length byte.
  {
    const bytes = extractBytes(["7E8 06 " + vinResp.join(" ")]);
    const block = extractMode49(bytes, 0x02);
    check(
      "mode09: VIN parsed with CAN header and PCI",
      block !== null && ascii(block.data).slice(0, 17) === VIN,
      block ? ascii(block.data).slice(0, 17) : "null",
    );
  }

  // 11. VIN padded with 0xAA (multi-frame ISO-TP tail padding).
  {
    const bytes = extractBytes([(vinResp.concat(["AA", "AA", "AA", "AA"])).join(" ")]);
    const block = extractMode49(bytes, 0x02);
    check(
      "mode09: VIN parsed despite ISO-TP padding",
      block !== null && ascii(block.data).slice(0, 17) === VIN,
      block ? ascii(block.data).slice(0, 17) : "null",
    );
  }

  // 12. Full readVin round-trip through the channel.
  {
    const ch = new Elm327Channel(() => {});
    const p = readVin(ch);
    ch.feed("0902\r014\r0: " + vinResp.slice(0, 12).join(" ") + "\r1: " + vinResp.slice(12).join(" ") + "\r\r>");
    const vin = await p;
    check("mode09: readVin round-trip", vin === VIN, vin ?? "null");
  }

  // 13. CALID single.
  {
    const bytes = extractBytes(["49 04 01 33 32 39 30 2D 43 41 4C 49 44 2D 30 31"]);
    const block = extractMode49(bytes, 0x04);
    check(
      "mode09: single CALID parsed",
      block !== null && block.count === 1 && ascii(block.data) === "3290-CALID-01",
      block ? `${block.count}/${ascii(block.data)}` : "null",
    );
  }

  // 14. CALID ×2, fixed 16-byte fields with null padding.
  {
    const mk = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).toUpperCase());
    const pad = (arr: string[]) => arr.concat(Array(16 - arr.length).fill("00"));
    const id1 = pad(mk("CALID-AAA"));
    const id2 = pad(mk("CALID-BBB"));
    const bytes = extractBytes([["49", "04", "02", ...id1, ...id2].join(" ")]);
    const block = extractMode49(bytes, 0x04);
    const ids = block
      ? Array.from({ length: block.count }, (_, i) => ascii(block.data.slice(i * 16, (i + 1) * 16)))
      : [];
    check(
      "mode09: two CALIDs split into 16-byte fields",
      JSON.stringify(ids) === JSON.stringify(["CALID-AAA", "CALID-BBB"]),
      JSON.stringify(ids),
    );
  }

  // 15. ECU name with null padding.
  {
    const bytes = extractBytes(["49 0A 01 45 43 4D 2D 45 6E 67 69 6E 65 43 6F 6E 74 72 6F 6C 00 00 00"]);
    const block = extractMode49(bytes, 0x0a);
    check(
      "mode09: ECU name parsed",
      block !== null && ascii(block.data) === "ECM-EngineControl",
      block ? ascii(block.data) : "null",
    );
  }

  // 16. NO DATA — the PID is unsupported.
  {
    const bytes = extractBytes(["NO DATA"]);
    check("mode09: NO DATA yields null", extractMode49(bytes, 0x02) === null);
  }

  // 17. Protocol code map.
  check(
    "mode09: ATDPN code mapped to protocol name",
    PROTOCOL_NAMES["6"] === "ISO 15765-4 (CAN 11-bit/500k)" && PROTOCOL_NAMES["3"] === "ISO 9141-2",
  );

  // 18. readCalid / readEcuName round-trips through the channel.
  {
    const ch = new Elm327Channel(() => {});
    const p = readCalid(ch);
    ch.feed("0904\r49 04 01 44 45 4D 4F 2D 43 41 4C 49 44\r>");
    const ids = await p;
    check("mode09: readCalid round-trip", JSON.stringify(ids) === JSON.stringify(["DEMO-CALID"]), JSON.stringify(ids));
  }
  {
    const ch = new Elm327Channel(() => {});
    const p = readEcuName(ch);
    ch.feed("090A\r49 0A 01 45 43 4D 00 00\r>");
    const name = await p;
    check("mode09: readEcuName round-trip", name === "ECM", name ?? "null");
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll ELM327 channel checks passed.");
}

main();
