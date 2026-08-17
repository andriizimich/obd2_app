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
  type Characteristic,
  type Device,
  type Service,
  type Subscription,
} from "react-native-ble-plx";
import { PermissionsAndroid, Platform } from "react-native";

import { Elm327Channel } from "@/src/obd/at";
import { readCalid, readEcuName, readProtocol, readVin } from "@/src/obd/mode09";
import type { AdapterInfo, ObdTransport, VehicleInfo } from "@/src/obd/transport";
import { OdbConnectError, OdbScanError } from "@/src/obd/transport";
import type { ObdDevice } from "@/src/obd/types";

const SCAN_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 10000;

// Service UUID hints advertised by common BLE ELM327 adapters.
const OBD_SERVICE_HINTS = ["fff0", "ffe0", "ffe5", "ff00", "ff10"];
// Advertised-name hints for common adapters.
const OBD_NAME_HINTS = [
  /obd/i,
  /elm/i,
  /icar/i,
  /vlinker/i,
  /viecar/i,
  /vgate/i,
  /carpro/i,
  /kw902/i,
  /scan/i,
];

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

function looksLikeObd(device: Device): boolean {
  const name = (device.name || device.localName || "").toLowerCase();
  if (OBD_NAME_HINTS.some((re) => re.test(name))) return true;
  const uuids = (device.serviceUUIDs || []).map((u) => u.toLowerCase());
  return uuids.some((u) => OBD_SERVICE_HINTS.some((h) => u.includes(h)));
}

function toObdDevice(device: Device): ObdDevice {
  return {
    id: device.id,
    name: device.name || device.localName || "Unknown adapter",
    address: device.id,
    rssi: device.rssi,
  };
}

/**
 * Ask for Android runtime permissions (API 31+: BLUETOOTH_SCAN/CONNECT;
 * older: location, which BLE scanning piggybacks on) and make sure the
 * Bluetooth radio is on.
 */
async function ensureBleReady(): Promise<void> {
  if (Platform.OS === "ios") {
    const state = await getManager().state();
    if (state !== "PoweredOn") throw new OdbScanError("bluetooth-off", "Bluetooth is turned off.");
    return;
  }
  if (Platform.OS !== "android") {
    throw new OdbScanError("unsupported", "BLE is only supported on iOS and Android.");
  }

  const api = Number(Platform.Version);
  const perms =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ];
  const result = await PermissionsAndroid.requestMultiple(perms);
  const denied = perms.filter(
    (p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED,
  );
  if (denied.length > 0) {
    throw new OdbScanError(
      "permission-denied",
      "Bluetooth permission is required to find OBD-II adapters.",
    );
  }

  const mgr = getManager();
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
}

/** UART-like passthrough characteristic on the adapter. */
type OdbChannel = {
  serviceUuid: string;
  characteristic: Characteristic;
  isWritableWithResponse: boolean;
};

