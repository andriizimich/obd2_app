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
  /** The request the VIN above came back from — `"0902"` (the standard PID)
   *  or `"1A 90"` (the maker's own service), and null when no VIN came back
   *  at all. Two questions are asked for a VIN, and which one answered is
   *  the difference between a car that declines mode 09 and an adapter that
   *  cannot carry it. */
  vinFrom?: string | null;
  calid: string[];
  ecuName: string | null;
  protocol: string | null;
  vpicStatus: "ok" | "partial" | "error" | "not-run";
  warnings: string[];
  /** How each connect-time read went. Four dashes above say only that nothing
   *  came back; these say which of the four ways it did not — and that is the
   *  whole diagnosis when a car scans fine and identifies not at all. */
  reads?: Coverage[];
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
  /**
   * What the adapter actually sent back for this request (capped).
   *
   * The status says *that* a read worked; it cannot say what came back, and
   * on a car whose reply does not match any fixture that is the whole
   * question. A VIN read that yields `B3338` is either a car answering in a
   * layout the parser does not know or a parser anchored on the wrong bytes,
   * and no amount of staring at the parsed fragment tells the two apart —
   * the reply itself does. Kept per read, not merged into one transcript,
   * because the lines only mean something next to the request that caused
   * them: a flat transcript of six reads is six answers with no questions.
   */
  raw?: string[];
};

/** One module's answer to PID 01. */
export type ModuleStatus = {
  moduleId: number | null;
  module: string | null;
  milOn: boolean;
  dtcCount: number;
  /** Byte B bit 3 of that module's own answer. */
  compressionIgnition: boolean;
};

export type DiagnosticStatus = {
  /** Byte A bit 7 — the malfunction indicator lamp is commanded on. */
  milOn: boolean;
  /** Byte A bits 6-0 — the ECU's own count of stored codes. */
  dtcCount: number;
  /** Byte B bit 3 — compression ignition (diesel). */
  compressionIgnition: boolean;
  /** One entry per module that answered PID 01. Absent on reports saved
   *  before modules were tracked, hence optional. */
  modules?: ModuleStatus[];
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

export type VehicleInfoOptions = {
  /**
   * Whether this read may spend twelve seconds asking every `1A 80–9F`
   * option for an identification the car has not otherwise given.
   *
   * Off by default, and that default is the point. Asked at connect, the
   * sweep runs before the driver has read a single fault code, and on
   * 2026-09-17 it was followed by a pass that read nothing at all (`03 ✗ ·
   * 07 ✗ · 0A ✗ · 0101 ✗ · 01A6 ✗`, the adapter answering `NO DATA` to
   * each) on a car that had scanned cleanly that morning without it. Nobody
   * has yet shown the sweep caused that, which is exactly why it is not
   * worth the codes: reading codes is what this app is for.
   *
   * Set only where the codes are already in hand and nothing else needs the
   * bus afterwards — the re-identification the scan runs at its end, on a
   * bus that pass has just proved is answering.
   */
  sweepIdentification?: boolean;

  /**
   * Module addresses a diagnostic pass has already seen on this bus, so the
   * VIN read can ask each of them directly instead of broadcasting.
   *
   * A functional request is heard by every module at once, and on a car with
   * two controllers answering `1A 90` their frames interleave into one reply
   * that the parser can only read runs out of. The addresses come from the
   * scan — a pass that read fault codes has already named who is on the bus —
   * and are empty at connect time, when nothing has looked yet.
   */
  moduleAddresses?: number[];
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
