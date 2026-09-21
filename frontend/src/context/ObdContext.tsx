import React, { createContext, useContext, useMemo, useState } from "react";

import { unidentified } from "@/src/obd/identify";
import type { ObdTransport } from "@/src/obd/transport";
import type {
  DiagnosticReport,
  DiagnosticsOptions,
  Fault,
  ObdDevice,
  Vehicle,
} from "@/src/obd/types";

type ObdState = {
  device: ObdDevice | null;
  vehicle: Vehicle | null;
  /** The transport that owns the live connection — the scan goes through it. */
  transport: ObdTransport | null;
  /** The most recent diagnostic pass, or null before the first one. */
  report: DiagnosticReport | null;
  faults: Fault[] | null; // derived from `report`, null = not scanned yet
  connect: (device: ObdDevice, transport?: ObdTransport) => void;
  disconnect: () => void;
  /**
   * Name the car by hand.
   *
   * This is the only way a vehicle ever gets its identity now. The adapter
   * cannot be asked: on the cars this app has met, mode 09 answered `BUS
   * BUSY`, `NO DATA`, or five characters of a KWP2000 frame, and a screen
   * that waits for a VIN before it will tell a driver anything is a screen
   * that never tells them anything. The picker in `app/car.tsx` supplies
   * make, model, generation and year; there is no VIN and the confidence
   * says so.
   */
  setVehicle: (vehicle: Vehicle) => void;
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
  const [transport, setTransport] = useState<ObdTransport | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);

  const value = useMemo<ObdState>(
    () => ({
      device,
      vehicle,
      transport,
      report,
      faults: report?.faults ?? null,
      connect: (d, t) => {
        setDevice(d);
        setTransport(t ?? null);
        // The car is not known at connect time and must not be guessed at.
        // `unidentified` is a placeholder that says exactly that, so a
        // screen reached without passing the picker shows "Vehicle not
        // identified" rather than an empty line where a make should be.
        setVehicle(unidentified("Vehicle identification was skipped.").vehicle);
        setReport(null);
      },
      disconnect: () => {
        setDevice(null);
        setVehicle(null);
        setTransport(null);
        setReport(null);
      },
      runScan: async (opts) => {
        if (!transport) throw new Error("Adapter is not connected.");
        // The pass, and nothing else. It used to be followed by a second
        // mode 09 sweep whenever no full VIN had been read — which, on the
        // cars this app has actually met, was every single time: twelve
        // seconds of `1A 80…9F` on a bus that had just answered `BUS BUSY`,
        // with the driver watching a progress bar for a name the app now
        // asks for instead. The car is picked by hand on the way in
        // (`app/car.tsx`), so there is nothing left for that sweep to add
        // and a great deal of waiting for it to add it.
        const result = await transport.readDiagnostics(opts);
        setReport(result);
        return result;
      },
      setVehicle: (v) => setVehicle(v),
      clearScan: () => setReport(null),
    }),
    [device, vehicle, transport, report],
  );

  return <ObdCtx.Provider value={value}>{children}</ObdCtx.Provider>;
}

export function useObd(): ObdState {
  const ctx = useContext(ObdCtx);
  if (!ctx) throw new Error("useObd must be used within ObdProvider");
  return ctx;
}
