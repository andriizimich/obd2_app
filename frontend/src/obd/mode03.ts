// J1979 modes 03 / 07 / 0A — stored, pending and permanent fault codes.
//
// All three answer in the same shape — `<0x40 + mode> <count> <pair>…` — so
// one parser serves all of them; only the response byte differs (0x43, 0x47,
// 0x4A).
//
// The parser looks for EVERY anchor, not the first. That is what lets a
// reply with headers off — where two modules' lists arrive merged into one
// payload — still yield both, and it is what makes a truncated multi-frame
// reply safe rather than silently short: an anchor whose count does not fit
// in the bytes that remain is not an anchor.

import { decodeDtcPair } from "@/src/obd/dtc";
import {
  moduleLabel,
  negativeResponse,
  parseMessages,
  type NegativeResponse,
  type ParseOptions,
} from "@/src/obd/frames";

export const DTC_MODES = [0x03, 0x07, 0x0a] as const;
export type DtcMode = (typeof DTC_MODES)[number];

export type RawDtcSet = {
  codes: string[];
  /** The ECU's refusal, when it sent `7F <mode> <nrc>` instead of a list. */
  negative: NegativeResponse | null;
  moduleId: number | null;
  module: string | null;
};

export type DtcPayload = {
  codes: string[];
  /** Anchors that named more codes than the reply actually carried. Non-zero
   *  means the list is probably short — a lost CAN frame, usually. */
  truncated: number;
};

/** The four-character request for a mode: `0x03` → `"03"`. */
export function modeRequest(mode: DtcMode): string {
  return mode.toString(16).toUpperCase().padStart(2, "0");
}

/** The response byte a mode answers with: `0x03` → `0x43`. */
export function responseByteFor(mode: DtcMode): number {
  return 0x40 + mode;
}

/**
 * Pull every code out of one module's payload.
 *
 * `0x4A` (the mode 0A response byte) is a legal data byte, so a bare search
 * for it would find phantom anchors; requiring the announced pairs to
 * actually fit in the remaining bytes rejects those.
 */
export function parseDtcPayload(
  payload: number[],
  responseByte: number,
): DtcPayload {
  const codes: string[] = [];
  let truncated = 0;

  for (let i = 0; i + 1 < payload.length; i++) {
    if (payload[i] !== responseByte) continue;
    const count = payload[i + 1];
    if (i + 2 + count * 2 > payload.length) {
      truncated += 1;
      continue;
    }
    for (let k = 0; k < count; k++) {
      const code = decodeDtcPair(
        payload[i + 2 + k * 2],
        payload[i + 3 + k * 2],
      );
      if (code) codes.push(code);
    }
    // Skip past this block; the loop's own i++ lands on the next byte.
    i += 1 + count * 2;
  }

  return { codes, truncated };
}

/** Reply lines → one set per module that answered. */
export function parseDtcReply(
  lines: string[],
  mode: DtcMode,
  opts: ParseOptions = {},
): RawDtcSet[] {
  const responseByte = responseByteFor(mode);
  return parseMessages(lines, opts).map((message) => {
    const negative = negativeResponse(message.payload);
    return {
      codes: negative
        ? []
        : parseDtcPayload(message.payload, responseByte).codes,
      negative,
      moduleId: message.header,
      module: moduleLabel(message.header),
    };
  });
}
