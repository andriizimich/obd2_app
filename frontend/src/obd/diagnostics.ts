// The diagnostic pass: one ordered sequence of reads over a connected
// adapter, assembled into a report that says what was read and what was not.
//
// This module owns every command the pass sends. Everything below it
// (mode01.ts, mode03.ts, frames.ts, dtc.ts) is a pure function over reply
// lines or byte arrays — which is what makes the whole path testable with no
// car and no adapter.
//
// Two rules the rest of this file exists to keep:
//
//   1. **Never invent.** A read that failed is reported as failed. `47 00`
//      (no pending codes) and `NO DATA` (no pending-code support) are
//      different answers and collapse into different coverage statuses —
//      merging them tells a healthy car it is broken, or an unreadable one
//      that it is healthy.
//   2. **Never throw.** The caller is a progress screen. A pass that rejects
//      leaves the user with a spinner and no report; a pass that resolves
//      with nine honest "unsupported" lines leaves them knowing exactly
//      where they stand.
//
// Everything is sequential. Elm327Channel refuses a second command while one
// is in flight (at.ts), so a `Promise.all` here would not be faster — it
// would be an exception.

import type { Elm327Channel } from "@/src/obd/at";
import { toFault } from "@/src/obd/dtc";
import { moduleLabel, type ParseOptions } from "@/src/obd/frames";
import {
  adapterRefusal,
  describeError,
  emptyDetail,
  isNonAnswer,
  UNSUPPORTED_NRC,
} from "@/src/obd/reply";
import { parseOdometer, parseStatus } from "@/src/obd/mode01";
import {
  DTC_MODES,
  parseDtcReply,
  type DtcMode,
  type RawDtcSet,
} from "@/src/obd/mode03";
import { busFaultIn } from "@/src/obd/frames";
import {
  detectProtocolCode,
  hardResetAdapter,
  PROTOCOL_NAMES,
} from "@/src/obd/mode09";
import type {
  Coverage,
  CoverageStatus,
  DiagnosticReport,
  DiagnosticStatus,
  DiagnosticsOptions,
  DtcStatus,
  Fault,
} from "@/src/obd/types";

/**
 * Whether the pass got anything at all off the car.
 *
 * The distinction this draws is between "the ECU answered and had nothing to
 * report" and "nothing was read", and every screen that shows a result turns
 * on it: a clean bill of health sent for a car that answered nothing is the
 * one lie this app must not tell. `ok` and `empty` are both the car speaking —
 * `47 00` (no pending codes) is as much an answer as a list of codes.
 *
 * An `AT` request is not. The pass now spends one on resetting an adapter
 * that answered `BUS BUSY`, and it comes back `ok` — counted here, that alone
 * would report a car nothing was read from as healthy. It lives in one place
 * because three callers ask the same question (the report's own note, the
 * Telegram message, the fault-code screen) and a fourth definition of it
 * would be the one that keeps the old answer.
 */
export function carWasRead(coverage: Coverage[]): boolean {
  return coverage.some(
    (entry) =>
      !/^AT/i.test(entry.request) &&
      (entry.status === "ok" || entry.status === "empty"),
  );
}

/** Raw adapter lines kept for the debug surface. Enough for a full pass
 *  including a multi-frame reply, small enough to render without thought. */
const RAW_LINE_CAP = 400;
const DEFAULT_DEADLINE_MS = 20_000;
/** Upper bound for the optional reads. The DTC modes are the point of the
 *  pass and get the caller's full timeout. */
const OPTIONAL_TIMEOUT_MS = 3000;

/** Which list a mode's codes belong to. */
const LIST_FOR_MODE: Record<DtcMode, DtcStatus> = {
  0x03: "stored",
  0x07: "pending",
  0x0a: "permanent",
};

/**
 * Turn headers on or off. Returns whether headers are ON afterwards, so
 * `setHeaders(elm, false)` returning false means "headers are off", not
 * "the command failed".
 *
 * A clone that does not implement ATH answers `?` instead of `OK` and does
 * not throw, so the reply has to be inspected. `sink` receives the raw lines
 * for the caller's debug surface.
 */
export async function setHeaders(
  elm: Elm327Channel,
  on: boolean,
  sink?: (lines: string[]) => void,
): Promise<boolean> {
  try {
    const lines = await elm.command(on ? "ATH1" : "ATH0", 2000);
    sink?.(lines);
    return on && !lines.some((line) => line.trim() === "?");
  } catch {
    return false;
  }
}

