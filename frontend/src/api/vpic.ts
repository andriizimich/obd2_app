// NHTSA vPIC VIN decode client.
// Pure module with zero imports so it runs under tsx, RN, and web.
// API docs: https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json

const API_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";
const CACHE_TTL_MS = 5 * 60_000;

export type VinDecodeOk = {
  status: "ok"; // ErrorCode list contains "0" — clean decode
  make: string;
  model: string;
  year: string;
  manufacturer: string;
  plantCountry: string;
};

export type VinDecodePartial = {
  status: "partial"; // recognized, but not found / incomplete data
  errorCode: string; // raw, e.g. "5,14"
  errorText: string;
  make?: string;
  model?: string;
  year?: string;
  plantCountry?: string;
};

export type VinDecodeFailure = {
  status: "error";
  reason: "timeout" | "network" | "http" | "parse";
  message: string;
};

export type VinDecodeResult = VinDecodeOk | VinDecodePartial | VinDecodeFailure;

type CacheEntry = { result: VinDecodeResult; at: number };
const cache = new Map<string, CacheEntry>();

export function clearVinCache(): void {
  cache.clear();
}

function normalize(vin: string): string {
  return vin.trim().toUpperCase();
}

function field(value: unknown): string {
  return String(value ?? "").trim();
}

export async function decodeVinRemote(
  vin: string,
  opts?: { timeoutMs?: number },
): Promise<VinDecodeResult> {
  const key = normalize(vin);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const timeoutMs = opts?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${API_URL}/${encodeURIComponent(key)}?format=json`;
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        return { status: "error", reason: "timeout", message: `NHTSA request timed out after ${timeoutMs} ms` };
      }
      return { status: "error", reason: "network", message: "Network request to NHTSA failed" };
    }

    if (!res.ok) {
      return { status: "error", reason: "http", message: `NHTSA responded with HTTP ${res.status}` };
    }

    let data: { Results?: Array<Record<string, unknown>> };
    try {
      data = await res.json();
    } catch {
      return { status: "error", reason: "parse", message: "NHTSA returned an invalid response" };
    }
    const row = data.Results?.[0];
    if (!row) {
      return { status: "error", reason: "parse", message: "NHTSA response had no results" };
    }

    const codes = field(row.ErrorCode).split(",").map((s) => s.trim());
    const make = field(row.Make);
    const model = field(row.Model);
    const year = field(row.ModelYear);
    const manufacturer = field(row.Manufacturer);
    const plantCountry = field(row.PlantCountry);

    const result: VinDecodeResult =
      codes.includes("0")
        ? { status: "ok", make, model, year, manufacturer, plantCountry }
        : {
            status: "partial",
            errorCode: field(row.ErrorCode),
            errorText: field(row.ErrorText) || "VIN not found in NHTSA database",
            ...(make ? { make } : {}),
            ...(model ? { model } : {}),
            ...(year ? { year } : {}),
            ...(plantCountry ? { plantCountry } : {}),
          };

    // Cache successes and partials only — failures are retried next time.
    if (result.status === "ok" || result.status === "partial") {
      cache.set(key, { result, at: Date.now() });
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
