import React, { createContext, useContext, useMemo, useState } from "react";

import type { Fault, ObdDevice, Vehicle } from "@/src/demo/obd";
import { generateFaults, generateVehicle } from "@/src/demo/obd";
import type { Identification } from "@/src/obd/identify";
import type { IdentificationEvidence } from "@/src/obd/types";

type ObdState = {
  device: ObdDevice | null;
  vehicle: Vehicle | null;
  /** How the vehicle was identified (ECU evidence, warnings, score basis). */
  evidence: IdentificationEvidence | null;
  faults: Fault[] | null; // result of the most recent scan (null = not scanned yet)
  connect: (device: ObdDevice, identification?: Identification) => void;
  disconnect: () => void;
  runScan: () => Fault[];
  clearScan: () => void;
};

const ObdCtx = createContext<ObdState | null>(null);

export function ObdProvider({ children }: { children: React.ReactNode }) {
  const [device, setDevice] = useState<ObdDevice | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [evidence, setEvidence] = useState<IdentificationEvidence | null>(null);
  const [faults, setFaults] = useState<Fault[] | null>(null);

  const value = useMemo<ObdState>(
    () => ({
      device,
      vehicle,
      evidence,
      faults,
      connect: (d, identification) => {
        setDevice(d);
        if (identification) {
          // Real identification: vehicle + evidence from the pipeline
          // (ECU mode 09 read, vPIC decode, consistency checks).
          setVehicle(identification.vehicle);
          setEvidence(identification.evidence);
        } else {
          // Defensive fallback — screens should normally pass an
          // identification, but a bare connect keeps working with a
          // generated demo vehicle.
          setVehicle(generateVehicle());
          setEvidence(null);
        }
        setFaults(null);
      },
      disconnect: () => {
        setDevice(null);
        setVehicle(null);
        setEvidence(null);
        setFaults(null);
      },
      runScan: () => {
        const result = generateFaults();
        setFaults(result);
        return result;
      },
      clearScan: () => setFaults(null),
    }),
    [device, vehicle, evidence, faults],
  );

  return <ObdCtx.Provider value={value}>{children}</ObdCtx.Provider>;
}

export function useObd(): ObdState {
  const ctx = useContext(ObdCtx);
  if (!ctx) throw new Error("useObd must be used within ObdProvider");
  return ctx;
}
