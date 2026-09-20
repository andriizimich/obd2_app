// What the adapter actually said, when a read came back without a value.
//
// Two paths need this vocabulary and they are on opposite sides of the app:
// the diagnostic pass (`diagnostics.ts`) and the connect-time reads
// (`mode09.ts`). The connect path used to swallow it — every failure became a
// dash and a guess — which is why a car whose scan reads fine could still
// show four dashes on the vehicle screen with no way to tell whether the ECU
// had said `NO DATA`, the adapter had never answered, or the reply had
// arrived in a shape the parsers did not recognise.
//
// It lives here rather than in either caller because a second copy of these
// rules is how the two paths would come to disagree about the same bytes.

import {
  busFaultIn,
  isNoiseLine,
  negativeResponse,
  parseMessages,
  saidNoData,
} from "@/src/obd/frames";
import type { ParseOptions } from "@/src/obd/frames";
import type { CoverageStatus } from "@/src/obd/types";

/** NRCs that mean "this vehicle does not do that" rather than "that failed".
 *  0x12 is `sub-function not supported` — the answer this car gave to 01A6,
 *  and a missing odometer PID is not a failed read. */
export const UNSUPPORTED_NRC = new Set([0x11, 0x12, 0x31]);

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How much of an unrecognised reply to quote. One line of a report, and
 *  enough of a mode-09 frame to see which way the shape is wrong. */
const QUOTE_CAP = 120;

/** The adapter's lines flattened into one readable line: prompt and `OK` are
 *  noise, everything else is the finding. */
function quoteLines(lines: string[]): string {
  const shown = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== ">" && line.toLowerCase() !== "ok");
  const text = shown.join(" / ");
  return text.length > QUOTE_CAP ? `${text.slice(0, QUOTE_CAP - 1)}…` : text;
}

/**
 * The adapter's own words when a request came back without data. `UNABLE TO
 * CONNECT`, `CAN ERROR` and `BUS INIT: ...ERROR` each name a different fault
 * — a dead bus, a broken frame, a failed init — and only the line itself says
 * which. `NO DATA` is excluded: it means "not supported", which the caller
 * reports as a different status entirely.
 */
export function adapterRefusal(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase() === "ok" || trimmed === ">") continue;
    if (trimmed.toLowerCase() === "no data") continue;
    if (isNoiseLine(trimmed)) return trimmed;
  }
  return null;
}

/** The adapter's own word for "a character arrived while I was busy".
 *  It is not an answer from the car and not a fault of the car's: the request
 *  never reached the ECU, because the app wrote it while the adapter was still
 *  working on the one before. See `PROMPT_SETTLE_MS` in `at.ts`. */
const INTERRUPTED = "stopped";

/** Why a reply carried no value. The first three are answers — somebody
 *  spoke; `interrupted` is the adapter saying our own write cut in; the last
 *  is the absence of an answer. */
type EmptyReason =
  | { kind: "no-data" }
  | { kind: "negative"; unsupported: boolean; text: string }
  | { kind: "refusal"; text: string }
  | { kind: "interrupted"; text: string }
  | { kind: "bus"; text: string }
  | { kind: "silence"; quoted: string };

/**
 * Classify a reply that produced no value. One function, because two callers
 * need two views of the same decision and they must not drift: `emptyDetail`
 * says it in words, `isNonAnswer` says it as a yes or no.
 *
 * The refusal is checked before the adapter's own words, because on a framed
 * bus (`83 F1 18 7F 01 12 1E`) the raw line is byte soup — quoting it
 * verbatim tells the reader nothing they can act on.
 */
