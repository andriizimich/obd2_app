// Transport factory + mode persistence. Screens pick a transport here by
// mode ("demo" simulation or "ble" real adapter) and never import the
// implementations directly.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { DemoTransport } from "@/src/obd/demo";
import { RealTransport } from "@/src/obd/real";
import type { OdbMode, ObdTransport } from "@/src/obd/transport";

const MODE_KEY = "obd.mode.v1";

export async function loadMode(): Promise<OdbMode> {
  try {
    const saved = await AsyncStorage.getItem(MODE_KEY);
    // "ble" was the pre-classic value — both mean real hardware.
    return saved === "ble" || saved === "real" ? "real" : "demo";
  } catch {
    return "demo";
  }
}

export async function saveMode(mode: OdbMode): Promise<void> {
  try {
    await AsyncStorage.setItem(MODE_KEY, mode);
  } catch {
    // Persisting the mode is best-effort; the in-memory value still works.
  }
}

let demoTransport: DemoTransport | null = null;

export function getDemoTransport(): DemoTransport {
  if (!demoTransport) demoTransport = new DemoTransport();
  return demoTransport;
}

let realTransport: RealTransport | null = null;

export function getTransport(mode: OdbMode): ObdTransport {
  if (mode === "demo") return getDemoTransport();
  if (!realTransport) realTransport = new RealTransport();
  return realTransport;
}
