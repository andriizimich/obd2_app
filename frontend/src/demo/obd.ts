// Demo OBD-II simulation layer.
// Generates fake Bluetooth adapters, vehicle info (read from ECU) and stored
// fault codes (DTCs). This is swapped for real BLE later.

// Canonical types live in src/obd/types.ts; re-exported here so existing
// imports keep working while transports share one definition.
import type { Fault, ObdDevice, Vehicle } from "@/src/obd/types";

export type { Fault, ObdDevice, Vehicle };

import { buildDemoVin } from "@/src/utils/vin";

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const DEMO_DEVICES: ObdDevice[] = [
  { id: "d1", name: "OBDII ELM327 v1.5", address: "00:1D:A5:68:98:8B", rssi: -52, obdHint: true },
  { id: "d2", name: "Vgate iCar Pro BLE", address: "AC:9A:22:1F:04:7C", rssi: -67, obdHint: true },
];

// WMI is the real-world manufacturer code — demo VINs are built with a valid
// check digit and decode consistently with the rest of the entry. Enrichment
// fields mirror what a full vPIC decode returns, so the UI is exercised in
// demo mode too.
const VEHICLES: (Omit<Vehicle, "vin" | "mileage"> & { wmi: string })[] = [
  {
    make: "Volkswagen", model: "Passat B8", year: 2018, wmi: "WVW",
    engineModel: "2.0 TDI", engineCylinders: 4, fuelType: "Diesel",
    transmission: "Automatic", driveType: "FWD", confidence: "high",
  },
  {
    make: "BMW", model: "320i F30", year: 2016, wmi: "WBA",
    engineModel: "B48 2.0L", engineCylinders: 4, fuelType: "Gasoline",
    transmission: "Automatic", driveType: "RWD", confidence: "high",
  },
  {
    make: "Toyota", model: "Camry XV70", year: 2020, wmi: "4T1",
    engineModel: "2.5L A25A-FKS", engineCylinders: 4, fuelType: "Gasoline",
    transmission: "Automatic", driveType: "FWD", confidence: "high",
  },
  {
    make: "Audi", model: "A4 B9", year: 2019, wmi: "WAU",
    engineModel: "2.0 TFSI", engineCylinders: 4, fuelType: "Gasoline",
    transmission: "Dual-clutch automatic", driveType: "AWD/4WD", confidence: "high",
  },
  {
    make: "Ford", model: "Focus Mk3", year: 2015, wmi: "1FA",
    engineModel: "1.6 EcoBoost", engineCylinders: 4, fuelType: "Gasoline",
    transmission: "Manual", driveType: "FWD", confidence: "high",
  },
  {
    make: "Mercedes-Benz", model: "C 200 W205", year: 2017, wmi: "WDD",
    engineModel: "M274 2.0L", engineCylinders: 4, fuelType: "Gasoline",
    transmission: "Automatic", driveType: "RWD", confidence: "high",
  },
];

export const generateVehicle = (): Vehicle => {
  const base = rand(VEHICLES);
  const { wmi, ...vehicle } = base;
  return {
    ...vehicle,
    vin: buildDemoVin(wmi, base.year),
    mileage: randInt(45_000, 235_000),
  };
};

const FAULT_POOL: Fault[] = [
  {
    code: "P0300",
    group: "engine",
    title: "Random / Multiple Cylinder Misfire",
    description: "Engine control module detected misfires across multiple cylinders.",
    severity: "high",
  },
  {
    code: "P0171",
    group: "engine",
    title: "System Too Lean (Bank 1)",
    description: "Air-fuel mixture is leaner than optimal on bank 1.",
    severity: "medium",
  },
  {
    code: "P0420",
    group: "emissions",
    title: "Catalyst Efficiency Below Threshold",
    description: "Catalytic converter is not operating at expected efficiency.",
    severity: "medium",
  },
  {
    code: "P0128",
    group: "engine",
    title: "Coolant Thermostat Below Regulating Temp",
    description: "Engine coolant does not reach the required operating temperature.",
    severity: "low",
  },
  {
    code: "P0740",
    group: "transmission",
    title: "Torque Converter Clutch Circuit Malfunction",
    description: "Fault detected in the torque converter lock-up clutch circuit.",
    severity: "high",
  },
  {
    code: "P0705",
    group: "transmission",
    title: "Transmission Range Sensor Circuit",
    description: "Range sensor reports an invalid gear position signal.",
    severity: "medium",
  },
  {
    code: "C1201",
    group: "brakes",
    title: "ABS Control System Malfunction",
    description: "Anti-lock braking system control module reported a fault.",
    severity: "high",
  },
  {
    code: "B1318",
    group: "electrical",
    title: "Battery Voltage Low",
    description: "System supply voltage dropped below the required threshold.",
    severity: "medium",
  },
  {
    code: "P2098",
    group: "emissions",
    title: "Post Catalyst Fuel Trim Too Lean (Bank 2)",
    description: "Downstream oxygen sensor reports lean fuel trim on bank 2.",
    severity: "low",
  },
  {
    code: "B1013",
    group: "lights",
    title: "Left Headlamp Circuit Failure",
    description: "Open or short circuit detected on the left headlamp output.",
    severity: "low",
  },
  {
    code: "P0455",
    group: "emissions",
    title: "EVAP System Large Leak Detected",
    description: "Evaporative emission system detected a large leak (loose fuel cap).",
    severity: "low",
  },
  {
    code: "U0100",
    group: "electrical",
    title: "Lost Communication with ECM/PCM",
    description: "CAN bus communication with the engine control module was lost.",
    severity: "high",
  },
];

// Randomly returns 0 (clean) up to 4 stored fault codes.
export const generateFaults = (): Fault[] => {
  // ~25% chance of a clean bill of health.
  if (Math.random() < 0.25) return [];
  const count = randInt(1, 4);
  const pool = [...FAULT_POOL];
  const out: Fault[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
};

export const GROUP_LABELS: Record<string, string> = {
  engine: "Engine",
  transmission: "Transmission",
  lights: "Lights",
  brakes: "Brakes",
  emissions: "Emissions",
  electrical: "Electrical",
  body: "Body",
};
