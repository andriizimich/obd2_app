// Canonical types shared by both transports (demo and real BLE).
// Kept free of any transport-specific fields.

export type ObdDevice = {
  /** Unique identifier. For BLE this is the peripheral id (Android MAC-style / iOS uuid). */
  id: string;
  name: string;
  /** MAC address for BLE devices; equal to id on iOS. */
  address: string;
  rssi: number | null;
};

/**
 * How much we trust the vehicle identification.
 * "high"   — full decode: make + model + year (+ engine/transmission data)
 * "medium" — make + model + year decoded, no deeper data
 * "low"    — partial decode (some fields missing or uncertain)
 * "manual" — corrected by the user (reserved for the correction loop)
 * "unknown" — nothing useful decoded yet
 */
export type VehicleConfidence = "high" | "medium" | "low" | "manual" | "unknown";

export type Vehicle = {
  vin: string;
  make: string;
  model: string;
  year: number;
  /** Null until a real odometer read exists (mode 01 PID A6, not
   *  supported by every ECU); demo data always sets it. */
  mileage: number | null;
  /** Enrichment fields from the VIN decoder (vPIC) — optional for
   *  backward compatibility with saved scans. */
  engineModel?: string;
  engineCylinders?: number;
  fuelType?: string;
  transmission?: string;
  driveType?: string;
  confidence?: VehicleConfidence;
};

/** Everything we learned about the vehicle from the ECU and decoders —
 *  the basis of the validation score shown on the dashboard. */
export type IdentificationEvidence = {
  source: "demo" | "ecu";
  vinFromEcu: string | null;
  calid: string[];
  ecuName: string | null;
  protocol: string | null;
  vpicStatus: "ok" | "partial" | "error" | "not-run";
  warnings: string[];
};

export type Fault = {
  code: string;
  group: string; // engine | transmission | lights | brakes | emissions | electrical | body
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
};
