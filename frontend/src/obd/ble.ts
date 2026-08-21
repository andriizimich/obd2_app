// Real BLE transport: scans for Bluetooth OBD-II adapters, connects and
// verifies the ELM327 handshake (ATZ + ATE0 + ATI) over the adapter's
// UART-like characteristic. Built on react-native-ble-plx.
//
// Cheap ELM327 BLE clones (Vgate iCar Pro, vLinker, Viecar, KW902, …) all
// expose a serial passthrough: one service with one writable +
// notifiable characteristic. There is no official UUID, so we sniff the
// service table instead of hardcoding a single one.

import {
  BleManager,
  ScanMode,
  type Characteristic,
  type Device,
  type Service,
  type Subscription,
} from "react-native-ble-plx";
import { PermissionsAndroid, Platform } from "react-native";

import { Elm327Channel } from "@/src/obd/at";
import {
  elm327Handshake,
  readVehicleInfoOver,
} from "@/src/obd/mode09";
import type { AdapterInfo, ObdTransport, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError, OdbScanError } from "@/src/obd/transport";
import type { ObdDevice } from "@/src/obd/types";

// Cheap ELM327 clones sometimes advertise only every few seconds —
// 12s gives them room without making the user wait forever.
const SCAN_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 15000;
// Some clones need a moment after the GATT link is up before they answer
// service discovery reliably.
const POST_CONNECT_SETTLE_MS = 700;

// Service UUID hints advertised by common BLE ELM327 adapters — used only
// to pick the serial channel AFTER connecting, never to filter the list.
const OBD_SERVICE_HINTS = ["fff0", "ffe0", "ffe5", "ff00", "ff10"];

let manager: BleManager | null = null;

/** Lazily created — constructing BleManager on web crashes the app. */
function getManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

/** Decode a base64 characteristic payload into UTF-8 text. */
function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeCommand(raw: string): string {
  return btoa(raw);
}

function toObdDevice(device: Device): ObdDevice {
  const name = device.name || device.localName;
  return {
    id: device.id,
    name: name || "Unnamed device",
    address: device.id,
    rssi: device.rssi,
    kind: "ble",
  };
}

/**
 * Ask for Android runtime permissions (API 31+: BLUETOOTH_SCAN/CONNECT;
 * older: location, which BLE scanning piggybacks on) and make sure the
 * Bluetooth radio is on.
 */
export async function ensureBleReady(): Promise<void> {
  if (Platform.OS === "ios") {
    const state = await getManager().state();
    if (state !== "PoweredOn") throw new OdbScanError("bluetooth-off", "Bluetooth is turned off.");
    return;
  }
  if (Platform.OS !== "android") {
    throw new OdbScanError("unsupported", "BLE is only supported on iOS and Android.");
  }

  const mgr = getManager();

  // Bluetooth first: prompt to turn it on BEFORE anything else (including
  // runtime permissions) — no point asking for permissions for a scan
  // that could not run anyway.
  const state = await mgr.state();
  if (state !== "PoweredOn") {
    // Shows the system "turn Bluetooth on?" dialog on Android.
    try {
      await mgr.enable();
    } catch {
      throw new OdbScanError("bluetooth-off", "Bluetooth is turned off.");
    }
    const after = await mgr.state();
    if (after !== "PoweredOn") {
      throw new OdbScanError("bluetooth-off", "Bluetooth is turned off.");
    }
  }

  // Runtime permissions. Bluetooth permissions are REQUIRED on Android 12+.
  // Below API 31 Google requires fine location for BLE scans, so it goes
  // into the required set for those old devices.
  const api = Number(Platform.Version);
  const required =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ];
  const result = await PermissionsAndroid.requestMultiple(required);
  const denied = required.filter(
    (p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED,
  );
  if (denied.length > 0) {
    throw new OdbScanError(
      "permission-denied",
      "Bluetooth permission is required to find OBD-II adapters.",
    );
  }

  // Best-effort location on Android 12+: the OS does not require it, but
  // some OEM firmwares withhold BLE device NAMES from scan results unless
  // the location grant exists (this is why other apps show names and we
  // saw MAC-only floods). Scanning proceeds either way — denying it may
  // leave some devices unnamed.
  if (api >= 31) {
    try {
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
    } catch {
      // Optional — never block the scan on this.
    }
  }
}

/** UART-like passthrough on the adapter. Cheap clones come in two
 *  flavors: a single characteristic that is both writable and notifiable
 *  (HM-10 style), or a SPLIT pair — one characteristic for TX, one for RX. */
type OdbChannel = {
  serviceUuid: string;
  write: Characteristic;
  writeWithResponse: boolean;
  notify: Characteristic;
};