/**
 * `lamp off, ECU counts 0` — with the per-module split when more than one
 * module answered. The aggregate alone would hide which module lit the lamp,
 * and on a KWP2000 car that is the difference between a clean engine and a
 * module with two stored codes.
 */
function statusDetail(status: DiagnosticStatus): string {
  const base = `lamp ${status.milOn ? "on" : "off"}, ECU counts ${status.dtcCount}`;
  const modules = status.modules ?? [];
  if (modules.length < 2) return base;
  const parts = modules.map((m) => {
    const who = m.module ?? moduleLabel(m.moduleId) ?? "a module";
    const codes = `${m.dtcCount} code${m.dtcCount === 1 ? "" : "s"}`;
    return `${who}: ${codes}, lamp ${m.milOn ? "on" : "off"}`;
  });
  return `${base} — ${parts.join(" · ")}`;
}

/**
 * One DTC mode's reply → a coverage line. `sets` is empty when no module
 * answered at all, which is a different situation from a module answering
 * with an empty list.
 */
function classifyDtc(
  sets: RawDtcSet[],
  lines: string[],
  opts: ParseOptions,
): { status: CoverageStatus; detail: string } {
  if (sets.length === 0) return emptyDetail(lines, opts);
  const refusal = sets.find((set) => set.negative)?.negative;
  if (refusal) {
    return {
      status: UNSUPPORTED_NRC.has(refusal.nrc) ? "unsupported" : "error",
      detail: refusal.text,
    };
  }
  const codes = sets.reduce((n, set) => n + set.codes.length, 0);
  if (codes === 0) return { status: "empty", detail: "no codes" };
  return {
    status: "ok",
    detail: `${codes} code${codes === 1 ? "" : "s"} from ${sets.length} module${sets.length === 1 ? "" : "s"}`,
  };
}

/**
 * Run the full pass. Resolves for every reachable outcome; the only way to
 * get an exception out of this is to cancel the process.
 */
