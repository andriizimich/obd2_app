// J1979 mode 09 (vehicle information) readers and parsers, running over an
// Elm327Channel. Pure parsing — no transport code — unit-testable with
// recorded response frames.
//
// Response format: `49 <PID> <counter> <data…>`. With headers on (ATH1) a
// frame looks like `7E8 06 49 02 01 57 56 57 …`; the ELM327 default is to
// prefix multi-line replies with `0:`, `1:` … and a frame counter line
// like `014`. Multi-frame CAN replies pad the last frame with 0x00/0xAA,
// so data must be parsed leniently.
//
// The byte behind the PID is not data, and on a car that answers in several
// messages it is not the standard's "number of data items" either: a KWP2000
// ECU numbering its own messages rewrites it in every frame, and a parser
// that runs on past the first anchor reads those counters back as text. See
// {@link mode49Payload}.

import type { Elm327Channel } from "@/src/obd/at";
import { readLineFrame, refusalAt } from "@/src/obd/frames";
import { parseOdometer, parseStatus } from "@/src/obd/mode01";
import { describeError, emptyDetail, isNonAnswer } from "@/src/obd/reply";
import type { AdapterInfo, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError } from "@/src/obd/transport";
import type { Coverage, VehicleInfoOptions } from "@/src/obd/types";
import { isFullVin, isVinChar, VIN_LENGTH } from "@/src/utils/vin";

// ELM327 ATDPN result → human-readable OBD protocol.
export const PROTOCOL_NAMES: Record<string, string> = {
  "1": "SAE J1850 PWM",
  "2": "SAE J1850 VPW",
  "3": "ISO 9141-2",
  "4": "ISO 14230-4 (KWP2000, 5-baud init)",
  "5": "ISO 14230-4 (KWP2000, fast init)",
  "6": "ISO 15765-4 (CAN 11-bit/500k)",
  "7": "ISO 15765-4 (CAN 29-bit/500k)",
  "8": "ISO 15765-4 (CAN 11-bit/250k)",
  "9": "ISO 15765-4 (CAN 29-bit/250k)",
  A: "SAE J1939 (CAN 29-bit/250k)",
};

/** One CALID field, per J1979 PID 04: sixteen bytes, null-padded. */
const CALID_FIELD = 16;

/**
 * Every data byte a `49 <pid>` reply carries, in the order the adapter
 * printed it.
 *
 * The byte behind the anchor is a counter, and it is dropped whatever the
 * car means by it: the standard's "number of data items", written once in
 * the first message, or the running message number a KWP2000 ECU writes into
 * every frame instead. Measured on the car this was written for, `0904`
 * answers
 *
 *     `49 04 01 37 35 33 39`   message 1 — four data bytes behind the counter
 *     `49 04 02 30 37 33 00`   message 2
 *     `49 04 03 00 00 00 00`   message 3
 *     `49 04 04 00 00 00 00`   message 4 — sixteen bytes of one CALID
 *     `7F 09 78`               response pending — not a message, carries nothing
 *     `49 04 05 37 35 35 38`   message 5 — the next CALID starts
 *
 * so **every four-byte group has an identifier in front of it**. A parser
 * that takes everything after the first anchor reads those identifiers back
 * as text, and `0x49` is the letter `I` while `0x78` from the pending reply
 * is `x` — which is exactly how a two-field answer came back as the single
 * string `7539I073IIxI7b…` and why the CALID row on a real car was a wall of
 * `I`s.
 *
 * Runs therefore break at every anchor. Bytes *before* the first one belong
 * to something else — a negative response, a stray PCI byte, another
 * module's frame — and are dropped; bytes after it are data until the next
 * anchor, which is what keeps a reply that names the PID only once (a CAN
 * multi-frame answer) from losing its tail.
 *
 * Lines are walked one at a time so the framing comes off first
 * ({@link readLineFrame}): with headers on, neither the legacy header nor the
 * trailing checksum is data.
 */
function mode49Payload(lines: string[], pid: number): number[] {
  const out: number[] = [];
  let run: number[] | null = null;
  for (const line of lines) {
    const frame = readLineFrame(line);
    if (!frame) continue;
    const bytes = frame.payload;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x49 && bytes[i + 1] === pid) {
        if (run) out.push(...run);
        run = [];
        // Skipped here and by the loop's own step: the service byte, the PID,
        // and the counter behind them.
        i += 2;
        continue;
      }
      // A refusal is a status, not data, and it can sit between two messages
      // of a reply that is otherwise fine — `7F 09 78` ("still working") is
      // in the middle of the measured car's `0904` answer. Its code byte is
      // not always unprintable, so it has to be stepped over rather than left
      // for the ASCII filter: `0x78` is the letter `x`.
      if (refusalAt(bytes, i)) {
        i += 2;
        continue;
      }
      if (run) run.push(bytes[i]);
    }
  }
  if (run) out.push(...run);
  return out;
}

/** Printable ASCII from a byte array (drops padding/null bytes). */
export function ascii(data: number[]): string {
  let out = "";
  for (const b of data) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
  }
  return out;
}

/**
 * ATDPN's bare protocol code, or null when the line is not one.
 *
 * An adapter that found the protocol itself prefixes the code with `A` — the
 * factory default, so most cars answer `A6`, not `6`. The prefix is a flag,
 * not part of the code, and looking up `A6` in {@link PROTOCOL_NAMES} finds
 * nothing. Only the first `A` is the flag: `AA` is auto-detected J1939, and
 * a lone `A` is J1939 under a protocol the user pinned.
 */
export function normaliseProtocolCode(raw: string): string | null {
  const m = /^(A?)([0-9A])$/.exec(raw.trim().toUpperCase());
  return m ? m[2] : null;
}

/** ATDPN reply lines → the protocol code. The answer is the last line. */
export function detectProtocolCode(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const code = normaliseProtocolCode(lines[i] ?? "");
    if (code) return code;
  }
  return null;
}

/** ATDPN reply lines → the protocol name. Split from the read so the caller
 *  that keeps the raw lines can name the protocol from the same bytes. */
export function parseProtocol(lines: string[]): string | null {
  const code = detectProtocolCode(lines);
  if (!code) return null;
  return PROTOCOL_NAMES[code] ?? `Unknown protocol (${code})`;
}

export async function readProtocol(
  channel: Elm327Channel,
): Promise<string | null> {
  return parseProtocol(await channel.command("ATDPN", 2000));
}

/**
 * Shortest fragment worth keeping. Three characters is a world manufacturer
 * code, and a manufacturer is a real answer — "the ECU sent six characters"
 * is not the same fact as "nothing was readable", and the app used to
 * collapse the two.
 */
const MIN_VIN_CHARS = 3;

/** How many non-VIN bytes may sit *inside* a VIN. A CAN consecutive-frame
 *  PCI byte is one; two is slack for a clone that prints something else. */
const MAX_FRAMING_SKIP = 2;

/** Mode 09 PID 02. `0x49` is the letter I, which a VIN cannot contain — so a
 *  run of VIN characters stops at the next anchor by itself. */
const VIN_ANCHOR = [0x49, 0x02];

/** True when `anchor` starts at `i`. */
function matchesAnchor(payload: number[], i: number, anchor: number[]): boolean {
  for (let k = 0; k < anchor.length; k++) {
    if (payload[i + k] !== anchor[k]) return false;
  }
  return true;
}

/**
 * Every VIN fragment a payload carries behind {@link anchor}, in the order it
 * arrived. The default anchor is mode 09's `49 02`; the maker's own service
 * reads the same way behind `5A 90`.
 *
 * The byte behind the anchor is the count (usually `01`, `04` or a padding
 * `20`) on most ECUs and the first VIN character on some, so it is skipped
 * **only when it is not a legal VIN character** — which a count byte never is
 * and a VIN's first character always is.
 *
 * Collection then stops at the first character a VIN cannot contain, and
 * that one rule is what makes this robust without knowing the frame layout:
 * ISO-TP padding (`00`, `AA`), a KWP2000 checksum, the header bytes of the
 * next frame and the next `49 02` anchor itself (`0x49` is the letter I,
 * which ISO 3779 excludes) all end the run by themselves.
 *
 * Every anchor is read, not just the first: a module that repeats the anchor
 * on each frame of a multi-frame VIN answers with several short runs, and
 * one module is not the only one that answers mode 09.
 *
 * Runs come back as they are, down to a single character — seventeen
 * characters do not divide evenly by the three or four a frame holds, so the
 * last run of an honest answer is short, and dropping short runs here would
 * quietly shorten a VIN that arrived whole. The floor on what counts as an
 * answer lives in {@link parseVinReadings}, where the runs are joined.
 */
