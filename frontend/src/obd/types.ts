// Canonical types shared by the transports and the diagnostic pipeline.
// Kept free of any transport-specific fields.

export type ObdDevice = {
  /** Unique identifier (BLE peripheral id or classic MAC address). */
  id: string;
  name: string;
  /** MAC address; equal to id for BLE devices on iOS. */
  address: string;
  rssi: number | null;
  /** Which transport can talk to this device (internal — not shown). */
  kind?: "ble" | "classic";
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
  /** Whole kilometres from mode 01 PID A6, or null when the ECU does not
   *  implement that PID — the standard only added it for 2019+ vehicles. */
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
  vinFromEcu: string | null;
  calid: string[];
  ecuName: string | null;
  protocol: string | null;
  vpicStatus: "ok" | "partial" | "error" | "not-run";
  warnings: string[];
};

export type FaultGroup =
  | "engine"
  | "transmission"
  | "lights"
  | "brakes"
  | "emissions"
  | "electrical"
  | "body";

export type FaultSeverity = "low" | "medium" | "high";

/** Which of the three DTC lists a code came from (J1979 modes 03 / 07 / 0A). */
export type DtcStatus = "stored" | "pending" | "permanent";

export type Fault = {
  code: string;
  group: FaultGroup;
  title: string;
  description: string;
  severity: FaultSeverity;
  /** Omitted means "stored" — saves written before this field existed. */
  status?: DtcStatus;
  /** CAN id of the module that reported the code, or null when the adapter
   *  refused ATH1 and the reply carried no address to attribute it to. */
  moduleId?: number | null;
  /** Human label for {@link moduleId}, e.g. "Engine". */
  module?: string | null;
  /** Typical causes, when the bundled dictionary has any for this code. */
  causes?: string[];
  /** False when title/description came from the structural decode because
   *  the bundled dictionary has no entry for this code. */
  known?: boolean;
};

/**
 * How a single read went. `"empty"` and `"unsupported"` are deliberately
 * distinct: `47 00` (no pending codes) is good news, `NO DATA` is a missing
 * feature. Collapsing them lies in both directions — a healthy car reads as
 * broken, or an unreadable one reads as healthy.
 */
export type CoverageStatus =
  | "ok"
  | "empty"
  | "unsupported"
  | "error"
  | "skipped";

export type Coverage = {
  /** The request that produced this line, e.g. "03" or "01A6". */
  request: string;
  label: string;
  status: CoverageStatus;
  detail?: string;
};

export type DiagnosticStatus = {
  /** Byte A bit 7 — the malfunction indicator lamp is commanded on. */
  milOn: boolean;
  /** Byte A bits 6-0 — the ECU's own count of stored codes. */
  dtcCount: number;
  /** Byte B bit 3 — compression ignition (diesel). */
  compressionIgnition: boolean;
};

export type DiagnosticReport = {
  at: number;
  /** False when the adapter would not turn headers on: module attribution
   *  is then absent, which is a loss, not a guess. */
  headersOn: boolean;
  protocol: string | null;
  status: DiagnosticStatus | null;
  mileage: number | null;
  faults: Fault[];
  coverage: Coverage[];
  /** Discrepancies shown as they are instead of being smoothed over. */
  notes: string[];
  /** Raw adapter lines (capped) — the debug surface for a car we cannot
   *  reach from here. */
  rawLines: string[];
};

/**
 * One command of the adapter compatibility check, with the reply exactly as
 * the adapter sent it. Nothing here is parsed: the point is to see what a
 * particular clone actually prints, which no offline fixture can tell us.
 */
export type CompatibilityLine = {
  /** The command as sent, e.g. "ATH1". */
  command: string;
  /** What the command asks, in plain English. */
  label: string;
  /** Raw reply lines, or a single "<no reply: …>" line when it timed out. */
  lines: string[];
};

export type DiagnosticsOptions = {
  /** Skip the mode 01 reads — a fast pass that only collects codes. */
  faultsOnly?: boolean;
  onProgress?: (p: { stage: string; index: number; total: number }) => void;
  /** Ceiling for the whole pass. */
  deadlineMs?: number;
  /** Per-command timeout; tests drive this down to milliseconds. */
  timeoutMs?: number;
};
