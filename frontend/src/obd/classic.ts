// Classic Bluetooth (SPP) transport for ELM327 adapters — the protocol
// used by most cheap "OBDII Bluetooth" clones. Android-only; iOS does not
// expose SPP without MFi certification.
//
// Discovery/connection run entirely inside the app — no pre-pairing in
// system settings is needed. If Android asks for a PIN during connection,
// the standard ELM327 codes are 1234 or 0000.

import RNBluetoothClassic, {
  type BluetoothDevice,
  type BluetoothEventSubscription,
} from "react-native-bluetooth-classic";

import { Elm327Channel } from "@/src/obd/at";
import { ensureBleReady } from "@/src/obd/ble";
import { elm327Handshake, readVehicleInfoOver } from "@/src/obd/mode09";
import type { AdapterInfo, ObdTransport, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError, OdbScanError } from "@/src/obd/transport";
import type { ObdDevice } from "@/src/obd/types";

const POST_CONNECT_SETTLE_MS = 500;

function toObdDevice(device: BluetoothDevice): ObdDevice {
  return {
    id: device.address,
    name: device.name || "Unnamed device",
    address: device.address,
    rssi: null,
    kind: "classic",
  };
}

export class ClassicTransport implements ObdTransport {
  readonly mode = "real" as const;

  private device: BluetoothDevice | null = null;
  private elm: Elm327Channel | null = null;
  private unsubscribe: BluetoothEventSubscription | null = null;

  async scanDevices(): Promise<ObdDevice[]> {
    await ensureBleReady();
    let found: BluetoothDevice[] = [];
    try {
      found = await RNBluetoothClassic.startDiscovery();
    } catch {
      throw new OdbScanError(
        "none-found",
        "No Bluetooth devices found.",
      );
    }
    if (found.length === 0) {
      throw new OdbScanError(
        "none-found",
        "No Bluetooth devices found.",
      );
    }
    return found.map(toObdDevice);
  }

  async connect(device: ObdDevice): Promise<AdapterInfo> {
    let connected: BluetoothDevice;
    try {
      // Android shows the pairing dialog itself if the adapter is not
      // bonded yet (ELM327 PINs are 1234 / 0000).
      connected = await RNBluetoothClassic.connectToDevice(device.address);
    } catch {
      throw new OdbConnectError(
        "disconnected",
        "Could not connect to the device. If Android asked for a PIN, try 1234 or 0000.",
      );
    }
    this.device = connected;

    // Cheap clones need a beat after the RFCOMM link is up.
    await new Promise((r) => setTimeout(r, POST_CONNECT_SETTLE_MS));

    const elm = new Elm327Channel((raw) => this.write(raw));
    this.elm = elm;
    this.unsubscribe = connected.onDataReceived((event) => {
      elm.feed(String(event.data));
    });

    return elm327Handshake(elm);
  }

  async readVehicleInfo(): Promise<VehicleInfo> {
    const elm = this.elm;
    if (!elm || !this.device) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    return readVehicleInfoOver(elm);
  }

  disconnect(): void {
    try {
      this.unsubscribe?.remove();
    } catch {
      // Already removed.
    }
    this.unsubscribe = null;
    this.elm?.dispose();
    this.elm = null;
    const device = this.device;
    this.device = null;
    if (device) {
      device.disconnect().catch(() => {});
    }
  }

  private async write(raw: string): Promise<void> {
    const device = this.device;
    if (!device) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    const ok = await device.write(raw);
    if (!ok) {
      throw new OdbConnectError("disconnected", "Write to the adapter failed.");
    }
  }
}

/** Singleton — the RFCOMM connection must not be duplicated. */
let classicTransport: ClassicTransport | null = null;

export function getClassicTransport(): ClassicTransport {
  if (!classicTransport) classicTransport = new ClassicTransport();
  return classicTransport;
}