export function parseVinBlocks(
  payload: number[],
  anchor: number[] = VIN_ANCHOR,
): string[] {
  const out: string[] = [];
  for (let i = 0; i + anchor.length < payload.length; i++) {
    if (!matchesAnchor(payload, i, anchor)) continue;
    let j = i + anchor.length;
    if (!isVinChar(String.fromCharCode(payload[j]))) j++;
    let text = "";
    while (j < payload.length && text.length < VIN_LENGTH) {
      // A second anchor inside a run begins a new answer; the run that came
      // before it must not reach across. Mode 09 never needed this check —
      // its anchor opens with `0x49`, the letter I, which ends a run on its
      // own. KWP2000's opens with `0x5A`, which *is* a legal VIN character
      // (`Z`), so a repeated anchor would hand its `Z` to the previous run
      // and shift every character after it by one.
      if (text.length > 0 && matchesAnchor(payload, j, anchor)) break;
      const c = String.fromCharCode(payload[j]);
      if (isVinChar(c)) {
        text += c.toUpperCase();
        j++;
        continue;
      }
      // Inside a VIN there are no non-VIN characters, so one in the middle
      // is framing: a CAN consecutive-frame PCI byte (`21`, `22`), which is
      // how the one shape that does *not* repeat the anchor — a CAN
      // multi-frame reply — carries its remaining characters. Two bytes is
      // the allowance; padding, a KWP2000 checksum, a legacy header and the
      // next `49 02` anchor all end the run rather than skip it.
      let skipped = 0;
      while (
        skipped < MAX_FRAMING_SKIP &&
        j < payload.length &&
        !isVinChar(String.fromCharCode(payload[j]))
      ) {
        j++;
        skipped++;
      }
      if (j >= payload.length || !isVinChar(String.fromCharCode(payload[j]))) {
        break;
      }
    }
    if (text.length > 0) out.push(text);
  }
  return out;
}

export type VinReading = {
  vin: string;
  /** Module that answered, or null when headers were off. */
  moduleId: number | null;
  /** True when one contiguous run carried the whole VIN (17 characters). */
  complete: boolean;
};

/** CAN 11-bit addresses that answer as the engine controller. */
function isEngineModule(header: number | null): boolean {
  if (header === null) return false;
  return header === 0x10 || (header >= 0x7e8 && header <= 0x7ef);
}

/**
 * Every VIN a mode 09 reply could be carrying, best first.
 *
 * Two shapes have to survive, and they are the two a real car produces: a
 * module that names `49 02` once and streams the 17 characters over the
 * following frames (one long run), and one that repeats the anchor on every
 * frame with a few characters behind each (several short runs, joined in
 * arrival order).
 *
 * A run is capped at 17 characters, which is what keeps the headerless case
 * honest: when two modules answer into one flat soup and either of them is
 * whole, the whole one wins on length, and the join of two complete VINs
 * cannot grow past the length of the first.
 */
function readingsFrom(lines: string[], anchor: number[]): VinReading[] {
  // Frames first, modules second: the reply to one request holds a frame per
  // module, and a multi-frame answer interleaves nothing — so grouping by
  // address before scanning is what keeps two modules' VINs from being read
  // as one. Headers are not required for that: `readLineFrame` takes the
  // address off a legacy header itself.
  const byModule = new Map<string, { moduleId: number | null; payload: number[] }>();
  for (const line of lines) {
    const frame = readLineFrame(line);
    if (!frame) continue;
    const key = frame.header === null ? "none" : String(frame.header);
    const entry = byModule.get(key);
    if (entry) entry.payload.push(...frame.payload);
    else byModule.set(key, { moduleId: frame.header, payload: [...frame.payload] });
  }

  const readings: VinReading[] = [];
  for (const { moduleId, payload } of byModule.values()) {
    const runs = parseVinBlocks(payload, anchor);
    if (runs.length === 0) continue;
    const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length >= MIN_VIN_CHARS) {
      readings.push({
        vin: longest,
        moduleId,
        complete: longest.length >= VIN_LENGTH,
      });
    }
    // …and the runs joined, which is what a module that repeats the anchor
    // answers with: seventeen characters do not divide evenly by the three a
    // frame carries, so the last run is short and only the join is whole.
    const joined = runs.join("").slice(0, VIN_LENGTH);
    if (joined.length >= MIN_VIN_CHARS && joined.length > longest.length) {
      readings.push({
        vin: joined,
        moduleId,
        complete: joined.length >= VIN_LENGTH,
      });
    }
  }
  return readings.sort(
    (a, b) =>
      Number(b.complete) - Number(a.complete) ||
      b.vin.length - a.vin.length ||
      Number(isEngineModule(b.moduleId)) - Number(isEngineModule(a.moduleId)),
  );
}

/** {@link readingsFrom} behind mode 09's anchor. */
export function parseVinReadings(lines: string[]): VinReading[] {
  return readingsFrom(lines, VIN_ANCHOR);
}

/**
 * VIN (09 02). Returns the best reading — a complete VIN when any module
 * sent one, otherwise the longest fragment that reached at least three
 * characters. Null when the ECU never answered the PID at all, which is a
 * different fact from answering with a fragment.
 */
export function parseVin(lines: string[]): string | null {
  return parseVinReadings(lines)[0]?.vin ?? null;
}

export async function readVin(
  channel: Elm327Channel,
  timeoutMs = 6000,
): Promise<string | null> {
  return parseVin(await channel.command("0902", timeoutMs));
}

/** Positive response to KWP2000 service 1A, and the identifier for the VIN. */
const KWP_RESPONSE_1A = 0x5a;
const KWP_ID_VIN = 0x90;
const KWP_VIN_ANCHOR = [KWP_RESPONSE_1A, KWP_ID_VIN];

/**
 * VIN over the manufacturer's own service: KWP2000 `1A 90` (ReadECU
 * Identification, identifier 0x90) answers `5A 90` followed by the seventeen
 * characters in ASCII.
 *
 * This exists because mode 09 PID 02 is not a VIN service on every car that
 * has a VIN. EOBD required it only from the 2002 model year for petrol and
 * 2004 for diesel, and a car older than that answers `7F 09 12` — "this
 * sub-function is not supported" — while holding the same VIN behind the
 * maker's own read. That refusal is not a broken car and not a broken
 * adapter; it is a question asked in the wrong dialect, and the dialect is
 * well enough known to ask in the right one.
 *
 * The anchor is `5A 90`, and a run of characters behind it is read the way
 * the mode 09 parser reads a VIN: stop at the first byte a VIN cannot
 * contain. A trailing checksum, the next frame's header and the padding of a
 * short frame all end the run by themselves.
 *
 * What mode 09's reader adds on top — and what this needs just as much — is
 * that the seventeen characters do not fit in one frame. A KWP2000 frame
 * carries at most seven data bytes, so `5A 90` plus **five** characters is a
 * whole frame, and the remaining twelve arrive in the frames after it. The
 * first version of this returned the first run of three or more characters
 * and stopped, which on a real car produced `B3338` — five characters, the
 * exact payload of frame one — and a car identified as Unknown. The reading
 * therefore goes through the same machinery as mode 09, which knows both
 * ways a multi-frame answer is laid out: the anchor repeated on every frame
 * (joined run by run) and sent once with the rest streamed behind it.
 */
export function parseKwpVin(lines: string[]): string | null {
  return readingsFrom(lines, KWP_VIN_ANCHOR)[0]?.vin ?? null;
}

export async function readKwpVin(
  channel: Elm327Channel,
  timeoutMs = 6000,
): Promise<string | null> {
  return parseKwpVin(await channel.command("1A 90", timeoutMs));
}

/** Two hex digits, upper case — the spelling every ELM327 command uses. */
export function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

export type FragmentStitch = {
  /** The longest run the answers agree on. */
  vin: string;
  /** Every fragment the repeats produced, in the order they arrived. */
  fragments: string[];
  /** True when no attempt went further than the first — the ECU repeating
   *  itself rather than the read losing frames. */
  stable: boolean;
};

