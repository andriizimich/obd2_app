import React, { createContext, useContext, useMemo, useState } from "react";

import type { Identification } from "@/src/obd/identify";
import { unidentified } from "@/src/obd/identify";
import type { ObdTransport } from "@/src/obd/transport";
import type {
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
