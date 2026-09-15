// J1979 mode 01 (current powertrain data) readers over an Elm327Channel.
//
// Two PIDs live here, and both answer in a fixed 4-byte single frame —
// `41 01 <A> <B> <C> <D>` and `41 A6 <A> <B> <C> <D>` — so no ISO-TP
// reassembly is involved and the frame layer would buy nothing. The leading
// PCI byte (a `06` on CAN replies) is present on some adapter/protocol
// combinations and absent on others, so both readers look for the
// `41 <PID>` header rather than trusting an offset.
//
// ATH1 is safe here: a header (`7E8`) is three hex digits, so the byte
// tokenizer drops it and the anchor scan is unaffected. Every module answers
// PID 01, and the first reply is the engine's — the one the MIL belongs to.

import type { Elm327Channel } from "@/src/obd/at";
import { extractBytes } from "@/src/obd/at";
import type { DiagnosticStatus } from "@/src/obd/types";

/** MIL + stored-code count (J1979 mode 01, PID 01). */
const STATUS_PID = 0x01;
/** Odometer (J1979 mode 01, PID A6). Not answered by every ECU. */
const ODOMETER_PID = 0xa6;

/** Locate a `41 <pid>` response header and return the 4 data bytes after
 *  it. Null when the ECU answered without this PID (`NO DATA`) or the
 *  frame is too short to hold a full value. */
export function extractPidData(bytes: number[], pid: number): number[] | null {
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] === 0x41 && bytes[i + 1] === pid) {
      return bytes.slice(i + 2, i + 6);
    }
  }
  return null;
}

/**
 * 4 data bytes, big-endian. J1979 PID A6 reports kilometres at 0.1 km
 * resolution, hence the /10 — the one thing a synthetic byte stream cannot
 * confirm, because it proves the shifts and the addition but not the scale.
 * If the divisor is wrong the reading is off by exactly 10x, which is
 * obvious at a glance (a 180 000 km car showing 1 800 000) and is a
 * one-character fix.
 */
export function decodeOdometer(data: number[]): number | null {
  if (data.length < 4) return null;
  const raw =
    data[0] * 0x1000000 + data[1] * 0x10000 + data[2] * 0x100 + data[3];
  const km = Math.round(raw / 10);
  // Guard rail: a wrong divisor or a garbage frame must not become a
  // confident number on the dashboard. A blank is recoverable, a lie is not.
  if (!Number.isFinite(km) || km < 1 || km > 2_000_000) return null;
  return km;
}

/**
 * Read the odometer. Resolves with null when the ECU does not support
 * PID A6, and rejects only when the adapter itself does not answer.
 *
 * Never sends ATH1: this runs during connect, and the header state has to
 * stay at the ELM327 default there.
 */
export function parseOdometer(lines: string[]): number | null {
  const data = extractPidData(extractBytes(lines), ODOMETER_PID);
  return data ? decodeOdometer(data) : null;
}

export async function readOdometer(
  channel: Elm327Channel,
  timeoutMs = 3000,
): Promise<number | null> {
  return parseOdometer(await channel.command("01A6", timeoutMs));
}

/**
 * PID 01's first two data bytes. Byte A bit 7 is the lamp, bits 6-0 are the
 * ECU's own count of stored codes; byte B bit 3 says compression ignition.
 *
 * Bytes C and D are the readiness monitor bitmaps — deliberately not decoded.
 * They need separate bit-order tables for spark and compression ignition, for
 * a readiness story this app does not tell.
 */
export function decodeStatus(data: number[]): DiagnosticStatus | null {
  if (data.length < 2) return null;
  const [a, b] = data;
  return {
    milOn: (a & 0x80) !== 0,
    dtcCount: a & 0x7f,
    compressionIgnition: (b & 0x08) !== 0,
  };
}

export function parseStatus(lines: string[]): DiagnosticStatus | null {
  const data = extractPidData(extractBytes(lines), STATUS_PID);
  return data ? decodeStatus(data) : null;
}

/**
 * Read the MIL state and the ECU's stored-code count. Null when the ECU does
 * not answer PID 01, which every OBD-II vehicle is required to.
 *
 * This is the only source for whether the lamp is actually lit: mode 03 lists
 * what is *stored*, and a lamp can be commanded on by a pending code alone,
 * or by a module whose own `03` returned NO DATA.
 */
export async function readStatus(
  channel: Elm327Channel,
  timeoutMs = 3000,
): Promise<DiagnosticStatus | null> {
  return parseStatus(await channel.command("0101", timeoutMs));
}