function emptyReason(lines: string[], opts: ParseOptions): EmptyReason {
  if (saidNoData(lines)) return { kind: "no-data" };
  for (const message of parseMessages(lines, opts)) {
    const refusal = negativeResponse(message.payload);
    if (!refusal) continue;
    return { kind: "negative", unsupported: UNSUPPORTED_NRC.has(refusal.nrc), text: refusal.text };
  }
  // Before the generic refusal, because `BUS BUSY` is one and the sentence
  // the generic branch builds is wrong twice over: the adapter recognised its
  // own fault perfectly, and the car was never asked. Read as "answered, but
  // none of it was recognised", it sends whoever is holding the phone looking
  // for a parsing bug in an app whose only real problem is that it cannot put
  // a byte on the wire — and the fix for that is a different one entirely.
  if (busFaultIn(lines)) {
    return { kind: "bus", text: quoteLines(lines) };
  }
  const refusal = adapterRefusal(lines);
  if (refusal) {
    return refusal.trim().toLowerCase() === INTERRUPTED
      ? { kind: "interrupted", text: refusal }
      : { kind: "refusal", text: refusal };
  }
  return { kind: "silence", quoted: quoteLines(lines) };
}

/**
 * Coverage for a read that produced no value. Four outcomes, four different
 * facts: the ECU said NO DATA, the ECU refused and named a reason, the
 * adapter refused, or nothing came back at all.
 */
export function emptyDetail(
  lines: string[],
  opts: ParseOptions,
  note?: string,
): { status: CoverageStatus; detail: string } {
  const reason = emptyReason(lines, opts);
  switch (reason.kind) {
    case "no-data":
      return { status: "unsupported", detail: `the ECU answered NO DATA${note ?? ""}` };
    case "negative":
      return {
        status: reason.unsupported ? "unsupported" : "error",
        detail: `${reason.text}${note ?? ""}`,
      };
    case "refusal":
      return { status: "error", detail: `the adapter answered ${reason.text}` };
    case "interrupted":
      // Said plainly, because the alternative reading of this row is wrong in
      // a way that costs a trip: `1A 90 → STOPPED` on the evidence screen reads
      // as the car refusing the one service the VIN comes from, and the car
      // never saw the request.
      return {
        status: "error",
        detail: `the adapter was interrupted mid-command (${reason.text}) — this request never reached the ECU`,
      };
    case "bus":
      // The same reassurance for the same reason. The adapter is not passing
      // on anything the car said; it is saying that it could not transmit, so
      // every read in the pass will say this until something clears the line.
      // What clears it is a reset of the adapter, which is the caller's move
      // and not this function's — this is only the row that has to be honest
      // about which of the two ends is broken.
      return {
        status: "error",
        detail: `the adapter could not transmit (${reason.text}) — this request never reached the ECU`,
      };
    default:
      // Something did come back and nothing recognised it. Calling that "no
      // readable reply" is the most expensive lie this file could tell: it
      // blames the adapter for bytes the app failed to understand, and it
      // reads exactly like a channel that was never answered at all — two
      // problems with two different fixes, made indistinguishable at the one
      // moment somebody is looking. So the bytes come along.
      return reason.quoted
        ? {
            status: "error",
            detail: `the adapter answered, but none of it was recognised: ${reason.quoted}`,
          }
        : { status: "error", detail: "no readable reply" };
  }
}

/**
 * True when nobody answered: silence, bytes in a shape nothing recognised, or
 * the adapter saying its own work was cut into.
 *
 * These are the empty outcomes a second ask can change. `NO DATA` is the ECU
 * speaking and `UNABLE TO CONNECT` is the adapter speaking about the bus —
 * both are facts about the car, and repeating the question only makes the wait
 * longer. An unanswered question is not a fact; it is what one bad moment
 * looks like, and it is the only thing worth spending a second command on.
 *
 * `STOPPED` belongs with the unanswered ones even though it is the adapter
 * talking, and for the strongest reason of the three: the request never left
 * the adapter. Retrying it is not asking the car the same thing twice, it is
 * asking it once.
 *
 * `BUS BUSY` is the adapter talking too, and it stays out. The first request
 * that meets it reaches the bus no better than the second one will, because
 * the line is held by something neither of them can change — and spending the
 * one repeat this pass is given on it buys a second identical complaint
 * instead of a second chance at a read that was merely unlucky.
 */
export function isNonAnswer(lines: string[], opts: ParseOptions = {}): boolean {
  const kind = emptyReason(lines, opts).kind;
  return kind === "silence" || kind === "interrupted";
}
