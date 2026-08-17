// J1979 mode 09 (vehicle information) readers and parsers, running over an
// Elm327Channel. Pure parsing — no transport code — unit-testable with
// recorded response frames.
//
// Response format: `49 <PID> <count> <data…>`. With headers on (ATH1) a
// frame looks like `7E8 06 49 02 01 57 56 57 …`; the ELM327 default is to
// prefix multi-line replies with `0:`, `1:` … and a frame counter line
// like `014`. Multi-frame CAN replies pad the last frame with 0x00/0xAA,
// so data must be parsed leniently.

import type { Elm327Channel } from "@/src/obd/at";

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

const HEX_TOKEN = /^[0-9a-f]{2}$/i;

/** Pull all byte tokens out of raw ELM lines (frame counters, "N:" prefixes
 *  and CAN headers are not hex-pair tokens or are dropped as noise). */
export function extractBytes(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const tokens = line.split(/[\s:]+/).filter((t) => HEX_TOKEN.test(t));
    for (const t of tokens) out.push(parseInt(t, 16));
  }
  return out;
}

/** Locate a `49 <pid> <count>` block; returns the count byte and the data
 *  bytes after it. Null when the ECU answered without this PID. */
export function extractMode49(
  bytes: number[],
  pid: number,
): { count: number; data: number[] } | null {
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0x49 && bytes[i + 1] === pid) {
      return { count: bytes[i + 2], data: bytes.slice(i + 3) };
    }
  }
  return null;
}

/** Printable ASCII from a byte array (drops padding/null bytes). */
export function ascii(data: number[]): string {
  let out = "";
  for (const b of data) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
  }
  return out;
}

export async function readProtocol(
  channel: Elm327Channel,
): Promise<string | null> {
  const lines = await channel.command("ATDPN", 2000);
  const code = (lines[lines.length - 1] ?? "").trim().toUpperCase();
  if (!code) return null;
  return PROTOCOL_NAMES[code] ?? `Unknown protocol (${code})`;
}

/** VIN (09 02): count byte followed by 17 ASCII characters. */
export async function readVin(
  channel: Elm327Channel,
): Promise<string | null> {
  const lines = await channel.command("0902", 6000);
  const block = extractMode49(extractBytes(lines), 0x02);
  if (!block) return null;
  const text = ascii(block.data);
  return text.length >= 17 ? text.slice(0, 17) : text || null;
}

/** Calibration ID (09 04): count byte, then one or more ASCII CALIDs.
 *  Multiple IDs occupy 16-byte fields per the spec. */
export async function readCalid(
  channel: Elm327Channel,
): Promise<string[]> {
  const lines = await channel.command("0904", 6000);
  const block = extractMode49(extractBytes(lines), 0x04);
  if (!block) return [];
  const clean = (chunk: number[]) => ascii(chunk).trim();
  if (block.count <= 1) {
    const id = clean(block.data);
    return id ? [id] : [];
  }
  // Split the remainder into `count` fixed 16-byte fields.
  const ids: string[] = [];
  for (let i = 0; i < block.count; i++) {
    const id = clean(block.data.slice(i * 16, (i + 1) * 16));
    if (id) ids.push(id);
  }
  return ids;
}

/** ECU name (09 0A): count byte + 20 ASCII characters, null-padded. */
export async function readEcuName(
  channel: Elm327Channel,
): Promise<string | null> {
  const lines = await channel.command("090A", 6000);
  const block = extractMode49(extractBytes(lines), 0x0a);
  if (!block) return null;
  return ascii(block.data).trim() || null;
}
