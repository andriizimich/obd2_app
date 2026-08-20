// Transport abstraction: one interface, two implementations.
// DemoTransport (src/obd/demo.ts) keeps the simulation path used during
// development; BleTransport (src/obd/ble.ts) talks to a real ELM327
// adapter over BLE. Screens never import implementations directly —
// they get a transport from src/obd/index.ts by mode.

import type { ObdDevice, Vehicle } from "@/src/obd/types";

export type OdbMode = "demo" | "real";

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
  /** VIN from mode 09, PID 02 (17 chars when present). */
  vin: string | null;
  /** Calibration IDs from mode 09, PID 04. */
  calid: string[];
  /** ECU name from mode 09, PID 0A. */
  ecuName: string | null;
  /** Detected OBD protocol (ATDPN), e.g. "ISO 15765-4 (CAN 11-bit/500k)". */
  protocol: string | null;
  /** Demo transport fills this with its generated vehicle — real transports
   *  leave it undefined and the caller builds the vehicle from the fields
   *  above. */
  vehicle?: Vehicle;
};

export interface ObdTransport {
  readonly mode: OdbMode;

  /** Discover nearby OBD adapters. Resolves with [] when nothing found. */
  scanDevices(): Promise<ObdDevice[]>;

  /**
   * Connect to the adapter and verify the ELM327 handshake
   * (ATZ reset + ATI identification). Throws OdbConnectError.
   */
  connect(device: ObdDevice): Promise<AdapterInfo>;

  /** Read vehicle information from the ECU. Requires an active connection;
   *  individual fields may be null when unsupported. */
  readVehicleInfo(): Promise<VehicleInfo>;

  /** Drop the active connection, if any. */
  disconnect(): void;
}