/**
 * One VIN request asked several times → the longest run its answers agree on.
 *
 * This is the answer to the question one reading cannot settle. A KWP2000
 * `1A 90` reply is a multi-frame answer, and what arrives is however many
 * frames the adapter was still willing to wait for — on the measured 2004 car,
 * five characters, exactly one frame's payload. Two readings of the same car
 * then mean two different things:
 *
 *   - every attempt returns the same characters → the identifier really holds
 *     that much text, and the rest of the VIN is under some other option.
 *     More repeats buy nothing, and `stable` is what says so.
 *   - the attempts differ → characters were on their way and were dropped, so
 *     the request is not short, the *read* is, and the missing frames are
 *     worth going back for. `stable` is false and the longest attempt wins.
 *
 * Growth is only accepted along a prefix: an answer that starts with the
 * previous one is the same answer with more of it, which is what a lost tail
 * looks like. Two answers that neither repeat nor extend each other are a
 * misread on one side, and nothing here can tell which — the longer one is
 * kept because it carries more of the answer, and `stable` stays false so the
 * caller treats it as the uncertain thing it is.
 */
export function stitchFragments(fragments: string[]): FragmentStitch {
  let best = "";
  let grew = false;
  let diverged = false;
  for (const fragment of fragments) {
    if (!fragment) continue;
    if (!best) {
      best = fragment;
      continue;
    }
    if (fragment === best || best.startsWith(fragment)) continue;
    if (fragment.startsWith(best)) {
      best = fragment;
      grew = true;
      continue;
    }
    diverged = true;
    if (fragment.length > best.length) best = fragment;
  }
  return { vin: best, fragments: [...fragments], stable: !grew && !diverged };
}

export type OptionFragment = {
  /** The identification option the fragment came from, e.g. 0x88. */
  option: number;
  text: string;
};

/**
 * A VIN whose characters arrived under *neighbouring* identification options.
 *
 * The shape this exists for: an option's answer is cut off mid-message, and
 * the rest of it is still in flight when the next request goes out — so it is
 * read as that request's answer and lands under the next option. The tail is
 * therefore always one option up from its head.
 *
 * Three rules keep it from inventing a VIN out of unrelated identifiers:
 * the fragments must be **consecutive** options, a gap ends the chain (option
 * 0x88 and 0x8A are two different records, and joining them is a guess), and
 * only a chain that comes to exactly {@link VIN_LENGTH} characters is
 * accepted. Anything else is returned as null — a nineteen-character chain is
 * not "nearly a VIN", it is two records that happen to sit next to each other.
 */
export function stitchAdjacentOptions(
  entries: OptionFragment[],
): { vin: string; from: string } | null {
  const sorted = [...entries].sort((a, b) => a.option - b.option);
  for (let i = 0; i < sorted.length; i++) {
    let text = sorted[i].text;
    if (text.length === VIN_LENGTH) {
      return { vin: text, from: `1A ${hex2(sorted[i].option)}` };
    }
    for (let j = i + 1; j < sorted.length; j++) {
      // Consecutive or nothing: a missing option in between means the chain
      // is not one answer continued.
      if (sorted[j].option !== sorted[j - 1].option + 1) break;
      text += sorted[j].text;
      if (text.length > VIN_LENGTH) break;
      if (text.length === VIN_LENGTH) {
        return {
          vin: text,
          from: `1A ${hex2(sorted[i].option)}-${hex2(sorted[j].option)}`,
        };
      }
    }
  }
  return null;
}

/**
 * The ECU identification block: KWP2000 service 1A, options 0x80–0x9F.
 *
 * Option 0x90 is the VIN by ISO 14230-4 — but that is the standard's choice,
 * and the car this was written for does not follow it: it answers `1A 90` with
 * five characters and `0902` with `7F 09 12`, so a whole VIN, if the bus
 * carries one at all, sits behind one of the neighbouring options. Which
 * option holds what is the maker's own table, so the block is swept rather
 * than guessed at — and every option that answers with text is kept on the
 * record, because a part number or a supplier name names the ECU even when no
 * VIN ever turns up.
 */
const ID_BLOCK_FIRST = 0x80;
const ID_BLOCK_LAST = 0x9f;

/** Ceiling for one option. An option the ECU does not have is refused in
 *  milliseconds; this only bounds one that answers nothing at all. */
const ID_BLOCK_READ_MS = 700;

/** Ceiling for the whole sweep. A silent bus costs this and no more — a
 *  connect that already waits twenty seconds must not wait two minutes. */
const ID_BLOCK_TOTAL_MS = 12_000;


/**
 * How many options in a row may come back with nothing at all before the
 * sweep gives up.
 *
 * A bus that has stopped answering does not stop for one option and start
 * again for the next: four silent options in a row is a dead bus, and the
 * twenty-eight after them cost seven more seconds of a driver's time to
 * confirm it. Only *silence* counts — an option the ECU refuses is answered in
 * milliseconds and is the normal way a sweep ends.
 */
const ID_BLOCK_SILENT_STREAK = 4;

export type IdBlockSweep = {
  /** The first whole VIN an option produced, and the option it came from —
   *  either from one option or from a chain of neighbouring ones. */
  vin: string | null;
  vinFrom: string | null;
  /** How many options were asked, and how many answered with text. */
  probed: number;
  answered: number;
  /** Options that replied but held no text — `7F 1A 11` and the like. The
   *  ECU saying "not this one", in milliseconds. */
  refused: number;
  /** Options nothing came back for at all before the read timed out. */
  silent: number;
  /** True when the sweep stopped early because the bus had gone quiet. */
  abandoned: boolean;
};

/**
 * Ask every identification option and keep the ones that answered.
 *
 * Stops at the first whole VIN: seventeen characters are the VIN, the options
 * after it are somebody else's business, and every extra request is traffic on
 * a bus this app is a guest on.
 *
 * Reads go to a scratch list first. Thirty-two rows of "option not supported"
 * would push the reads that did answer off the evidence screen, which is the
 * only place the answer to "why is this car unknown" can be read.
 *
 * The three ways a sweep finds nothing are kept apart, because they call for
 * three different next steps and used to look identical on the report —
 * `0 of 32 options answered` whether the ECU had refused every one of them in
 * milliseconds or the bus had died after the first:
 *
 *   - `refused` — the ECU answered and had nothing under that option. The
 *     sweep worked and the car has no more to say.
 *   - `silent` — nothing came back at all. The bus, not the option.
 *   - `abandoned` — enough of the second in a row to stop asking.
 */
export async function sweepIdentificationBlock(
  elm: Elm327Channel,
  reads: Coverage[],
  transcript: string[],
  timeoutMs: number,
  /** An option the VIN fallback already asked. Its answer is on the record,
   *  and asking twice puts the same line on the screen twice. */
  alreadyAsked: number | null = null,
): Promise<IdBlockSweep> {
  // The sweep gets no retry budget: a car that ignores one option ignores the
  // next one too, and thirty-two repeats is not a budget anyone agreed to.
  const noRetries = { left: 0 };
  const deadline = Date.now() + ID_BLOCK_TOTAL_MS;
  const budget = Math.min(timeoutMs, ID_BLOCK_READ_MS);
  let vin: string | null = null;
  let vinFrom: string | null = null;
  let probed = 0;
  let answered = 0;
  let refused = 0;
  let silent = 0;
  let abandoned = false;
  let streak = 0;
  /** What each answering option returned, for the neighbouring-option chain. */
  const fragments: OptionFragment[] = [];

  for (let option = ID_BLOCK_FIRST; option <= ID_BLOCK_LAST; option += 1) {
    if (option === alreadyAsked) continue;
    if (Date.now() > deadline) break;
    const hex = hex2(option);
    const request = `1A ${hex}`;
    probed += 1;

    const scratch: Coverage[] = [];
    const found = await readRecorded(
      scratch,
      transcript,
      elm,
      request,
      `ID ${hex}`,
      budget,
      (lines) => readingsFrom(lines, [KWP_RESPONSE_1A, option]),
      (v) => v.length === 0,
      noRetries,
    );
    if (!found || found.length === 0) {
      // Nothing to keep. Which nothing it was is read off the row the read
      // recorded: `raw` holds the adapter's own lines, so an empty one means
      // the request timed out unanswered — a refusal (`NO DATA`, `7F 1A 11`)
      // always prints something.
      if ((scratch[0]?.raw?.length ?? 0) === 0) {
        silent += 1;
        streak += 1;
        if (streak >= ID_BLOCK_SILENT_STREAK) {
          abandoned = true;
          break;
        }
      } else {
        refused += 1;
        streak = 0;
      }
      continue;
    }

    streak = 0;
    answered += 1;
    reads.push(scratch[0]);
    const best = found[0];
    if (best.complete) {
      vin = best.vin;
      vinFrom = request;
      break;
    }
    fragments.push({ option, text: best.vin });
  }

  // Nothing whole under one option — but a cut-off answer whose tail arrived
  // as the *next* option's reply is only visible across options, never within
  // one. See `stitchAdjacentOptions` for why the chain has to be exact.
  if (vin === null) {
    const chained = stitchAdjacentOptions(fragments);
    if (chained) {
      vin = chained.vin;
      vinFrom = chained.from;
    }
  }

  return { vin, vinFrom, probed, answered, refused, silent, abandoned };
}

