import React, { createContext, useContext, useMemo, useState } from "react";

import type { Identification } from "@/src/obd/identify";
import { identifyVehicle, unidentified } from "@/src/obd/identify";
import { describeError } from "@/src/obd/reply";
import type { ObdTransport } from "@/src/obd/transport";
import { isFullVin } from "@/src/utils/vin";
import type {
  Coverage,
  DiagnosticReport,
  DiagnosticsOptions,
  Fault,
  IdentificationEvidence,
  ObdDevice,
  Vehicle,
} from "@/src/obd/types";

type ObdState = {
  device: ObdDevice | null;
  vehicle: Vehicle | null;
  /** How the vehicle was identified (ECU evidence, warnings, score basis). */
  evidence: IdentificationEvidence | null;
  /** The transport that owns the live connection — the scan goes through it. */
  transport: ObdTransport | null;
  /** The most recent diagnostic pass, or null before the first one. */
  report: DiagnosticReport | null;
  faults: Fault[] | null; // derived from `report`, null = not scanned yet
  connect: (
    device: ObdDevice,
    identification?: Identification,
    transport?: ObdTransport,
  ) => void;
  disconnect: () => void;
  /** Runs a real pass over the connected adapter and returns what it read.
   *  Throws only when there is no adapter to ask — a car that answers
   *  nothing is a report, not an error. */
  runScan: (opts?: DiagnosticsOptions) => Promise<DiagnosticReport>;
  clearScan: () => void;
};

const ObdCtx = createContext<ObdState | null>(null);

/**
 * Every module address a pass heard from.
 *
 * The scan is the one thing in this app that has already looked at who is on
 * the bus: fault codes arrive addressed, and PID 01 is answered by every
 * module that exists. Those addresses are what the VIN read needs to ask each
 * controller for the VIN on its own instead of broadcasting at all of them at
 * once and reading their frames interleaved.
 *
 * Empty is a normal answer — a car with no codes and no module split has
 * named nobody, and the VIN read then simply does not happen that way.
 */
function moduleAddressesIn(report: DiagnosticReport): number[] {
  const addresses = new Set<number>();
  for (const fault of report.faults) {
    if (typeof fault.moduleId === "number") addresses.add(fault.moduleId);
  }
  for (const module of report.status?.modules ?? []) {
    if (typeof module.moduleId === "number") addresses.add(module.moduleId);
  }
  return [...addresses];
}

/**
 * The row that stands for a second identification pass which never happened.
 *
 * A throw from that pass is a real outcome and it used to be discarded whole
 * (`catch {}`), which made it indistinguishable on screen from a pass that
 * ran and read nothing: the evidence stayed as the *first* read left it — the
 * one taken before the engine was started — and no line on the screen said a
 * second attempt had been made at all. Those two want opposite responses
 * (one is about the car, the other about the app), and the request column is
 * where the difference has to show.
 */
function secondReadFailed(err: unknown): Coverage {
  return {
    request: "pass 2",
    label: "Identification, second pass",
    status: "error",
    detail: `the second identification pass failed: ${describeError(err)}`,
  };
}

export function ObdProvider({ children }: { children: React.ReactNode }) {
  const [device, setDevice] = useState<ObdDevice | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [evidence, setEvidence] = useState<IdentificationEvidence | null>(null);
  const [transport, setTransport] = useState<ObdTransport | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);

  const value = useMemo<ObdState>(
    () => ({
      device,
      vehicle,
      evidence,
      transport,
      report,
      faults: report?.faults ?? null,
      connect: (d, identification, t) => {
        setDevice(d);
        setTransport(t ?? null);
        if (identification) {
          // Real identification: vehicle + evidence from the pipeline
          // (ECU mode 09 read, vPIC decode, consistency checks).
          setVehicle(identification.vehicle);
          setEvidence(identification.evidence);
        } else {
          // Defensive fallback — screens should normally pass an
          // identification, but a bare connect still has to leave the
          // dashboard in a state that admits it knows nothing.
          const fallback = unidentified("Vehicle identification was skipped.");
          setVehicle(fallback.vehicle);
          setEvidence(fallback.evidence);
        }
        setReport(null);
      },
      disconnect: () => {
        setDevice(null);
        setVehicle(null);
        setEvidence(null);
        setTransport(null);
        setReport(null);
      },
      runScan: async (opts) => {
        if (!transport) throw new Error("Adapter is not connected.");
        const result = await transport.readDiagnostics(opts);
        // Mode 09 is answered by the same ECUs the pass just heard from, so
        // a car that answered now can be asked again. This matters because
        // connecting is done before the engine is started: the first read
        // gets nothing, and without a second one the whole report carries
        // the identity of a key-off car — no make, no model, no VIN.
        //
        // A fragment counts as nothing here. `!vehicle?.vin` was the old
        // test, and it skipped the one car the second read exists for: five
        // characters off a KWP2000 frame are truthy, so the car that gave
        // `B3338` was never asked again, and the sweep written to look under
        // the neighbouring options could not run at all.
        if (!isFullVin(vehicle?.vin ?? "")) {
          opts?.onProgress?.({ stage: "Identifying the vehicle…", index: 1, total: 1 });
          try {
            // Here, and only here, the read may spend twelve seconds probing
            // the identification block: the codes are already in `result`, and
            // a bus this pass has just talked to is the one moment in the app
            // where nothing else is waiting on it.
            const again = await identifyVehicle(transport, {
              sweepIdentification: true,
              moduleAddresses: moduleAddressesIn(result),
            });
            // The evidence is kept whether or not a VIN came back, and the
            // asymmetry with the line below is the point. A vehicle without a
            // VIN is not worth setting — the dashboard would keep the name it
            // already had. The *reads* are, always: this pass is the one that
            // ran on a warm bus, and when it finds no VIN its rows are the
            // only record of what the car actually said (`NO DATA`, `7F 09
            // 12`, `STOPPED`) — exactly the case where somebody needs them,
            // and exactly the case the old `if (again.vehicle.vin)` threw
            // away, leaving the key-off read on screen as the final word.
            if (again.vehicle.vin) setVehicle(again.vehicle);
            setEvidence(again.evidence);
          } catch (err) {
            // Best effort: the report stands without a name on it. But not
            // without a note that the attempt was made and how it ended.
            // `evidence` is set by every connect, so the fallback is for the
            // impossible case only — and it carries a reason rather than an
            // empty string, which the screen would render as a warning row
            // with nothing written in it.
            const before = evidence ?? unidentified("Vehicle identification was skipped.").evidence;
            setEvidence({
              ...before,
              reads: [...(before.reads ?? []), secondReadFailed(err)],
            });
          }
        }
        setReport(result);
        return result;
      },
      clearScan: () => setReport(null),
    }),
    [device, vehicle, evidence, transport, report],
  );

  return <ObdCtx.Provider value={value}>{children}</ObdCtx.Provider>;
}

export function useObd(): ObdState {
  const ctx = useContext(ObdCtx);
  if (!ctx) throw new Error("useObd must be used within ObdProvider");
  return ctx;
}