export async function readDiagnosticsOver(
  elm: Elm327Channel,
  opts: DiagnosticsOptions = {},
): Promise<DiagnosticReport> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const optionalMs = Math.min(timeoutMs, OPTIONAL_TIMEOUT_MS);
  const startedAt = Date.now();

  const rawLines: string[] = [];
  const coverage: Coverage[] = [];
  const notes: string[] = [];
  /** Extra commands this pass may spend on questions nobody answered. */
  const retries = { left: 1 };
  /**
   * Whether the one reset this pass is allowed has been spent.
   *
   * Once, not once per stage: `BUS BUSY` is a property of the adapter's state,
   * and a reset that did not clear it will not clear it for the next read
   * either. Five resets would be five `ATZ` on a bus that is already refusing,
   * and the driver waiting through all of them.
   */
  let busResetSpent = false;

  /** What the adapter said when it had no data, for the summary note. */
  const refusals = new Set<string>();

  /** Every command goes through here, so the debug surface sees all of it. */
  const ask = async (request: string, ms: number): Promise<string[]> => {
    const lines = await elm.command(request, ms);
    for (const line of lines) {
      if (rawLines.length < RAW_LINE_CAP) rawLines.push(line);
    }
    const refusal = adapterRefusal(lines);
    if (refusal) refusals.add(refusal);
    return lines;
  };

  // ATAL is normally already sent at connect time; repeating it is harmless
  // and this pass must not depend on what ran before it.
  try {
    await ask("ATAL", 2000);
  } catch {
    // Clone does not support ATAL — multi-line parsing takes over.
  }

  let protocolCode: string | null = null;
  try {
    protocolCode = detectProtocolCode(await ask("ATDPN", 2000));
  } catch {
    // ignore — the header width falls back to CAN 11-bit
  }

  if (!protocolCode) {
    // An adapter that has not yet carried a message on the bus answers
    // `ATDPN` with `AUTO`, not with a code — it has nothing to report. That
    // is why the same car gave `A5` on one pass and "protocol unknown" on
    // the next: ATAL had just reset the adapter, and whether anything had
    // been asked of the bus since was a matter of timing. One harmless
    // single-frame request settles it, and this runs only when the first
    // answer was unusable.
    try {
      await ask("0100", 2000);
      protocolCode = detectProtocolCode(await ask("ATDPN", 2000));
    } catch {
      // Still nothing — the note below reports it.
    }
  }

  const headersOn = await setHeaders(elm, true, (lines) => {
    for (const line of lines) {
      if (rawLines.length < RAW_LINE_CAP) rawLines.push(line);
    }
  });
  if (headersOn && !protocolCode) {
    notes.push(
      "Protocol unknown — module addresses are read as CAN 11-bit, which may misattribute them.",
    );
  }

  // How every reply below is framed. Built here, after ATH1 has answered,
  // because a header width guessed wrong eats the first payload bytes.
  const parseOpts: ParseOptions = { protocolCode, headers: headersOn };

  const dtcSets = new Map<DtcMode, RawDtcSet[]>();
  let status: DiagnosticStatus | null = null;
  let mileage: number | null = null;

  const stages: { request: string; label: string; mode?: DtcMode }[] = [
    { request: "03", label: "Stored fault codes", mode: 0x03 },
    { request: "07", label: "Pending fault codes", mode: 0x07 },
    { request: "0A", label: "Permanent fault codes", mode: 0x0a },
  ];
  if (!opts.faultsOnly) {
    stages.push({ request: "0101", label: "Check-engine lamp and code count" });
    stages.push({ request: "01A6", label: "Odometer" });
  }

  try {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      // Emitted before the read, with `index` counting the stages already
      // done, so the bar never claims work that has not happened.
      opts.onProgress?.({ stage: stage.label, index: i, total: stages.length });

      if (Date.now() - startedAt > deadlineMs) {
        coverage.push({
          request: stage.request,
          label: stage.label,
          status: "skipped",
          detail: "time budget reached",
        });
        continue;
      }

      try {
        const attempt = async (): Promise<{ lines: string[]; failure: string | null }> => {
          try {
            return {
              lines: await ask(stage.request, stage.mode ? timeoutMs : optionalMs),
              failure: null,
            };
          } catch (err) {
            return { lines: [], failure: describeError(err) };
          }
        };

        let read = await attempt();

        // Ask again when nobody answered at all — a command that timed out, or
        // lines that arrived in a shape nothing recognised. `NO DATA` is the
        // ECU speaking and a refusal is the adapter speaking; both are facts
        // about the car that a second question cannot change, and on a car
        // with the ignition off they would turn this pass into forty seconds
        // of waiting for the same answer five times. One repeat for the whole
        // pass, spent by the first stage that gets no answer, because after
        // the channel's drain a second silence is a car that is not talking.
        if (retries.left > 0 && (read.failure !== null || isNonAnswer(read.lines, parseOpts))) {
          retries.left -= 1;
          read = await attempt();
        }

        // The adapter naming the bus as the fault. This is the one failure
        // here that is about the adapter's own ability to transmit: `BUS BUSY`
        // is the line held and `BUS ERROR` a framing failure on the wire, and
        // neither is the car declining to answer. No protocol choice clears
        // them and no repeat asks a better question — which is why the repeat
        // budget above never fires on one — so this is the only step that can.
        //
        // On the first stage that meets it rather than after the fifth has
        // failed the same way. The identification pass waits for the whole
        // read because there the read is one question with one answer; here
        // four more stages would spend four more timeouts learning nothing,
        // with the driver watching the progress bar move through them. A pass
        // that ends `03 ✗ · 07 ✗ · 0A ✗ · 0101 ✗ · 01A6 ✗` and never tried is
        // the one screen this app must not produce.
        if (!busResetSpent && busFaultIn(read.lines)) {
          busResetSpent = true;
          const reset = await hardResetAdapter(elm, rawLines);
          coverage.push({
            request: "ATZ",
            label: "Adapter reset",
            status: reset.ok ? "ok" : "error",
            detail: reset.detail,
          });
          if (reset.ok) {
            // ATZ puts the adapter back to its factory defaults, and headers
            // are one of them. `parseOpts` was built from what ATH1 answered
            // before this loop began, so headers go back to exactly that:
            // turning them on for a pass that had found them unavailable
            // would parse every remaining reply at the wrong width. Echo is
            // the other default and the dangerous one — a command echoed back
            // reads as a reply — and `hardResetAdapter` has already turned it
            // off. `ATAL`, which this pass opens with, is restored there too.
            await setHeaders(elm, headersOn, (lines) => {
              for (const line of lines) {
                if (rawLines.length < RAW_LINE_CAP) rawLines.push(line);
              }
            });
            read = await attempt();
          }
        }

        // The rest of the loop is written against an exception meaning "this
        // read failed", and that has not changed — only how many times it was
        // asked before giving up.
        if (read.failure) throw new Error(read.failure);
        const lines = read.lines;

        if (stage.mode) {
          const sets = parseDtcReply(lines, stage.mode, parseOpts);
          dtcSets.set(stage.mode, sets);
          const verdict = classifyDtc(sets, lines, parseOpts);
          coverage.push({
            request: stage.request,
            label: stage.label,
            status: verdict.status,
            detail: verdict.detail,
          });
          continue;
        }

        if (stage.request === "0101") {
          status = parseStatus(lines, parseOpts);
          coverage.push({
            request: stage.request,
            label: stage.label,
            ...(status
              ? { status: "ok" as const, detail: statusDetail(status) }
              : emptyDetail(lines, parseOpts)),
          });
          continue;
        }

        mileage = parseOdometer(lines);
        coverage.push({
          request: stage.request,
          label: stage.label,
          ...(mileage
            ? { status: "ok" as const, detail: `${mileage} km` }
            : emptyDetail(
                lines,
                parseOpts,
                " — PID A6 is only required from 2019",
              )),
        });
      } catch (err) {
        coverage.push({
          request: stage.request,
          label: stage.label,
          status: "error",
          detail: describeError(err),
        });
      }
    }
  } finally {
    // Unconditional: ATH0 is the factory default after ATZ, `ATH?` does not
    // exist so there is no previous state to restore, and mode 09's
    // connect-time reads assume headers are off.
    await setHeaders(elm, false);
  }

  const faults: Fault[] = [];
  const seen = new Set<string>();
  for (const mode of DTC_MODES) {
    const listStatus = LIST_FOR_MODE[mode];
    for (const set of dtcSets.get(mode) ?? []) {
      for (const code of set.codes) {
        // Two modules reporting the same code are two faults, so the module
        // is part of the identity. Only a repeat from one module in one list
        // is a duplicate.
        const key = `${code}:${listStatus}:${set.moduleId ?? "none"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        faults.push(toFault(code, listStatus, set.moduleId));
      }
    }
  }

  const readAnything = carWasRead(coverage);

  // A pass where nothing was readable has one cause, and the adapter already
  // named it. Say it once, up where the user reads first, instead of leaving
  // five identical "failed" rows to be interpreted.
  if (!readAnything && refusals.size > 0) {
    notes.push(
      `No ECU data was read. The adapter answered: ${[...refusals].join(", ")}.`,
    );
  }

  if (headersOn && faults.length > 0 && !faults.some((fault) => fault.moduleId !== null)) {
    // ATH1 was accepted and codes did come back, but none of them addressed —
    // the adapter is not printing headers despite agreeing to. Say so rather
    // than let every row silently lose its module.
    notes.push(
      "The adapter accepted ATH1 but sent no module addresses — module attribution is unavailable.",
    );
  }

  // A module that named more codes than its reply carried is the one case
  // where the list below is known to be incomplete. The user has to be told,
  // because "two codes" and "two codes so far" look identical otherwise.
  const shortLists = [...dtcSets.values()].reduce(
    (n, sets) => n + sets.reduce((m, set) => m + set.truncated, 0),
    0,
  );
  if (shortLists > 0) {
    notes.push(
      `A module announced more codes than its reply carried (${shortLists} list${shortLists === 1 ? "" : "s"} cut short) — the list below is incomplete.`,
    );
  }

  const storedCoverage = coverage.find((entry) => entry.request === "03");
  if (status && storedCoverage?.status === "ok") {
    // Both sides now count every module: PID 01 is answered by all of them
    // and mode 03 returns all of their lists, so the totals compare with
    // headers on or off. Only the per-module attribution needs headers.
    const stored = faults.filter((fault) => fault.status === "stored").length;
    if (status.dtcCount !== stored) {
      notes.push(
        `The ECU reports ${status.dtcCount} stored code${status.dtcCount === 1 ? "" : "s"}; ${stored} came back from mode 03.`,
      );
    }
  }

  return {
    at: Date.now(),
    headersOn,
    protocol: protocolCode
      ? (PROTOCOL_NAMES[protocolCode] ?? `Unknown protocol (${protocolCode})`)
      : null,
    status,
    mileage,
    faults,
    coverage,
    notes,
    rawLines,
  };
}
