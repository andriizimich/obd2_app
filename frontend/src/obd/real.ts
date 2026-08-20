// Composite transport for real adapters: scans BOTH classic Bluetooth
// (SPP — most cheap ELM327 clones) and BLE (Vgate iCar Pro, vLinker, …)
// and routes the connection by what kind of device was picked. The user
// sees one plain list; the ELM327 handshake decides whether the device
// is the adapter.

import { getBleTransport } from "@/src/obd/ble";
import { getClassicTransport } from "@/src/obd/classic";
import type { AdapterInfo, ObdTransport, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError, OdbScanError } from "@/src/obd/transport";
import type { ObdDevice } from "@/src/obd/types";

export class RealTransport implements ObdTransport {
  readonly mode = "real" as const;

  private ble = getBleTransport();
  private classic = getClassicTransport();
  private active: ObdTransport | null = null;

  async scanDevices(): Promise<ObdDevice[]> {
    const [classicResult, bleResult] = await Promise.allSettled([
      this.classic.scanDevices(),
      this.ble.scanDevices(),
    ]);
    const out: ObdDevice[] = [];
    if (classicResult.status === "fulfilled") out.push(...classicResult.value);
    if (bleResult.status === "fulfilled") out.push(...bleResult.value);
    if (out.length === 0) {
      throw new OdbScanError("none-found", "No Bluetooth devices found.");
    }
    // Classic adapters first — the most common type of ELM327 clone.
    const weight = (d: ObdDevice) => (d.kind === "classic" ? 0 : 1);
    return out.sort(
      (a, b) => weight(a) - weight(b) || (b.rssi ?? -999) - (a.rssi ?? -999),
    );
  }

  async connect(device: ObdDevice): Promise<AdapterInfo> {
    const active = device.kind === "ble" ? this.ble : this.classic;
    this.active = active;
    return active.connect(device);
  }

  async readVehicleInfo(): Promise<VehicleInfo> {
    if (!this.active) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    return this.active.readVehicleInfo();
  }

  disconnect(): void {
    this.ble.disconnect();
    this.classic.disconnect();
    this.active = null;
  }
}
