import React, { createContext, useContext, useMemo, useState } from "react";

import type { Fault, ObdDevice, Vehicle } from "@/src/demo/obd";
import { generateFaults, generateVehicle } from "@/src/demo/obd";

type ObdState = {
  device: ObdDevice | null;
  vehicle: Vehicle | null;
  faults: Fault[] | null; // result of the most recent scan (null = not scanned yet)
  connect: (device: ObdDevice) => void;
  disconnect: () => void;
  runScan: () => Fault[];
  clearScan: () => void;
};

const ObdCtx = createContext<ObdState | null>(null);

export function ObdProvider({ children }: { children: React.ReactNode }) {
  const [device, setDevice] = useState<ObdDevice | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [faults, setFaults] = useState<Fault[] | null>(null);

  const value = useMemo<ObdState>(
    () => ({
      device,
      vehicle,
      faults,
      connect: (d) => {
        setDevice(d);
        setVehicle(generateVehicle());
        setFaults(null);
      },
      disconnect: () => {
        setDevice(null);
        setVehicle(null);
        setFaults(null);
      },
      runScan: () => {
        const result = generateFaults();
        setFaults(result);
        return result;
      },
      clearScan: () => setFaults(null),
    }),
    [device, vehicle, faults],
  );

  return <ObdCtx.Provider value={value}>{children}</ObdCtx.Provider>;
}

export function useObd(): ObdState {
  const ctx = useContext(ObdCtx);
  if (!ctx) throw new Error("useObd must be used within ObdProvider");
  return ctx;
}
