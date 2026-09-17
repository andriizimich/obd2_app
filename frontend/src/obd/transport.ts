// Transport abstraction: one interface over the real adapter.
// BleTransport (src/obd/ble.ts) talks to a BLE ELM327, ClassicTransport
// (src/obd/classic.ts) to a Bluetooth Classic one, and RealTransport
// (src/obd/real.ts) picks between them. Screens never import
// implementations directly — they get one from src/obd/index.ts.

import type {
  Coverage,
  DiagnosticReport,
  DiagnosticsOptions,
  VehicleInfoOptions,
  ObdDevice,
} from "@/src/obd/types";

/** Result of a successful adapter handshake. */
export type AdapterInfo = {
  /** Adapter identification string (ATI response), e.g. "ELM327 v1.5". */
  adapterId: string | null;
};

export type ScanFailure =
  | "bluetooth-off"
  | "permission-denied"
  | "unsupported"
  | "none-found";

export type ConnectFailure = "handshake" | "disconnected";

/** Structured errors so screens can show a fitting message. */
export class OdbScanError extends Error {
  constructor(
    readonly kind: ScanFailure,
    message: string,
  ) {
    super(message);
  }
}

export class OdbConnectError extends Error {
  constructor(
    readonly kind: ConnectFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Vehicle data read from the ECU (mode 09). Every field is best-effort —
 *  older cars and some ECUs answer only a subset. */
export type VehicleInfo = {
  /** VIN from mode 09, PID 02 (17 chars when present), or — on a bus where
   *  that PID does not exist — from the maker's own `1A 90`. */
  vin: string | null;
  /** Which of the two requests above produced `vin`: `"0902"`, `"1A 90"`, or
   *  null when neither did. */
  vinFrom?: string | null;
  /** Calibration IDs from mode 09, PID 04. */
  calid: string[];
  /** ECU name from mode 09, PID 0A. */
  ecuName: string | null;
  /** Detected OBD protocol (ATDPN), e.g. "ISO 15765-4 (CAN 11-bit/500k)". */
  protocol: string | null;
  /** Odometer in whole kilometres (mode 01, PID A6). Null when the ECU does
   *  not implement the PID — the standard only added it for 2019+ vehicles,
   *  so most cars answer NO DATA. Never derived from PID 31: that counter
   *  resets on every code clear and is not the odometer. */
  mileage?: number | null;
  /** How each connect-time read went, in the same shape the scan reports its
   *  own. Optional: a transport that predates it, and every saved scan,
   *  simply has none. */
  reads?: Coverage[];
  /** The adapter's own lines from those reads (capped) — what it takes to
   *  tell "the ECU said NO DATA" from "the adapter never answered". */
  rawLines?: string[];
};

export interface ObdTransport {
  /** Discover nearby OBD adapters. Resolves with [] when nothing found. */
  scanDevices(): Promise<ObdDevice[]>;

  /**
   * Connect to the adapter and verify the ELM327 handshake
   * (ATZ reset + ATI identification). Throws OdbConnectError.
   */
  connect(device: ObdDevice): Promise<AdapterInfo>;

  /** Read vehicle information from the ECU. Requires an active connection;
   *  individual fields may be null when unsupported.
   *
   *  `opts.sweepIdentification` is the caller's permission to probe the whole
   *  identification block, which costs twelve seconds and is not asked for by
   *  default — see {@link VehicleInfoOptions}. */
  readVehicleInfo(opts?: VehicleInfoOptions): Promise<VehicleInfo>;

  /**
   * Run the diagnostic pass — fault codes, lamp state and odometer — and
   * report what was read alongside what was not.
   *
   * Resolves for every outcome a connected adapter can produce, including
   * "this vehicle answers nothing": a rejected promise here reaches a
   * progress screen, where it is indistinguishable from a hang.
   */
  readDiagnostics(opts?: DiagnosticsOptions): Promise<DiagnosticReport>;

  /** Drop the active connection, if any. */
  disconnect(): void;
}