async function pickChannel(services: Service[]): Promise<OdbChannel | null> {
  // Prefer services with a known OBD hint, then any service that looks
  // like a serial passthrough (notifiable + writable characteristic).
  const isOdbService = (s: Service) =>
    OBD_SERVICE_HINTS.some((h) => s.uuid.toLowerCase().includes(h));

  const inspect = async (s: Service): Promise<OdbChannel | null> => {
    const characteristics = await s.characteristics();
    for (const c of characteristics) {
      const writable = c.isWritableWithResponse || c.isWritableWithoutResponse;
      if (writable && (c.isNotifiable || c.isIndicatable)) {
        return {
          serviceUuid: s.uuid,
          characteristic: c,
          isWritableWithResponse: c.isWritableWithResponse,
        };
      }
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
  readonly mode = "ble" as const;

  private connected: Device | null = null;
  private channel: OdbChannel | null = null;
  private elm: Elm327Channel | null = null;
  private subscription: Subscription | null = null;

  async scanDevices(timeoutMs = SCAN_TIMEOUT_MS): Promise<ObdDevice[]> {
    await ensureBleReady();
    const mgr = getManager();

    const seen = new Map<string, Device>();
    let finished = false;
    await mgr.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        // Scan errors (e.g. a race with the radio state) are surfaced at
        // the end when the scan is empty; a single bad advertisement is
        // not fatal.
        return;
      }
      if (device?.id && !finished) seen.set(device.id, device);
    });

    await new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, timeoutMs),
    );
    await mgr.stopDeviceScan();

    const devices = [...seen.values()];
    const matches = devices.filter(looksLikeObd);
    if (matches.length > 0) return matches.map(toObdDevice);
    // The adapter may have a custom name — fall back to every device
    // that advertised at least a name, capped to keep the list sane.
    const named = devices.filter((d) => d.name || d.localName);
    if (named.length > 0) return named.slice(0, 10).map(toObdDevice);
    if (devices.length > 0) return devices.slice(0, 10).map(toObdDevice);
    throw new OdbScanError(
      "none-found",
      "No Bluetooth OBD-II adapter detected.",
    );
  }

  async connect(device: ObdDevice): Promise<AdapterInfo> {
    await ensureBleReady();
    const mgr = getManager();

    const connected = await mgr.connectToDevice(device.id, {
      requestMTU: 247,
      timeout: CONNECT_TIMEOUT_MS,
    });
    this.connected = connected;

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
      channel.characteristic.uuid,
      (error, ch) => {
        if (error || !ch?.value) return;
        elm.feed(base64ToUtf8(ch.value));
      },
    );

    const adapterId = await this.handshake(elm);
    return { adapterId };
  }

  async readVehicleInfo(): Promise<VehicleInfo> {
    const elm = this.elm;
    if (!elm || !this.connected) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    // Ask the adapter to join multi-frame replies into one line; the
    // parser handles multi-line responses anyway, so a "?" is harmless.
    try {
      await elm.command("ATAL", 2000);
    } catch {
      // Clone doesn't support ATAL — multi-line parsing takes over.
    }

    // Every read is best-effort: one unsupported PID must not lose the rest.
    let protocol: string | null = null;
    try {
      protocol = await readProtocol(elm);
    } catch {
      // ignore
    }
    let vin: string | null = null;
    try {
      vin = await readVin(elm);
    } catch {
      // ignore
    }
    let calid: string[] = [];
    try {
      calid = await readCalid(elm);
    } catch {
      // ignore
    }
    let ecuName: string | null = null;
    try {
      ecuName = await readEcuName(elm);
    } catch {
      // ignore
    }
    return { vin, calid, ecuName, protocol };
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

  /** ATZ reset + ATE0 (echo off) + ATI identification. */
  private async handshake(elm: Elm327Channel): Promise<string | null> {
    // A freshly-powered clone often misses the first command — retry ATZ
    // once before declaring the adapter unresponsive.
    let reset: string[] = [];
    try {
      reset = await elm.command("ATZ", 6000);
    } catch {
      reset = await elm.command("ATZ", 6000);
    }
    if (reset.length === 0) {
      await this.disconnect();
      throw new OdbConnectError(
        "handshake",
        "Adapter did not answer ATZ — is it an ELM327?",
      );
    }

    // Echo off; from here responses are clean single lines.
    try {
      await elm.command("ATE0", 2000);
    } catch {
      // Not fatal — clones differ.
    }

    let idLines: string[] = [];
    try {
      idLines = await elm.command("ATI", 3000);
    } catch {
      // Not fatal either — identification is best-effort.
    }
    return idLines.length > 0 ? idLines.join(" / ") : null;
  }

  private async write(raw: string): Promise<void> {
    const device = this.connected;
    const channel = this.channel;
    if (!device || !channel) {
      throw new OdbConnectError("disconnected", "Adapter is not connected.");
    }
    const payload = encodeCommand(raw);
    if (channel.isWritableWithResponse) {
      await device.writeCharacteristicWithResponseForService(
        channel.serviceUuid,
        channel.characteristic.uuid,
        payload,
      );
    } else {
      await device.writeCharacteristicWithoutResponseForService(
        channel.serviceUuid,
        channel.characteristic.uuid,
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
