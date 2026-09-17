// Smoke test for the ELM327 framing layer (src/obd/at.ts).
// Run with: npx tsx scripts/elm327-smoke.ts
// No hardware needed — feeds recorded-style response streams.

import { Elm327Channel } from "../src/obd/at";
import {
  PROTOCOL_NAMES,
  parseCalid,
  parseEcuName,
  parseVin,
  readCalid,
  readEcuName,
  readVin,
} from "../src/obd/mode09";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

/** Let queued microtasks run: a channel that was parked on a drain writes its
 *  next command from a microtask, not synchronously. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Longer than a drain that hears nothing. Mirrors FLUSH_MS in src/obd/at.ts,
 *  which is deliberately not exported — the wait is what that test is about. */
const DRAIN_MS = 1100;

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
    const vin = parseVin([
      "014",
      "0: " + vinResp.slice(0, 12).join(" "),
      "1: " + vinResp.slice(12).join(" "),
    ]);
    check("mode09: VIN parsed from multi-line frames", vin === VIN, vin ?? "null");
  }

  // 10. VIN from a CAN single frame with header + PCI length byte.
  {
    const vin = parseVin(["7E8 06 " + vinResp.join(" ")]);
    check("mode09: VIN parsed with CAN header and PCI", vin === VIN, vin ?? "null");
  }

  // 11. VIN padded with 0xAA (multi-frame ISO-TP tail padding).
  {
    const vin = parseVin([vinResp.concat(["AA", "AA", "AA", "AA"]).join(" ")]);
    check("mode09: VIN parsed despite ISO-TP padding", vin === VIN, vin ?? "null");
  }

  // 12. Full readVin round-trip through the channel.
  {
    const ch = new Elm327Channel(() => {});
    const p = readVin(ch);
    ch.feed("0902\r014\r0: " + vinResp.slice(0, 12).join(" ") + "\r1: " + vinResp.slice(12).join(" ") + "\r\r>");
    const vin = await p;
    check("mode09: readVin round-trip", vin === VIN, vin ?? "null");
  }

  // 13. CALID single. The byte behind the PID is the reply's own identifier
  //     and must not appear in the value.
  {
    const ids = parseCalid(["49 04 01 33 32 39 30 2D 43 41 4C 49 44 2D 30 31"]);
    check(
      "mode09: single CALID parsed",
      JSON.stringify(ids) === JSON.stringify(["3290-CALID-01"]),
      JSON.stringify(ids),
    );
  }

  // 14. CALID ×2, fixed 16-byte fields with null padding.
  {
    const mk = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).toUpperCase());
    const pad = (arr: string[]) => arr.concat(Array(16 - arr.length).fill("00"));
    const id1 = pad(mk("CALID-AAA"));
    const id2 = pad(mk("CALID-BBB"));
    const ids = parseCalid([["49", "04", "02", ...id1, ...id2].join(" ")]);
    check(
      "mode09: two CALIDs split into 16-byte fields",
      JSON.stringify(ids) === JSON.stringify(["CALID-AAA", "CALID-BBB"]),
      JSON.stringify(ids),
    );
  }

  // 14b. The measured car, byte for byte. Its `0904` numbers every message and
  //      carries four data bytes each, so an identifier sits in front of every
  //      group — and a `7F 09 78` ("still working") sits in the middle of the
  //      reply. An earlier parser ran on from the first anchor, read all of it
  //      back as text, and put `7539I073IIxI7b…` on the CALID row: `0x49` is
  //      the letter `I` and `0x78` is `x`.
  {
    const ids = parseCalid([
      "49 04 01 37 35 33 39",
      "49 04 02 30 37 33 00",
      "49 04 03 00 00 00 00",
      "49 04 04 00 00 00 00",
      "7F 09 78",
      "49 04 05 37 35 35 38",
      "49 04 06 33 36 33 00",
      "49 04 07 00 00 00 00",
    ]);
    check(
      "mode09: the car's own 0904 reply yields its two CALIDs",
      JSON.stringify(ids) === JSON.stringify(["7539073", "7558363"]),
      JSON.stringify(ids),
    );
  }

  // 14c. A pending reply carries no data at all, and one that landed inside a
  //      value would leave a printable `x` behind — the only byte of it a
  //      reader could not have spotted as framing.
  {
    const ids = parseCalid(["49 04 01 41 42 43 00", "7F 09 78", "49 04 02 44 45 46 00"]);
    check(
      "mode09: a pending reply never reaches the value",
      JSON.stringify(ids) === JSON.stringify(["ABCDEF"]),
      JSON.stringify(ids),
    );
  }

  // 15. ECU name with null padding.
  {
    const name = parseEcuName([
      "49 0A 01 45 43 4D 2D 45 6E 67 69 6E 65 43 6F 6E 74 72 6F 6C 00 00 00",
    ]);
    check("mode09: ECU name parsed", name === "ECM-EngineControl", name ?? "null");
  }

  // 16. The two ways a PID is not answered: the adapter says so, or the ECU
  //     refuses. Neither is a value.
  {
    check("mode09: NO DATA yields nothing", parseCalid(["NO DATA"]).length === 0);
    check("mode09: a refusal yields nothing", parseCalid(["7F 09 12"]).length === 0);
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

  // ---------- draining an abandoned command's answer ----------

  // 19. A reply that outlives the command it answers must not be handed to the
  //     command that follows. This is the shape that makes every read after
  //     the first timeout come back with nothing while the AT commands still
  //     answer: the abandoned answer's prompt ends the *next* command's wait.
  {
    const sent: string[] = [];
    const ch = new Elm327Channel((raw) => void sent.push(raw));
    let timedOut = false;
    try {
      await ch.command("0902", 120);
    } catch {
      timedOut = true;
    }
    check("drain: an unanswered command still times out", timedOut, JSON.stringify(sent));

    // The adapter was only slower than the caller's patience: its data, then
    // its prompt, arrive with nothing waiting for them.
    ch.feed("0902\r49 02 01 57 56 57 5A\r");
    const next = ch.command("ATDPN", 400);
    ch.feed(">\r");
    check(
      "drain: nothing is written while the abandoned answer is still arriving",
      sent.length === 1,
      JSON.stringify(sent),
    );
    await tick();
    check(
      "drain: the next command goes out as soon as the adapter's prompt ends the drain",
      sent.length === 2 && sent[1] === "ATDPN\r",
      JSON.stringify(sent),
    );
    ch.feed("ATDPN\r6\r>\r");
    const lines = await next;
    check(
      "drain: a late prompt cannot resolve the next command",
      JSON.stringify(lines) === JSON.stringify(["6"]),
      JSON.stringify(lines),
    );
  }

  // 20. The abandoned answer's half-written line must not become the first
  //     line of the next reply. The drain runs out here rather than ending on
  //     a prompt, which is the only way the fragment survives long enough —
  //     hence the real wait.
  {
    const ch = new Elm327Channel(() => {});
    try {
      await ch.command("0902", 80);
    } catch {
      /* the timeout is the setup, not the check */
    }
    ch.feed("49 02 01 57"); // half a line; the rest never comes
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS));
    const next = ch.command("ATDPN", 400);
    ch.feed("ATDPN\r6\r>\r");
    const lines = await next;
    check(
      "drain: a fragment left by the abandoned answer cannot glue onto the next reply",
      JSON.stringify(lines) === JSON.stringify(["6"]),
      JSON.stringify(lines),
    );
  }

  // 21. Disposing mid-drain must release a parked command rather than leave it
  //     waiting out the ceiling.
  {
    const ch = new Elm327Channel(() => {});
    try {
      await ch.command("0902", 60);
    } catch {
      /* the timeout is the setup, not the check */
    }
    const next = ch.command("ATI", 100);
    ch.dispose();
    let settled = false;
    try {
      await next;
      settled = true;
    } catch {
      settled = true;
    }
    check("drain: dispose releases a command parked on the drain", settled);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll ELM327 channel checks passed.");
}

main();