async function pickChannel(services: Service[]): Promise<OdbChannel | null> {
  // Prefer services with a known OBD hint, then any service that looks
  // like a serial passthrough (one writable + one notifiable char).
  const isOdbService = (s: Service) =>
    OBD_SERVICE_HINTS.some((h) => s.uuid.toLowerCase().includes(h));

  const inspect = async (s: Service): Promise<OdbChannel | null> => {
    const characteristics = await s.characteristics();
    const write =
      characteristics.find((c) => c.isWritableWithResponse) ??
      characteristics.find((c) => c.isWritableWithoutResponse);
    const notify = characteristics.find(
      (c) => c.isNotifiable || c.isIndicatable,
    );
    if (write && notify) {
      return {
        serviceUuid: s.uuid,
        write,
        writeWithResponse: write.isWritableWithResponse,
        notify,
      };
    }
    return null;
  };

  for (const s of services.filter(isOdbService)) {
    const ch = await inspect(s);
    if (ch) return ch;
  }
  for (const s of services) {
    const ch = await inspect(s);
    if (ch) return ch;
  }
  return null;
}

export class BleTransport implements ObdTransport {
  readonly mode = "real" as const;

  private connected: Device | null = null;
  private channel: OdbChannel | null = null;
  private elm: Elm327Channel | null = null;
  private subscription: Subscription | null = null;

  async scanDevices(timeoutMs = SCAN_TIMEOUT_MS): Promise<ObdDevice[]> {
    await ensureBleReady();
    const mgr = getManager();

    // allowDuplicates: true is essential — with dedup on, Android often
    // delivers only the FIRST advertisement of each device, and the
    // device name usually arrives in a later packet. Without duplicates
    // the list fills with unnamed entries and the OBD filter cannot work.
    const seen = new Map<string, Device>();
    let finished = false;
    await mgr.startDeviceScan(
      null,
      { allowDuplicates: true, scanMode: ScanMode.LowLatency },
      (error, device) => {
        if (error) {
          // Scan errors (e.g. a race with the radio state) are surfaced at
          // the end when the scan is empty; a single bad advertisement is
          // not fatal.
          return;
        }
        if (!device?.id || finished) return;
        // Keep the richest advertisement per device: a packet with a
        // name replaces a nameless one (or the first seen); never let a
        // nameless duplicate overwrite a named entry.
        const prev = seen.get(device.id);
        const newName = device.name || device.localName;
        const prevName = prev?.name || prev?.localName;
        if (!prev || newName || !prevName) {
          seen.set(device.id, device);
        }
      },
    );

    await new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, timeoutMs),
    );
    await mgr.stopDeviceScan();

    // Plain list of everything found, strongest signal first — no
    // guessing which device is the adapter; the user picks.
    const byRssi = (a: Device, b: Device) => (b.rssi ?? -999) - (a.rssi ?? -999);
    const list = [...seen.values()].sort(byRssi).slice(0, 30);
    if (list.length === 0) {
      throw new OdbScanError(
        "none-found",
        "No Bluetooth devices found.",
      );
    }
    return list.map(toObdDevice);
  }

  async connect(device: ObdDevice): Promise<AdapterInfo> {
    await ensureBleReady();
    const mgr = getManager();

    // No requestMTU: some clones break on large-MTU negotiation, and AT
    // commands are tiny — the default MTU is plenty.
    const connected = await mgr.connectToDevice(device.id, {
      timeout: CONNECT_TIMEOUT_MS,
    });
    this.connected = connected;

    // Cheap clones need a beat after the GATT link is up before they
    // answer service discovery.
    await new Promise((r) => setTimeout(r, POST_CONNECT_SETTLE_MS));

    await connected.discoverAllServicesAndCharacteristics();
    const services = await connected.services();
    const channel = await pickChannel(services);
    if (!channel) {
      await this.disconnect();
      throw new OdbConnectError(
        "handshake",
        "Connected, but the adapter exposes no OBD serial channel.",
      );
    }
    this.channel = channel;

    const elm = new Elm327Channel((raw) => this.write(raw));
    this.elm = elm;
    this.subscription = connected.monitorCharacteristicForService(
      channel.serviceUuid,
      channel.notify.uuid,
      (error, ch) => {
        if (error || !ch?.value) return;
        elm.feed(base64ToUtf8(ch.value));
      },
    );

    return elm327Handshake(elm);
  }

  async readVehicleInfo(): Promise<VehicleInfo> {
    const elm = this.elm;
    if (!elm || !this.connected) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    return readVehicleInfoOver(elm);
  }

  disconnect(): void {
    try {
      this.subscription?.remove();
    } catch {
      // Already removed.
    }
    this.subscription = null;
    this.elm?.dispose();
    this.elm = null;
    this.channel = null;
    const device = this.connected;
    this.connected = null;
    if (device) {
      getManager().cancelDeviceConnection(device.id).catch(() => {});
    }
  }

  private async write(raw: string): Promise<void> {
    const device = this.connected;
    const channel = this.channel;
    if (!device || !channel) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    const payload = encodeCommand(raw);
    if (channel.writeWithResponse) {
      await device.writeCharacteristicWithResponseForService(
        channel.serviceUuid,
        channel.write.uuid,
        payload,
      );
    } else {
      await device.writeCharacteristicWithoutResponseForService(
        channel.serviceUuid,
        channel.write.uuid,
        payload,
      );
    }
  }
}

/** Singleton — BLE state (connection, subscription) must not be duplicated. */
let bleTransport: BleTransport | null = null;

export function getBleTransport(): BleTransport {
  if (!bleTransport) bleTransport = new BleTransport();
  return bleTransport;
}
