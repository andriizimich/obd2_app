// J1979 modes 03 / 07 / 0A — stored, pending and permanent fault codes.
//
// The standard shape is `<0x40 + mode> <count> <pair>…` and one parser
// serves all three modes; only the response byte differs (0x43, 0x47, 0x4A).
// Not every ECU reads the standard that way — see `parseDtcPayload` for the
// count-less shape measured on a real KWP2000 car, which is the difference
// between reporting a code and reporting "all systems go".
//
// The parser looks for EVERY anchor, not the first. That is what lets a
// reply with headers off — where two modules' lists arrive merged into one
// payload — still yield both.

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
  /** The reply announced more codes than it carried: the list is short of
   *  what the module says it holds. Non-zero means "re-read", not "clean". */
  truncated: number;
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
 *
 * A count that does not fit is not a count, and the parity of the bytes
 * behind it says which of the two things it is instead. Both branches exist
 * because of one measured car; the comment on each says which.
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
    const available = Math.floor((payload.length - (i + 2)) / 2);
    const fits = count <= available;
    // Only an anchor that opens the payload is a block this parser has to
    // reason about; anywhere else the count check stays strict, because
    // those bytes are data and a `43`/`4A` sitting in them is not an anchor
    // and not a truncation. (A leading byte below 0x10 is the CAN PCI byte,
    // which this parser does not strip.)
    const leading = i === 0 || (i === 1 && payload[0] <= 0x0f);
    if (!fits && !leading) continue;

    if (fits) {
      for (let k = 0; k < count; k++) {
        const code = decodeDtcPair(
          payload[i + 2 + k * 2],
          payload[i + 3 + k * 2],
        );
        if (code) codes.push(code);
      }
      // Skip past this block; the loop's own i++ lands on the next byte.
      i += 1 + count * 2;
      continue;
    }

    // The count did not fit, so that byte is not a count. Which it is
    // instead is settled by whether the rest of the payload divides into
    // pairs — a count-mode block is `1 + 2n` bytes and therefore always odd.
    const rest = payload.length - (i + 1);
    if (rest % 2 === 0) {
      // `43 <pairs…>`, no count byte: the shape a real KWP2000 car answers
      // with. Its module 0x12 replied `43 04 01 12 46 00 00` while its own
      // PID 01 said it held two codes — and as a count block that frame is
      // 2.5 pairs, which no count can satisfy. Read as pairs it is exact:
      // two codes and one `00 00` of padding, and the count matches the
      // module's own. Reading the `04` as a count instead shifts every pair
      // by one byte and turns P0401/P1246 into P0112/C0600 — two codes with
      // the right count and the wrong meaning, which is worse than useless
      // to whoever reads them off. Padding ends the list.
      for (let k = i + 1; k + 1 < payload.length; k += 2) {
        if (payload[k] === 0x00 && payload[k + 1] === 0x00) break;
        const code = decodeDtcPair(payload[k], payload[k + 1]);
        if (code) codes.push(code);
      }
      i = payload.length;
      continue;
    }

    // An odd tail is the other case: a count-mode block whose end was lost,
    // a dropped CAN frame usually. Refusing it would report "no codes" for
    // a module that has some, which is the one mistake this pass must not
    // make — the codes it did carry are decoded, and the shortfall counted,
    // so the report can say the list is short rather than clean.
    truncated += 1;
    for (let k = 0; k < available; k++) {
      const code = decodeDtcPair(
        payload[i + 2 + k * 2],
        payload[i + 3 + k * 2],
      );
      if (code) codes.push(code);
    }
    i += 1 + available * 2;
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
    const payload = negative
      ? { codes: [], truncated: 0 }
      : parseDtcPayload(message.payload, responseByte);
    return {
      codes: payload.codes,
      truncated: payload.truncated,
      negative,
      moduleId: message.header,
      module: moduleLabel(message.header),
    };
  });
}
