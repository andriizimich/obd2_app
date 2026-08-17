import type { Fault, Vehicle } from "@/src/demo/obd";

const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

export type Scan = {
  id: string;
  vehicle: Vehicle;
  faults: Fault[];
  fault_count: number;
  status: "ok" | "faults";
  device_name?: string | null;
  created_at: string;
};
export async function createScan(input: {
  vehicle: Vehicle;
  faults: Fault[];
  device_name?: string | null;
}): Promise<Scan> {
  const res = await fetch(`${BASE}/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createScan failed: ${res.status}`);
  return res.json();
}

export async function listScans(): Promise<Scan[]> {
  const res = await fetch(`${BASE}/scans`);
  if (!res.ok) throw new Error(`listScans failed: ${res.status}`);
  return res.json();
}

export async function getScan(id: string): Promise<Scan> {
  const res = await fetch(`${BASE}/scans/${id}`);
  if (!res.ok) throw new Error(`getScan failed: ${res.status}`);
  return res.json();
}

export async function deleteScan(id: string): Promise<void> {
  const res = await fetch(`${BASE}/scans/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteScan failed: ${res.status}`);
}
