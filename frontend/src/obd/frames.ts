// ELM327 line → frame → message. The layer mode 09 never needed and the
// DTC modes cannot do without.
//
// `extractBytes` (at.ts) flattens every hex token in a reply into one byte
// soup. That is fine for a single ECU answering a single `49 <pid>` anchor,
// and wrong for fault codes in three ways:
//
//   1. attribution — with headers on, `03` is answered by every module
//      (`7E8 06 43 02 03 00 04 20` engine, `7E9 04 43 01 07 01` gearbox).
//      The flat array merges them into one list and throws the headers away.
//   2. negative responses — `7F 03 12` ("service not supported") dissolves
//      into the soup and the caller cannot tell it apart from silence.
//   3. truncation — more than ~3 codes do not fit in one CAN frame; a flat
//      read silently stops at the third and nobody finds out.
//
// So this module keeps the frame boundaries. It deliberately does NOT
// implement ISO-TP: clone firmware disagrees about whether the PCI byte
// (`06` / `10` / `21`) is printed, and without hardware we cannot know
// which behaviour the adapter has. Instead each reader anchors on its own
// service byte, which skips a stray PCI byte for free — the trick
// `extractMode49` already uses.
//
// Never send ATS0: both this tokenizer and `extractBytes` split on
// whitespace, and a spaceless reply breaks them silently.

const BYTE = /^[0-9a-f]{2}$/i;
/** CAN 11-bit header (`7E8`) — 3 hex digits, so never mistaken for data. */
const CAN11_HEADER = /^[0-9a-f]{3}$/i;
/** Some firmware packs the 29-bit header into a single token (`18DAF110`). */
const CAN29_PACKED = /^[0-9a-f]{8}$/i;
/** `0:` … `F:` — the line index inside a multi-line reply, not an address. */
const LINE_PREFIX = /^[0-9a-f]{1,2}:\s*/i;

/** Protocol codes from ATDPN that use a 3-byte legacy header. */
const LEGACY_PROTOCOLS = new Set(["1", "2", "3", "4", "5"]);
/** Protocol codes from ATDPN that use a 29-bit CAN header. */
const CAN29_PROTOCOLS = new Set(["7", "9", "a"]);

export type FrameKind = "can11" | "can29" | "legacy" | "unknown";

export type RawFrame = {
  /** Module address, or null when headers were off. */
  header: number | null;
  kind: FrameKind;
  data: number[];
  raw: string;
};

export type ObdMessage = {
  header: number | null;
  payload: number[];
};

export type ParseOptions = {
  /** Protocol code from ATDPN ("1"…"A", with any auto-detect "A" prefix
   *  already stripped). Decides the header width when headers are on;
   *  defaults to CAN 11-bit, by far the most common. */
  protocolCode?: string | null;
  /** Whether ATH1 succeeded. When false, replies carry no address. */
  headers?: boolean;
};

/**
 * Adapter chatter that is not a reply: prompts, status words and error
 * reports. `NO DATA` lands here too — a caller that needs to tell it apart
 * from silence reads the raw lines instead.
 */
const NOISE_EXACT = new Set([
  "ok",
  "?",
  "no data",
  "stopped",
  "error",
  ">",
  "can error",
  "buffer full",
  "data error",
  "fb error",
  "act alert",
  "unable to connect",
]);

export function isNoiseLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (t === "") return true;
  if (NOISE_EXACT.has(t)) return true;
  if (t.startsWith("searching")) return true; // SEARCHING... / SEARCHING…
  if (t.startsWith("bus init")) return true; // BUS INIT: OK / …ERROR
  return false;
}

/** Drop the `0:` / `1:` line index a multi-line reply is printed with. */
export function stripLinePrefix(line: string): string {
  return line.trim().replace(LINE_PREFIX, "");
}

/** Header shape implied by an ATDPN code. Unknown codes assume CAN 11-bit. */
export function headerShapeFor(
  protocolCode: string | null | undefined,
): "can11" | "can29" | "legacy" {
  const code = (protocolCode ?? "").trim().toLowerCase();
  if (LEGACY_PROTOCOLS.has(code)) return "legacy";
  if (CAN29_PROTOCOLS.has(code)) return "can29";
  return "can11";
}

/** Split reply lines into frames, keeping each frame's address. */
export function parseFrames(
  lines: string[],
  opts: ParseOptions = {},
): RawFrame[] {
  const headersOn = opts.headers ?? false;
  const shape = headerShapeFor(opts.protocolCode);
  const out: RawFrame[] = [];

  for (const line of lines) {
    if (isNoiseLine(line)) continue;
    const tokens = stripLinePrefix(line).split(/\s+/).filter(Boolean);
    // A single token carries no payload. That also drops the bare frame
    // counter line ("014") some clones print, which would otherwise be
    // mistaken for a CAN 11-bit header.
    if (tokens.length < 2) continue;

    const bytes: number[] = [];
    for (const t of tokens) if (BYTE.test(t)) bytes.push(parseInt(t, 16));
    if (bytes.length === 0) continue;

    const raw = line.trim();
    const head = headersOn ? readHeader(tokens, shape) : null;
    if (!head) {
      out.push({ header: null, kind: "unknown", data: bytes, raw });
      continue;
    }
    out.push({
      header: head.header,
      kind: head.kind,
      data: bytes.slice(head.addressBytes),
      raw,
    });
  }
  return out;
}

