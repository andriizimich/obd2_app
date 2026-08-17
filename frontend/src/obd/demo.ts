// Demo transport: same interface as the real BLE transport, driven by the
// existing simulation layer (src/demo/obd.ts). Delays mimic a real scan
// and connection so the UI timing stays honest.

import { DEMO_DEVICES, generateVehicle } from "@/src/demo/obd";
import type { AdapterInfo, ObdTransport, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError, OdbScanError } from "@/src/obd/transport";
import type { ObdDevice } from "@/src/obd/types";

const SCAN_DELAY_MS = 2200;
const CONNECT_DELAY_MS = 1400;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DemoTransport implements ObdTransport {
  readonly mode = "demo" as const;

  /** Toggled by the "Simulate adapter unplugged" switch on the connect screen. */
  simulateUnplugged = false;

  async scanDevices(): Promise<ObdDevice[]> {
    await delay(SCAN_DELAY_MS);
    if (this.simulateUnplugged) {
      throw new OdbScanError(
        "none-found",
        "No OBD-II adapter detected (simulated).",
      );
    }
    return DEMO_DEVICES;
  }

  async connect(device: ObdDevice): Promise<AdapterInfo> {
    await delay(CONNECT_DELAY_MS);
    if (this.simulateUnplugged) {
      throw new OdbConnectError(
        "disconnected",
        "Adapter disconnected (simulated).",
      );
    }
    return { adapterId: device.name };
  }

  async readVehicleInfo(): Promise<VehicleInfo> {
    // The demo "ECU" yields the same generated vehicle the caller shows —
    // this exercises the full identification pipeline in demo mode.
    const vehicle = generateVehicle();
    return {
      vin: vehicle.vin,
      calid: ["DEMO-CALID-01"],
      ecuName: "ECM-EngineControl",
      protocol: "ISO 15765-4 (CAN 11-bit/500k)",
      vehicle,
    };
  }

  disconnect(): void {}
}
