// Classic Bluetooth (SPP) transport for ELM327 adapters — the protocol
// used by most cheap "OBDII Bluetooth" clones. Android-only; iOS does not
// expose SPP without MFi certification.
//
// Discovery, pairing and connection all run inside the app — no trip to
// Android's Bluetooth settings is needed. Pairing is explicit: Android only
// raises its PIN dialog while a device is being bonded, and opening an
// RFCOMM socket does not bond, so the dialog has to be asked for by name.
// The standard ELM327 PINs are 1234 and 0000.

import RNBluetoothClassic, {
  type BluetoothDevice,
  type BluetoothEventSubscription,
} from "react-native-bluetooth-classic";

import { Elm327Channel } from "@/src/obd/at";
import { ensureBondedOver, type BondState } from "@/src/obd/bonding";
import { readDiagnosticsOver } from "@/src/obd/diagnostics";
import { ensureBleReady } from "@/src/obd/ble";
import { elm327Handshake, readVehicleInfoOver } from "@/src/obd/mode09";
import type { AdapterInfo, ObdTransport, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError, OdbScanError } from "@/src/obd/transport";
import type {
  DiagnosticReport,
  DiagnosticsOptions,
  VehicleInfoOptions,
  ObdDevice,
} from "@/src/obd/types";

const POST_CONNECT_SETTLE_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Native rejections carry the only description of what the socket refused
 *  to do, and it is the one line worth putting in front of the user. */
function nativeReason(err: unknown): string {
  const text =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "The adapter did not accept the connection.";
  return trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed;
}

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
    // Bond first. Android asks for the adapter's PIN only while bonding it,
    // and connectToDevice does not bond — it just opens an RFCOMM socket,
    // which an unbonded device refuses. That refusal was the whole of the
    // old failure: no dialog, no prompt, a dead end.
    if ((await this.ensureBonded(device.address)) === "refused") {
      throw new OdbConnectError(
        "disconnected",
        `Pairing with ${device.name} was not completed, so the adapter was ` +
          `never connected. Android asks for the adapter's PIN the first ` +
          `time — ELM327 clones use 1234 or 0000. If no prompt appeared, ` +
          `pair the adapter once in Android's Bluetooth settings and ` +
          `connect again. [Classic RFCOMM ${device.address}]`,
      );
    }

    let connected: BluetoothDevice;
    try {
      // The delimiter is not optional here, whatever the default suggests.
      // This library buffers incoming bytes and only hands a chunk to JS
      // when it finds its delimiter in the buffer — and that default is
      // "\n". An ELM327 terminates every line with "\r" alone, so with the
      // default the socket connects, the adapter answers, and not one byte
      // ever reaches the channel: the handshake times out on a link that is
      // perfectly healthy. An empty delimiter means "hand over whatever
      // arrived"; Elm327Channel does its own framing anyway.
      connected = await RNBluetoothClassic.connectToDevice(device.address, {
        delimiter: "",
      });
    } catch (err) {
      // The adapter's own words, not a guess about PINs: a bonded device
      // that still refuses has a different fault (busy, out of range, or a
      // clone that only accepts one socket) and only this text names it.
      throw new OdbConnectError(
        "disconnected",
        `Could not open the serial link to ${device.name}. ` +
          `${nativeReason(err)} [Classic RFCOMM ${device.address}]`,
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

    try {
      return await elm327Handshake(elm);
    } catch (err) {
      // Name the transport and the address on the one message the user can
      // screenshot — "no reply" over RFCOMM and over BLE are different
      // faults, and the address settles which adapter was tapped.
      if (err instanceof OdbConnectError) {
        throw new OdbConnectError(
          err.kind,
          `${err.message} [Classic RFCOMM ${device.address}]`,
        );
      }
      throw err;
    }
  }

  async readVehicleInfo(opts?: VehicleInfoOptions): Promise<VehicleInfo> {
    const elm = this.elm;
    if (!elm || !this.device) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    return readVehicleInfoOver(elm, undefined, opts);
  }

  async readDiagnostics(opts?: DiagnosticsOptions): Promise<DiagnosticReport> {
    const elm = this.elm;
    if (!elm || !this.device) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    return readDiagnosticsOver(elm, opts);
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

  /**
   * Make sure Android has bonded the adapter, asking it to if it has not.
   *
   * The decision itself lives in {@link ensureBondedOver}, where it can be
   * exercised without an adapter: this method is only the wiring from the
   * Bluetooth library to it.
   */
  private async ensureBonded(address: string): Promise<BondState> {
    return ensureBondedOver(address, {
      isBonded: (addr) => this.bondState(addr),
      // Deliberately not awaited — see BondDeps.requestPair.
      requestPair: (addr) => RNBluetoothClassic.pairDevice(addr),
      now: () => Date.now(),
      sleep,
    });
  }

  /** null when the bonded list cannot be read at all. */
  private async bondState(address: string): Promise<boolean | null> {
    try {
      const bonded = await RNBluetoothClassic.getBondedDevices();
      return bonded.some((d) => d.address === address);
    } catch {
      return null;
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