/** Calibration ID (09 04): one or more ASCII CALIDs in sixteen-byte fields.
 *
 *  The fields are cut on a fixed sixteen-byte stride rather than on the
 *  reply's own count, which is not a count on every car (see
 *  {@link mode49Payload}). The stride is what the spec fixes, and a field
 *  whose tail is padding decodes to the same string either way — the real
 *  `0904` above is one field of `37 35 33 39 30 37 33 00 …`, which reads as
 *  `7539073` whichever byte told us where the field ended. */
export function parseCalid(lines: string[]): string[] {
  const data = mode49Payload(lines, 0x04);
  const ids: string[] = [];
  for (let i = 0; i < data.length; i += CALID_FIELD) {
    const id = ascii(data.slice(i, i + CALID_FIELD)).trim();
    if (id) ids.push(id);
  }
  return ids;
}

export async function readCalid(channel: Elm327Channel): Promise<string[]> {
  return parseCalid(await channel.command("0904", 6000));
}

/** ECU name (09 0A): one ASCII string of up to 20 characters, null-padded,
 *  behind the counter byte every `49 <pid>` reply opens with. */
export function parseEcuName(lines: string[]): string | null {
  return ascii(mode49Payload(lines, 0x0a)).trim() || null;
}

export async function readEcuName(
  channel: Elm327Channel,
): Promise<string | null> {
  return parseEcuName(await channel.command("090A", 6000));
}

/**
 * ELM327 handshake over any transport channel (BLE or classic): ATZ reset
 * with retries, ATE0 (echo off), ATI identification. Throws
 * OdbConnectError when the device does not answer — that is how we tell
 * the adapter apart from other Bluetooth devices.
 */
