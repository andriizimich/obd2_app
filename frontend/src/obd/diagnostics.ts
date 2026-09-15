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
import { saidNoData } from "@/src/obd/frames";
import { parseOdometer, parseStatus } from "@/src/obd/mode01";
import {
  DTC_MODES,
  parseDtcReply,
  type DtcMode,
  type RawDtcSet,
} from "@/src/obd/mode03";
import { detectProtocolCode, PROTOCOL_NAMES } from "@/src/obd/mode09";
import type {
  CompatibilityLine,
  Coverage,
  CoverageStatus,
  DiagnosticReport,
  DiagnosticStatus,
  DiagnosticsOptions,
  DtcStatus,
  Fault,
} from "@/src/obd/types";

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

/** CAN id of the engine ECU — the module PID 01 answers for, and so the one
 *  whose code list the ECU's own count can be checked against. */
const ENGINE_MODULE = 0x7e8;

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
 * What the compatibility check asks, in order. Six questions whose answers
 * settle every assumption this app makes about an unseen adapter: whether it
 * is an ELM327 at all, which protocol it negotiated, whether it honours
 * ATH1, what the lamp byte and the odometer really return, and what a mode
 * 03 reply looks like on the wire.
 */
const COMPAT_COMMANDS: { command: string; label: string; ms: number }[] = [
  { command: "ATI", label: "Adapter identification", ms: 3000 },
  { command: "ATDPN", label: "Protocol in use", ms: 3000 },
  { command: "ATH1", label: "Headers on (module addresses)", ms: 2000 },
  { command: "0101", label: "Lamp state and ECU code count", ms: 3000 },
  { command: "01A6", label: "Odometer", ms: 3000 },
  { command: "03", label: "Stored fault codes", ms: 4000 },
  { command: "ATH0", label: "Headers off", ms: 2000 },
];

/**
 * Run each command and keep the reply verbatim. Every step is caught
 * individually, so the list runs to the end — including the ATH0 that puts
 * the adapter back the way the rest of the app expects it. This is the
 * surface a first real reading is diagnosed from, so it must never throw
 * and never stop halfway.
 */
export async function readCompatibilityOver(
  elm: Elm327Channel,
  opts: { timeoutMs?: number } = {},
): Promise<CompatibilityLine[]> {
  const out: CompatibilityLine[] = [];
  for (const step of COMPAT_COMMANDS) {
    const ms = opts.timeoutMs ?? step.ms;
    try {
      out.push({
        command: step.command,
        label: step.label,
        lines: await elm.command(step.command, ms),
      });
    } catch (err) {
      out.push({
        command: step.command,
        label: step.label,
        lines: [`<no reply: ${describeError(err)}>`],
      });
    }
  }
  return out;
}

/** NRCs that mean "this vehicle does not do that" rather than "that failed". */
const UNSUPPORTED_NRC = new Set([0x11, 0x31]);

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One DTC mode's reply → a coverage line. `sets` is empty when no module
 * answered at all, which is a different situation from a module answering
 * with an empty list.
 */
function classifyDtc(
  sets: RawDtcSet[],
  lines: string[],
): { status: CoverageStatus; detail: string } {
  if (sets.length === 0) {
    return saidNoData(lines)
      ? { status: "unsupported", detail: "the ECU answered NO DATA" }
      : { status: "error", detail: "no readable reply" };
  }
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

  /** Every command goes through here, so the debug surface sees all of it. */
  const ask = async (request: string, ms: number): Promise<string[]> => {
    const lines = await elm.command(request, ms);
    for (const line of lines) {
      if (rawLines.length < RAW_LINE_CAP) rawLines.push(line);
    }
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
        const lines = await ask(
          stage.request,
          stage.mode ? timeoutMs : optionalMs,
        );

        if (stage.mode) {
          const sets = parseDtcReply(lines, stage.mode, {
            protocolCode,
            headers: headersOn,
          });
          dtcSets.set(stage.mode, sets);
          const verdict = classifyDtc(sets, lines);
          coverage.push({
            request: stage.request,
            label: stage.label,
            status: verdict.status,
            detail: verdict.detail,
          });
          continue;
        }

        if (stage.request === "0101") {
          status = parseStatus(lines);
          coverage.push({
            request: stage.request,
            label: stage.label,
            status: status
              ? "ok"
              : saidNoData(lines)
                ? "unsupported"
                : "error",
            detail: status
              ? `lamp ${status.milOn ? "on" : "off"}, ECU counts ${status.dtcCount}`
              : saidNoData(lines)
                ? "the ECU answered NO DATA"
                : "no readable reply",
          });
          continue;
        }

        mileage = parseOdometer(lines);
        coverage.push({
          request: stage.request,
          label: stage.label,
          status: mileage
            ? "ok"
            : saidNoData(lines)
              ? "unsupported"
              : "error",
          detail: mileage
            ? `${mileage} km`
            : saidNoData(lines)
              ? "the ECU answered NO DATA — PID A6 is only required from 2019"
              : "no readable reply",
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

  if (headersOn && !faults.some((fault) => fault.moduleId !== null)) {
    // ATH1 was accepted but nothing came back addressed — the adapter is not
    // printing headers despite agreeing to. Say so rather than let every row
    // silently lose its module.
    notes.push(
      "The adapter accepted ATH1 but sent no module addresses — module attribution is unavailable.",
    );
  }

  const storedCoverage = coverage.find((entry) => entry.request === "03");
  if (status && headersOn && storedCoverage?.status === "ok") {
    // Only comparable with headers on: without them the mode 03 list merges
    // every module's codes, while PID 01 answers for the engine alone.
    const engineStored = faults.filter(
      (fault) => fault.status === "stored" && fault.moduleId === ENGINE_MODULE,
    ).length;
    if (status.dtcCount !== engineStored) {
      notes.push(
        `The ECU reports ${status.dtcCount} stored code${status.dtcCount === 1 ? "" : "s"}; ${engineStored} came back from mode 03.`,
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