/**
 * Concatenate every frame that shares an address into one payload, in the
 * order the adapter printed them. ISO-TP sequencing is not interpreted —
 * see the file header — so a module's consecutive frames simply join up,
 * which is exactly what an anchor scan wants.
 */
export function groupByModule(frames: RawFrame[]): ObdMessage[] {
  const out: ObdMessage[] = [];
  const byHeader = new Map<string, ObdMessage>();
  for (const frame of frames) {
    const key = frame.header === null ? "none" : String(frame.header);
    let msg = byHeader.get(key);
    if (!msg) {
      msg = { header: frame.header, payload: [] };
      byHeader.set(key, msg);
      out.push(msg);
    }
    msg.payload.push(...frame.data);
  }
  return out;
}

/** Frames → one payload per module. The entry point every reader uses. */
export function parseMessages(
  lines: string[],
  opts: ParseOptions = {},
): ObdMessage[] {
  return groupByModule(parseFrames(lines, opts));
}

function readHeader(
  tokens: string[],
  shape: "can11" | "can29" | "legacy",
): { header: number; kind: FrameKind; addressBytes: number } | null {
  const first = tokens[0];
  if (CAN11_HEADER.test(first)) {
    return { header: parseInt(first, 16), kind: "can11", addressBytes: 0 };
  }
  if (CAN29_PACKED.test(first)) {
    return { header: parseInt(first, 16), kind: "can29", addressBytes: 0 };
  }
  if (!BYTE.test(first)) return null;

  // A byte-shaped first token could be data or an address, and only the
  // protocol tells them apart — 3 address bytes on ISO 9141/KWP, 4 on
  // 29-bit CAN. Guessing here would eat the first bytes of the payload.
  if (shape === "legacy" && tokens.length >= 4 && allBytes(tokens, 3)) {
    const [a, b, c] = tokens.slice(0, 3).map((t) => parseInt(t, 16));
    return { header: (a << 16) | (b << 8) | c, kind: "legacy", addressBytes: 3 };
  }
  if (shape === "can29" && tokens.length >= 5 && allBytes(tokens, 4)) {
    const [a, b, c, d] = tokens.slice(0, 4).map((t) => parseInt(t, 16));
    return {
      header: ((a << 24) | (b << 16) | (c << 8) | d) >>> 0,
      kind: "can29",
      addressBytes: 4,
    };
  }
  return null;
}

function allBytes(tokens: string[], count: number): boolean {
  for (let i = 0; i < count; i++) if (!BYTE.test(tokens[i])) return false;
  return true;
}

const CAN11_MODULES: Record<number, string> = {
  0x7e8: "Engine",
  0x7e9: "Transmission",
  0x7ea: "ABS / Brakes",
  0x7eb: "Body / SRS",
};

/**
 * Human label for a module address. Only 7E8 (engine) and 7E9 (transmission)
 * are conventions we can rely on; the rest follow common practice among scan
 * tools but are not standardised, so an address we do not recognise is
 * reported as itself rather than given a confident name.
 */
export function moduleLabel(header: number | null): string | null {
  if (header === null) return null;
  if (header >= 0x7e8 && header <= 0x7ef) {
    return (
      CAN11_MODULES[header] ?? `ECU ${header.toString(16).toUpperCase()}`
    );
  }
  // Legacy and 29-bit headers both end in the ECU's source address, and
  // 0x10 is the conventional engine address on either.
  const source = header & 0xff;
  return source === 0x10
    ? "Engine"
    : `ECU ${source.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** ISO 14229 negative response codes, for the `7F <mode> <nrc>` reply. */
const NRC: Record<number, string> = {
  0x10: "general reject",
  0x11: "service not supported",
  0x12: "sub-function not supported",
  0x13: "incorrect message length",
  0x21: "busy, repeat request",
  0x22: "conditions not correct",
  0x31: "request out of range",
  0x33: "security access denied",
  0x78: "response pending",
  0x7f: "service not supported in the active session",
};

export type NegativeResponse = {
  mode: number;
  /** ISO 14229 negative response code — the reason the ECU refused. */
  nrc: number;
  /** Ready-to-show sentence. */
  text: string;
};

/**
 * Find a `7F <mode> <nrc>` refusal in a payload, or null when there is none.
 * The mode byte must look like a J1979 mode, otherwise a `7F` sitting in
 * ordinary data would be read as a rejection.
 *
 * Returns the raw NRC as well as the sentence, because callers act on it:
 * "service not supported" is a missing feature, while "conditions not
 * correct" is a read that failed, and the coverage line must not conflate
 * the two.
 */
export function negativeResponse(payload: number[]): NegativeResponse | null {
  for (let i = 0; i + 2 < payload.length; i++) {
    if (payload[i] !== 0x7f) continue;
    const mode = payload[i + 1];
    if (mode < 0x01 || mode > 0x0a) continue;
    const nrc = payload[i + 2];
    const reason =
      NRC[nrc] ??
      `error 0x${nrc.toString(16).toUpperCase().padStart(2, "0")}`;
    return {
      mode,
      nrc,
      text: `mode 0x${mode.toString(16).toUpperCase().padStart(2, "0")} rejected: ${reason}`,
    };
  }
  return null;
}

/** {@link negativeResponse}, as the sentence alone. */
export function describeNegativeResponse(payload: number[]): string | null {
  return negativeResponse(payload)?.text ?? null;
}

/** True when the reply lines say the PID is unsupported rather than silent. */
export function saidNoData(lines: string[]): boolean {
  return lines.some((l) => l.trim().toLowerCase() === "no data");
}