export async function elm327Handshake(
  elm: Elm327Channel,
): Promise<AdapterInfo> {
  // Freshly-powered clones often miss the first command — retry ATZ a
  // few times with a short gap before declaring it unresponsive.
  let reset: string[] = [];
  // What each attempt actually got back. "Did not answer" on its own is
  // the least diagnostic sentence in the app, and this is the one moment
  // the adapter's raw behaviour is still observable — a write that the
  // stack rejected reads very differently from a silent 6-second wait.
  const reasons: string[] = [];
  for (let attempt = 0; attempt < 3 && reset.length === 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
    try {
      reset = await elm.command("ATZ", 6000);
      if (reset.length === 0) reasons.push("no reply");
    } catch (err) {
      reset = [];
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (reset.length === 0) {
    // One line of detail, deduplicated: three identical timeouts are one
    // fact, not three. Truncated so a wall of hex cannot fill the screen.
    const detail = [...new Set(reasons)].join("; ").slice(0, 200);
    throw new OdbConnectError(
      "handshake",
      `The device did not answer as an ELM327 OBD adapter. (${detail})`,
    );
  }

  // Echo off; from here responses are clean single lines.
  try {
    await elm.command("ATE0", 2000);
  } catch {
    // Not fatal — clones differ.
  }

  let idLines: string[] = [];
  try {
    idLines = await elm.command("ATI", 3000);
  } catch {
    // Identification is best-effort.
  }
  return { adapterId: idLines.length > 0 ? idLines.join(" / ") : null };
}

/** How many connect-time lines the transcript keeps. Same cap as the scan's
 *  own: enough for the whole handshake on any car, small enough to paste. */
const RAW_LINE_CAP = 400;

/**
 * How many of a read's own lines are kept next to it.
 *
 * A VIN answer is up to six lines of ISO-TP or a handful of KWP2000 frames,
 * and the question these lines exist to answer — what did this request
 * actually return — is settled by the first few. The cap is what stops a
 * clone that answers a rejected request with an endless hex dump from
 * pushing the interesting read off the screen.
 *
 * Eight was too few to read a calibration record off. `0904` on the car of
 * 2026-09-17 answered sixteen frames; the screen kept eight, and the half
 * that was dropped is the half that says where one CALID field ends — the
 * parsed values came out shifted and there was no way to see by how much.
 * Thirty-two is four times the longest reply this car has produced and still
 * short of a hex dump. The screen shows them collapsed, so the cost of the
 * extra lines is paid only by whoever opens them.
 */
const READ_RAW_CAP = 32;

/**
 * One connect-time read: send it, keep the reply, record what happened.
 *
 * The recording is the point. Every read here is best-effort, and the old
 * shape of best-effort — an empty catch around a call whose empty answer was
 * swallowed too — made four different situations identical on the vehicle
 * screen: the ECU answered `NO DATA`, the adapter answered `UNABLE TO
 * CONNECT`, the reply arrived unparseable, or nothing came back before the
 * timeout. All four showed a dash, and the warning under them guessed at one.
 * This is the same vocabulary the scan already uses for its own reads, so a
 * car that scans fine and identifies not at all can finally say which of the
 * four it is.
 */
async function readRecorded<T>(
  reads: Coverage[],
  transcript: string[],
  elm: Elm327Channel,
  request: string,
  label: string,
  timeoutMs: number,
  parse: (lines: string[]) => T,
  isEmpty: (value: T) => boolean,
  /** How many extra commands this connect may spend on answers that never
   *  came. Shared across the reads, and decremented by whoever spends one. */
  retries: { left: number },
): Promise<T | null> {
  const attempt = async (): Promise<{ lines: string[]; value: T | null; failure: string | null }> => {
    let lines: string[] = [];
    let failure: string | null = null;
    try {
      lines = await elm.command(request, timeoutMs);
    } catch (err) {
      failure = describeError(err);
    }
    for (const line of lines) {
      if (transcript.length < RAW_LINE_CAP) transcript.push(line);
    }
    const parsed = failure ? null : parse(lines);
    return { lines, value: parsed !== null && !isEmpty(parsed) ? parsed : null, failure };
  };

  let result = await attempt();
  // Ask again when nobody answered. One bad moment — a frame lost, an answer
  // that arrived after the channel had given up on it — costs a read that a
  // single repeat gets back, and the channel now drains the abandoned answer
  // before the repeat goes out, so the repeat cannot inherit it.
  //
  // One retry for the whole connect, not one per read: after the drain the
  // channel is in step again, so a second silence is a car that is not
  // talking, and five more waits would buy nothing. A car with the ignition
  // off must not turn a 23-second connect into a 46-second one.
  if (result.value === null && retries.left > 0 && isNonAnswer(result.lines)) {
    retries.left -= 1;
    result = await attempt();
  }

  if (result.value !== null) {
    reads.push({ request, label, status: "ok", raw: capRaw(result.lines) });
    return result.value;
  }
  reads.push({
    request,
    label,
    // Headers are off here and the protocol is not yet known, so the scan's
    // parse options do not apply: `{}` is the same default the parsers above
    // use for a headerless reply.
    ...(result.failure
      ? { status: "error" as const, detail: result.failure }
      : emptyDetail(result.lines, {})),
    raw: capRaw(result.lines),
  });
  return null;
}

/** The first {@link READ_RAW_CAP} non-empty lines of a reply, trimmed. */
function capRaw(lines: string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (kept.length >= READ_RAW_CAP) {
      // Say that lines were dropped rather than ending on a reply that looks
      // complete: a truncated VIN answer and a short one read the same way.
      kept.push("…");
      break;
    }
    kept.push(t);
  }
  return kept;
}

/**
 * Every place a car keeps its VIN, in the order this app asks for it.
 *
 * These are dialects, not preferences: a 2004 K-line car and a 2015 CAN car
 * share no VIN request at all, and which of them answers is a property of the
 * car that cannot be seen before asking it. So the connect asks them in turn
 * and stops at the first *whole* VIN.
 *
 * A fragment does not stop it. That was a real trap: `0902` answering with
 * three or six characters used to end the search, and the car that answers a
 * fragment to one dialect is exactly the car whose other dialect holds the
 * rest of the VIN.
 *
 * `bus` is what keeps the cascade from being noise on somebody else's bus.
 * `1A` and `21` are KWP2000 services that do not exist on CAN, and `22 F1 90`
 * is a UDS request a K-line car cannot answer; either one asked on the wrong
 * bus costs a timeout and teaches nothing.
 */
type VinDialect = {
  request: string;
  label: string;
  /** The service and identifier that open a positive answer. The VIN
   *  characters follow it and {@link readingsFrom} finds them. */
  anchor: number[];
  bus: "any" | "legacy" | "can";
  /** A dialect nothing here has ever watched answer gets a shorter leash
   *  than the request this app was built around. */
  timeoutMs: number;
  /** Whether a short answer from this dialect identifies anything. `0902`
   *  and `1A 90` are measured — five characters off `1A 90` named a maker on
   *  the 2004 car, and that is the whole reason the fragment path exists. A
   *  dialect nobody here has seen answer has to arrive whole: its bytes are
   *  whatever the ECU keeps under that identifier, so a fragment of them is
   *  a guess wearing an identifier's name, and it could out-rank a real
   *  fragment from a dialect that was actually measured. */
  fragmentOk: boolean;
  /** Identification-block option this request already asks, so the sweep
   *  below does not put the same question to the car twice. */
  sweepOption?: number;
};

/**
 * How long the adapter waits for the ECU's answer, in ELM327 `ATST` units
 * (hh × 4 ms).
 *
 * Nothing in this app had ever set it, so every read ran on the clone's
 * factory 0x32 — 200 ms — and a KWP2000 answer is a *sequence* of frames, each
 * of which has to arrive inside that window. The 2004 car this was written for
 * answers `1A 90` with exactly one frame's worth of VIN (`B3338`, five
 * characters) and pads the rest of the frame; the same symptom is recorded on
 * ScanTool.net for the same bus, where ISO 14230-4 (KWP fast) "doesn't return
 * full VIN data" and only three or four of the expected five lines arrive.
 * A truncated multi-frame answer and a genuinely short one are the same bytes
 * to the parser, so the wait is the first thing to rule out.
 *
 * 0x64 is 400 ms: double the factory value, still inside P2 timing, and a
 * failed read pays it once per request rather than per retry. It is a
 * *ceiling* rather than a fixed wait, because adaptive timing is on — see
 * {@link slowDownReads} for why that is the mode it is left in.
 */
const ECU_REPLY_TIMEOUT = "64";

/** What `ATST` goes back to: the ELM327 factory default, 200 ms. Left as
 *  found, because a longer wait is a cost every later pass pays on a car that
 *  is answering nothing. */
const ECU_REPLY_TIMEOUT_DEFAULT = "32";

/** How many times the same VIN request may be asked before the answers stop
 *  telling us anything. Four: the first two settle whether the ECU is
 *  repeating itself, and the two after them are the frames that were on their
 *  way when the first read gave up. */
const VIN_REPEAT_ATTEMPTS = 4;

/** How many module addresses the addressed VIN read may try. The scan of a
 *  real car names two or three; every one of them is a request on a bus this
 *  app is a guest on. */
const MODULE_PROBE_LIMIT = 4;

const VIN_DIALECTS: VinDialect[] = [
  {
    // J1979, and mandatory on every car this app can be plugged into. It goes
    // first because it is the one request with a standard behind it.
    request: "0902",
    label: "VIN",
    anchor: VIN_ANCHOR,
    bus: "any",
    timeoutMs: 6000,
    fragmentOk: true,
  },
  {
    // The maker's own service: `0902` refusing with `7F 09 12` is the shape
    // this is for — a pre-2002 car, which is not required to answer mode 09
    // at all and answers `1A 90` happily.
    request: "1A 90",
    label: "VIN (KWP2000 1A 90)",
    anchor: KWP_VIN_ANCHOR,
    bus: "legacy",
    timeoutMs: 6000,
    fragmentOk: true,
    sweepOption: KWP_ID_VIN,
  },
  {
    // KWP2000's other reader. Some ECUs that refuse `1A 90` keep the VIN
    // under a local identifier instead of in the identification block, and
    // a local identifier is asked for with `21`, whose answer is `61`.
    request: "21 81",
    label: "VIN (KWP2000 21 81)",
    anchor: [0x61, 0x81],
    bus: "legacy",
    timeoutMs: 3000,
    fragmentOk: false,
  },
  {
    // UDS `ReadDataByIdentifier` on DID F190, which is the VIN identifier by
    // standard — the read a CAN car keeps even when its mode 09 answers are
    // short or absent.
    request: "22 F1 90",
    label: "VIN (UDS 22 F1 90)",
    anchor: [0x62, 0xf1, 0x90],
    bus: "can",
    timeoutMs: 3000,
    fragmentOk: false,
  },
];

/**
 * Keep an AT command's own lines in the transcript. The adapter-level knobs
 * below produce no coverage row of their own — they are not reads of the car —
 * but what the adapter answered them is still the adapter's own words, and the
 * debug surface is the only place they can be seen.
 */
function recordRaw(transcript: string[], lines: string[]): void {
  for (const line of lines) {
    if (transcript.length < RAW_LINE_CAP) transcript.push(line);
  }
}

/** Send an AT command whose answer is only worth the transcript. Null when
 *  nothing came back — the caller decides whether that is fatal. */
async function askQuiet(
  elm: Elm327Channel,
  transcript: string[],
  command: string,
  timeoutMs: number,
): Promise<string[] | null> {
  try {
    const lines = await elm.command(command, timeoutMs);
    recordRaw(transcript, lines);
    return lines;
  } catch {
    return null;
  }
}

/** A clone that does not know a command answers `?` rather than failing. */
function refusedCommand(lines: string[] | null): boolean {
  return lines !== null && lines.some((line) => line.trim() === "?");
}

/**
 * What came of asking for a longer wait. Three outcomes, because they are
 * three different facts about the adapter and the report has to say which:
 * the wait was raised, the clone does not implement the command, or the
 * adapter said nothing at all — which is the whole story of a dead session
 * and must not be filed under "not supported".
 */
type TimingResult = "raised" | "unsupported" | "silent";

/**
 * Ask the adapter to wait longer for the ECU, adaptive timing left in its
 * normal mode. Never fatal: a clone without `ATST` runs the reads below on
 * whatever timing it has, and the coverage line says so.
 *
 * `ATAT 1`, not the more aggressive `ATAT 2`, and that is the whole point of
 * the pair. With adaptive timing on, `ATST` is a *ceiling* — the algorithm may
 * pick a shorter wait than the one set here, it can never pick a longer one —
 * so the raised ceiling only helps if the adapter does not talk itself out of
 * using it. `ATAT 2` adapts faster and is documented as mattering most on very
 * slow connections, which is exactly the direction that hurts this car: it
 * answers the first frame of a KWP2000 reply quickly and then needs the
 * adapter to keep listening for the rest, and an aggressive learner reads that
 * quick first frame as "this ECU answers in 40 ms" and cuts the wait short.
 * Normal adaptive timing is the factory default and ELM's own recommendation,
 * and it is what every measured read here ran under; the new lever is the
 * ceiling, so the ceiling is the only thing this changes.
 */
async function slowDownReads(
  elm: Elm327Channel,
  transcript: string[],
): Promise<TimingResult> {
  const adaptive = await askQuiet(elm, transcript, "ATAT 1", 2000);
  const timeout = await askQuiet(
    elm,
    transcript,
    `ATST ${ECU_REPLY_TIMEOUT}`,
    2000,
  );
  if (refusedCommand(adaptive) || refusedCommand(timeout)) return "unsupported";
  if (adaptive === null || timeout === null) return "silent";
  return "raised";
}

/** Put the adapter's wait back where it was found. */
async function restoreReadTiming(
  elm: Elm327Channel,
  transcript: string[],
): Promise<void> {
  await askQuiet(elm, transcript, "ATAT 1", 2000);
  await askQuiet(elm, transcript, `ATST ${ECU_REPLY_TIMEOUT_DEFAULT}`, 2000);
}

/**
 * The adapter naming the bus as the fault, rather than the car.
 *
 * `BUS BUSY` is the line held — a clone stuck mid-init or a bus nobody is
 * driving — and `BUS ERROR` a framing failure on the wire. Both are printed
 * by the adapter about itself, and neither is about which dialect the car
 * speaks, which is why nothing in {@link FORCED_PROTOCOLS} can clear them.
 * `BUS INIT: ...ERROR` is deliberately not matched: that one *is* about the
 * init the protocol choice decides.
 */
const BUS_FAULT = /\bbus (busy|error)\b/i;

/**
 * Reset the adapter itself — the last step of a recovery that has run out of
 * things to say about the car.
 *
 * Everything above this is a statement about the bus: the wrong protocol, a
 * slow ECU, a module that keeps quiet. `ATZ` is a statement about the adapter,
 * and the only command that makes one: a clone wedged mid-init, or holding a
 * line it will not let go of, clears its own state and inits the bus afresh on
 * the next request. Re-pinning a protocol asks a stuck adapter to speak a
 * different dialect, which it cannot do while it cannot transmit at all.
 *
 * The price is that `ATZ` clears everything, so what the pass set up before it
 * has to go back out — and `ATE0` above all, because echo returns with the
 * reset and an echoed command reads as a reply. If the adapter does not answer
 * even that, it is mute rather than stuck, and a retry pass would be parsing
 * its own commands back as data: the reset reports failure and nothing more is
 * asked of it.
 */
async function hardResetAdapter(
  elm: Elm327Channel,
  transcript: string[],
): Promise<{ ok: boolean; detail: string }> {
  const reset = await askQuiet(elm, transcript, "ATZ", 8000);
  if (reset === null) {
    return {
      ok: false,
      detail: "the adapter did not answer its own reset — nothing left to retry on",
    };
  }
  // A reset answers with the adapter's own name, and it happens without the
  // bus being involved at all. A bus fault coming back instead means the state
  // that produced it survived the command that exists to clear it.
  if (reset.some((line) => BUS_FAULT.test(line))) {
    return {
      ok: false,
      detail: "the adapter answered its own reset with a bus fault — the line is held, not the adapter",
    };
  }
  const echo = await askQuiet(elm, transcript, "ATE0", 2000);
  if (echo === null) {
    return {
      ok: false,
      detail: "the adapter reset but then stopped answering — a retry would read its own commands back as data",
    };
  }
  // Back to the multi-frame setting this pass opened with. Off by default
  // after a reset, and a VIN that arrives in frames is the one read here that
  // notices.
  await askQuiet(elm, transcript, "ATAL", 2000);
  return {
    ok: true,
    detail: "the bus stayed silent, so the adapter itself was reset",
  };
}

/**
 * The VIN read that names its module, for the car whose engine controller
 * does not answer the functional request.
 *
 * A functional `1A 90` is heard by every module on the bus at once, and a
 * multi-frame answer from two of them interleaves into one reply the parser
 * can only read runs out of — the measured car has two controllers (`0x12`
 * and `0x18`) and answered the functional request with a single frame's worth
 * of VIN. Addressing one module at a time asks each of them the same question
 * with nothing to interleave with, and the scan that ran before this has
 * already named which modules are there.
 *
 * Only a **named** KWP2000 bus: the header below is ISO 14230's three-byte
 * one, and on ISO 9141-2 or a bus the adapter never named its shape is a
 * different guess. The header is restored before returning — every other
 * request in this app assumes the adapter's own functional header, and a
 * stale physical address would silently turn the next scan into a scan of one
 * module.
 */
export async function readVinFromModules(
  elm: Elm327Channel,
  reads: Coverage[],
  transcript: string[],
  addresses: number[],
  protocolCode: string | null,
  timeoutMs: number,
  retries: { left: number },
): Promise<{ vin: string; from: string } | null> {
  if (protocolCode !== "4" && protocolCode !== "5") return null;
  const targets = [...new Set(addresses)]
    .filter((address) => address > 0 && address <= 0xff)
    .slice(0, MODULE_PROBE_LIMIT);
  if (targets.length === 0) return null;

  let found: { vin: string; from: string } | null = null;
  let addressed = false;
  try {
    for (const address of targets) {
      // ISO 14230 header: format, target, source. `80` is physical
      // addressing, the module is the *target* and `F1` is this tool —
      // replies come back the other way round (`F1 <module>`), which is the
      // layout `readLineFrame` reads them by.
      const header = await askQuiet(
        elm,
        transcript,
        `AT SH 80 ${hex2(address)} F1`,
        2000,
      );
      if (refusedCommand(header)) break;
      addressed = true;
      const answer = await readRecorded(
        reads,
        transcript,
        elm,
        "1A 90",
        `VIN (KWP2000 1A 90 → 0x${hex2(address)})`,
        timeoutMs,
        (lines) => readingsFrom(lines, KWP_VIN_ANCHOR)[0]?.vin ?? null,
        (v) => v.length === 0,
        retries,
      );
      if (answer === null) continue;
      if (found === null || answer.length > found.vin.length) {
        found = { vin: answer, from: `1A 90 @0x${hex2(address)}` };
      }
      if (isFullVin(answer)) break;
    }
  } finally {
    // Functional addressing is what a scan wants: it asks the whole bus.
    if (addressed) await askQuiet(elm, transcript, "AT SH 81 F1 F1", 2000);
  }
  return found;
}

/**
 * The protocols a dead bus is retried under, in the order they are tried.
 *
 * `ATSP0` — the auto search every other read in this app runs under — walks
 * the bus looking for a signal, and on a car whose ECU is slow to come up it
 * can settle on nothing and report `UNABLE TO CONNECT` for every request.
 * Pinning the protocol skips the search and speaks the dialect directly. The
 * order is the order of likelihood on a car old enough to need this: KWP2000
 * fast init first, then its 5-baud sibling's ancestor ISO 9141-2.
 */
const FORCED_PROTOCOLS: { command: string; name: string }[] = [
  { command: "ATSP5", name: "KWP2000 fast init" },
  { command: "ATSP3", name: "ISO 9141-2" },
];

/**
 * One VIN dialect, asked as many times as its answers keep changing.
 *
 * The first read is the one that counts and the only one with a coverage row
 * of its own. What the repeats are for is the question one read cannot answer:
 * a five-character reply is either the whole of what the ECU keeps under that
 * identifier or the first frame of a longer one, and nothing in those five
 * bytes says which. Asking again does — see {@link stitchFragments}.
 *
 * Only dialects whose short answers are measured get repeats, and only when
 * the first read came back short of seventeen. A whole VIN, a refusal and a
 * silent bus all end here on the first read, so the common case pays nothing.
 */
async function readVinRepeatedly(
  elm: Elm327Channel,
  reads: Coverage[],
  transcript: string[],
  dialect: VinDialect,
  timeoutMs: number,
  retries: { left: number },
): Promise<string | null> {
  const parse = (lines: string[]) =>
    readingsFrom(lines, dialect.anchor)[0]?.vin ?? null;
  const blank = (v: string | null) => v === null || v.length === 0;

  const first = await readRecorded(
    reads, transcript, elm, dialect.request, dialect.label, timeoutMs,
    parse, blank, retries,
  );
  const row = reads[reads.length - 1];
  if (first === null || isFullVin(first)) return first;
  // A dialect nobody here has watched answer has to arrive whole: repeating
  // it would only produce more of whatever its bytes are — see `fragmentOk`.
  if (!dialect.fragmentOk) return first;

  const fragments = [first];
  let asked = 1;
  while (asked < VIN_REPEAT_ATTEMPTS) {
    // The repeat's own row is discarded: five rows named `1A 90` would push
    // the reads that did answer off the evidence screen, and its lines are in
    // the transcript either way. Its retry budget is zero for the same reason
    // the sweep's is — a repeat that is not answered is an answer.
    const again = await readRecorded(
      [], transcript, elm, dialect.request, dialect.label, timeoutMs,
      parse, blank, { left: 0 },
    );
    asked += 1;
    if (again === null) break;
    fragments.push(again);
    const stitch = stitchFragments(fragments);
    if (isFullVin(stitch.vin) || stitch.stable) break;
  }

  // What the repeats settled, on the row the first read already wrote. This
  // sentence is the whole point of asking four times: `5 of 17 characters`
  // reads as a car with a short VIN, and the difference between that and a
  // read that stopped listening is not visible anywhere else on the screen.
  const stitch = stitchFragments(fragments);
  if (row && asked > 1) {
    const n = stitch.vin.length;
    if (isFullVin(stitch.vin)) {
      row.detail = `stitched from ${asked} reads — no single one carried all ${VIN_LENGTH} characters`;
    } else if (stitch.stable) {
      row.detail = `the ECU repeated the same ${n} characters on all ${asked} reads — the answer is not being cut short`;
    } else {
      row.detail = `${asked} reads returned up to ${n} of ${VIN_LENGTH} characters and did not agree — frames were being lost`;
    }
  }
  return stitch.vin.length > 0 ? stitch.vin : first;
}

/** What one run of the connect's read sequence produced. */
type ConnectPass = {
  protocol: string | null;
  protocolCode: string | null;
  calid: string[] | null;
  ecuName: string | null;
  mileage: number | null;
  best: { vin: string; from: string } | null;
  /** True when the *car* — not the adapter — answered at least one request.
   *  `ATDPN` does not count: a dead bus answers it perfectly. */
  heardAnything: boolean;
};

/** Best-effort vehicle reads shared by both transports: mode 09 (VIN,
 *  CALID, ECU name) plus the mode 01 odometer, which the dashboard needs
 *  at connect time rather than at scan time.
 *
 *  Every read records its outcome in `reads` and its reply in `rawLines`,
 *  because "the car could not be identified" and "the adapter said nothing at
 *  all" are different problems and the vehicle screen has to be able to tell
 *  them apart. */
export async function readVehicleInfoOver(
  elm: Elm327Channel,
  timeoutMs?: number,
  opts: VehicleInfoOptions = {},
): Promise<VehicleInfo> {
  /** Per-read ceiling. Tests drive it to milliseconds; production leaves it
   *  unset and each read keeps the timeout its own command needs. */
  const ms = (own: number) => (timeoutMs ? Math.min(own, timeoutMs) : own);
  // Ask the adapter to join multi-frame replies into one line; the
  // parser handles multi-line responses anyway, so a "?" is harmless.
  try {
    await elm.command("ATAL", 2000);
  } catch {
    // Clone doesn't support ATAL — multi-line parsing takes over.
  }

  // Every read is best-effort: one unsupported PID must not lose the rest.
  //
  // Nothing is sent here that the car did not ask for. A throwaway `0100` used
  // to sit in front of `ATDPN` as a "wake" — on the theory that a just-reset
  // adapter answers `AUTO` because it has not carried a message yet — and the
  // first build carrying it read nothing at all from a car that had answered
  // minutes earlier on the same adapter. The theory was never measured: on the
  // run where every read worked, `ATDPN` answered on the first try with no
  // wake, which is the opposite of what the theory predicts. Extra traffic on
  // a bus this app is a guest on is the thing that costs, so the wake is gone
  // and `Protocol: —` is simply what an adapter that cannot name its protocol
  // reports.
  const reads: Coverage[] = [];
  const rawLines: string[] = [];
  const none = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0);
  // One repeat for the whole connect, spent by the first read that gets no
  // answer at all (see `readRecorded`). Shared across passes: a protocol that
  // had to be forced does not get a fresh budget on top of the one the auto
  // search already spent.
  const retries = { left: 1 };

  /** Everything the connect asks the car, in order. A function rather than a
   *  straight line because the whole sequence is run again under a forced
   *  protocol when the first run heard nothing at all — see the retry below.
   *  Both runs append to the same `reads` and `rawLines`, so the report shows
   *  what each of them got. */
  const askEverything = async (): Promise<ConnectPass> => {
    // The protocol *code*, kept alongside the name it is reported as: the
    // KWP2000 VIN fallback below is a question worth asking only on a bus
    // where the service exists, and the name is the wrong thing to branch on.
    let protocolCode: string | null = null;
    const protocol = await readRecorded(
      reads, rawLines, elm, "ATDPN", "Protocol", ms(2000),
      (lines) => {
        protocolCode = detectProtocolCode(lines);
        return parseProtocol(lines);
      },
      none, retries,
    );

    // Longer waits before the first VIN request, not after: the frames a
    // short answer is missing are lost *during* the read, so a timeout raised
    // afterwards can only help the repeats. Recorded as a read of its own
    // because it is the difference between "the ECU holds five characters"
    // and "the adapter stopped listening after five", and nothing else on the
    // evidence screen says which of the two happened.
    const timing = await slowDownReads(elm, rawLines);
    reads.push({
      request: `ATST ${ECU_REPLY_TIMEOUT}`,
      label: "Read timing",
      // Silence is an error, not a missing feature. A clone that answers `?`
      // does not implement the command; an adapter that says nothing at all
      // has told us nothing about what it implements — and on this screen
      // that distinction is the difference between "this dongle is cheap" and
      // "this dongle is not talking", with every read below failing for the
      // second reason and the first one written over the top of it.
      status:
        timing === "raised"
          ? "ok"
          : timing === "unsupported"
            ? "unsupported"
            : "error",
      detail:
        timing === "raised"
          ? `${parseInt(ECU_REPLY_TIMEOUT, 16) * 4} ms per reply, adaptive timing on`
          : timing === "unsupported"
            ? "the adapter does not implement ATST/ATAT — the reads below run on its own timing"
            : `no answer to ATAT or ATST ${ECU_REPLY_TIMEOUT} before the timeout`,
    });

    // Which dialects are worth a request at all. An unnamed protocol counts as
    // legacy deliberately: a car whose adapter never named its bus is exactly
    // the car most likely to need the maker's own service, and refusing to ask
    // there would spend the one command that could identify it on tidiness.
    //
    // The two sets are not complements, and the difference is J1850 (`1`/`2`):
    // it is not CAN, so the UDS read is wrong there, and it is not KWP2000
    // either, so `1A`/`21` are wrong too. A bus in neither set is asked for the
    // VIN the standard way and nothing else.
    const legacyBus =
      protocolCode === null ||
      protocolCode === "3" ||
      protocolCode === "4" ||
      protocolCode === "5";
    const canBus =
      protocolCode === "6" ||
      protocolCode === "7" ||
      protocolCode === "8" ||
      protocolCode === "9";

    const candidates: { vin: string; from: string }[] = [];
    /** Identification option a dialect above already asked, if any. */
    let sweepSkip: number | null = null;
    for (const dialect of VIN_DIALECTS) {
      // A whole VIN ends it. The remaining dialects describe the same car, and
      // every one of them is a request on a bus this app is a guest on.
      if (candidates.some((c) => isFullVin(c.vin))) break;
      if (dialect.bus === "legacy" && !legacyBus) continue;
      if (dialect.bus === "can" && !canBus) continue;
      // Recorded before the read, not after: the sweep has to skip this option
      // because it was asked, whether or not the car answered it.
      if (dialect.sweepOption !== undefined) sweepSkip = dialect.sweepOption;
      const found = await readVinRepeatedly(
        elm, reads, rawLines, dialect, ms(dialect.timeoutMs), retries,
      );
      // A fragment from an unseen dialect is not a shorter answer, it is no
      // answer — see `fragmentOk`.
      if (found !== null && (dialect.fragmentOk || isFullVin(found))) {
        candidates.push({ vin: found, from: dialect.request });
      }
    }

    const calid = await readRecorded(
      reads, rawLines, elm, "0904", "CALID", ms(6000), parseCalid, none, retries,
    );
    const ecuName = await readRecorded(
      reads, rawLines, elm, "090A", "ECU name", ms(6000), parseEcuName, none, retries,
    );
    // Odometer (mode 01 PID A6) — a different mode, but this is the one place
    // both transports already do their connect-time reads, and the dashboard
    // wants the real figure before any scan runs.
    const mileage = await readRecorded(
      reads, rawLines, elm, "01A6", "Odometer", ms(3000), parseOdometer, none, retries,
    );

    // A fragment is not an identification, and five characters is the shape
    // this sweep exists for: `1A 90` answering with one KWP2000 frame's worth
    // of VIN leaves whatever else the car knows under the neighbouring
    // options. Asked only where the service exists, and only when the car is
    // talking at all — on a silent bus thirty-two requests buy nothing and
    // cost twelve seconds.
    //
    // Last of the connect's reads, not first: the sweep is the one read here
    // that can spend twelve seconds, and the CALID, the ECU name and the
    // odometer must be on the record before it starts.
    //
    // And the sweep only runs when the caller asked for it: twelve seconds of
    // probing on an unknown ECU belongs after the codes are in hand, never
    // before them. See `VehicleInfoOptions.sweepIdentification`.
    const heardCar =
      reads.some((r) => r.request !== "ATDPN" && r.status === "ok") ||
      reads.some((r) => r.request !== "ATDPN" && r.status === "unsupported");
    const sweep =
      opts.sweepIdentification === true &&
      !candidates.some((c) => isFullVin(c.vin)) &&
      legacyBus &&
      heardCar
        ? await sweepIdentificationBlock(
            elm, reads, rawLines, ms(ID_BLOCK_READ_MS),
            // Only skipped when one of the dialects above already asked it.
            sweepSkip,
          )
        : null;

    // One line for the whole sweep. Its findings are above it as their own
    // reads; this says how far the sweep got, which is the difference between
    // a car with nothing to say, a bus that stopped talking, and a sweep that
    // ran out of time — three outcomes that all used to read `0 of N`.
    if (sweep !== null) {
      const parts = [`${sweep.answered} of ${sweep.probed} options answered`];
      if (sweep.refused > 0) parts.push(`${sweep.refused} refused`);
      if (sweep.silent > 0) parts.push(`${sweep.silent} unanswered`);
      const detail = sweep.abandoned
        ? `${parts.join(", ")} — the bus stopped answering, so the sweep was cut short`
        : parts.join(", ");
      reads.push({
        request: "1A 80-9F",
        label: "Identification sweep",
        status: sweep.answered > 0 ? "ok" : "empty",
        detail,
      });
    }

    // A whole VIN beats a fragment and the longest fragment beats the
    // shortest: a sweep that found the rest of the VIN must not lose to the
    // five characters that sent it looking. The dialects' own answers are
    // already in `candidates`, in the order they were asked.
    if (sweep !== null && sweep.vin !== null && sweep.vinFrom !== null) {
      candidates.push({ vin: sweep.vin, from: sweep.vinFrom });
    }

    // The question the functional request cannot ask: which *module* holds the
    // VIN. Asked only of the addresses a scan has already seen, so it costs
    // nothing on a car that never ran one.
    if (!candidates.some((c) => isFullVin(c.vin)) && (opts.moduleAddresses?.length ?? 0) > 0) {
      const addressed = await readVinFromModules(
        elm, reads, rawLines, opts.moduleAddresses ?? [], protocolCode,
        ms(6000), retries,
      );
      if (addressed !== null) candidates.push(addressed);
    }

    // Did the bus survive everything above? One request the ECU answers on
    // every car, asked last so the answer describes the bus as the reads
    // leave it — a sweep that killed the connection and a sweep that found
    // nothing are the same empty result otherwise.
    if (sweep !== null) {
      const alive = await readRecorded(
        reads, rawLines, elm, "0101", "Bus health after sweep", ms(3000),
        parseStatus, none, retries,
      );
      const row = reads[reads.length - 1];
      if (row && row.request === "0101" && alive === null && row.status === "error") {
        row.detail = `${row.detail ?? ""} — the bus did not answer after the sweep`.trim();
      }
    }

    candidates.sort(
      (a, b) =>
        Number(isFullVin(b.vin)) - Number(isFullVin(a.vin)) ||
        b.vin.length - a.vin.length,
    );

    return {
      protocol,
      protocolCode,
      calid,
      ecuName,
      mileage,
      best: candidates[0] ?? null,
      // What the car said, not what the adapter was told. `ATDPN` names the
      // adapter's own protocol, a forced protocol is a command it accepted,
      // and both are rows this app wrote into `reads` itself — counting them
      // made this flag true on the very passes that exist because the bus had
      // said nothing, so the first pin ended the recovery it was meant to
      // start. Every request that reaches the car is a hex service, so the
      // `AT` prefix is the whole test.
      heardAnything: reads.some(
        (r) =>
          !r.request.toUpperCase().startsWith("AT") &&
          r.label !== "Read timing" &&
          (r.status === "ok" || r.status === "unsupported"),
      ),
    };
  };

  let pass: ConnectPass | null = null;

  try {
    pass = await askEverything();

    // Nothing at all came back. Before writing the car off, ask under a pinned
    // protocol: the auto search is the one part of this that can fail on its
    // own, and a car whose ECU is slow to wake answers `UNABLE TO CONNECT` to
    // the search and everything to a direct question.
    //
    // Only when the caller allowed the long read. This is three more passes
    // over a bus that has said nothing, and at connect time — before a single
    // fault code has been read — the driver is waiting on it. After the scan
    // the codes are already in hand and nothing else needs the bus.
    //
    // And only when the adapter itself is still talking. Pinning a protocol is
    // a statement about the bus; it does nothing for a dongle that answers no
    // command at all, and that case is not rare — it is what an unplugged or
    // half-seated adapter looks like. `raw` holds whatever the adapter printed
    // for each read, and a pass where every one of them is empty is the
    // adapter, not the car: two more full passes would spend two more minutes
    // asking a mute device to speak.
    //
    // Last, and for the adapter rather than the car: an adapter that says
    // `BUS BUSY` is not choosing the wrong dialect, it cannot transmit, and
    // only a reset of its own state clears that. It is skipped when the pins
    // would have been wasted on it, and it is the one step here that costs the
    // adapter its settings — see `hardResetAdapter`.
    const adapterMute = reads.every((r) => (r.raw?.length ?? 0) === 0);
    const busRefused = reads.some((r) =>
      (r.raw ?? []).some((line) => BUS_FAULT.test(line)),
    );
    if (opts.sweepIdentification === true && !pass.heardAnything && !adapterMute) {
      if (!busRefused) {
        for (const protocol of FORCED_PROTOCOLS) {
          const pinned = await askQuiet(elm, rawLines, protocol.command, 6000);
          if (refusedCommand(pinned)) continue;
          reads.push({
            request: protocol.command,
            label: "Protocol forced",
            status: "ok",
            detail: `${protocol.name} — the auto search had read nothing`,
          });
          const retry = await askEverything();
          if (retry.heardAnything) {
            pass = retry;
            break;
          }
        }
      }
      if (!pass.heardAnything) {
        const reset = await hardResetAdapter(elm, rawLines);
        reads.push({
          request: "ATZ",
          label: "Adapter reset",
          status: reset.ok ? "ok" : "error",
          detail: reset.detail,
        });
        if (reset.ok) {
          const retry = await askEverything();
          if (retry.heardAnything) pass = retry;
        }
      }
      // Back to the auto search: a pinned protocol is right for one bad bus
      // and wrong for the next car this adapter is plugged into.
      await askQuiet(elm, rawLines, "ATSP0", 6000);
    }
  } finally {
    // The longer wait belongs to the reads above, and it is put back whatever
    // happened in between. The channel outlives this function — the scan runs
    // on it afterwards — and a scan that inherits `ATST 64` waits 400 ms for
    // every request a silent module never answers, with adaptive timing
    // compounding it. The same argument the module header is restored under,
    // and the reason both live in a `finally`.
    await restoreReadTiming(elm, rawLines);
  }

  // Unreachable in practice — every channel call above answers for its own
  // failure, so a throw would have to come from a parser. The guard is here so
  // that the timing restore can sit in a `finally` without the result being
  // asserted into place with a `!`.
  if (pass === null) throw new Error("the VIN read produced no result");

  return {
    // Either dialect names the same car, and the report says which one
    // answered because both reads are in `reads`.
    vin: pass.best?.vin ?? null,
    // …and `vinFrom` names it in one word, for the screens that have to say
    // where a fragment came from without listing every read.
    vinFrom: pass.best?.from ?? null,
    calid: pass.calid ?? [],
    ecuName: pass.ecuName,
    protocol: pass.protocol,
    mileage: pass.mileage,
    reads,
    rawLines,
  };
}
