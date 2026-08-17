// ISO 3779 VIN validation & decoding.
// Pure module with zero imports so it runs identically under tsx, RN, and web.

export const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

// Letter transliteration for the check-digit sum (I, O, Q are never legal VIN chars).
export const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};

// Position 9 (the check digit itself) has weight 0.
export const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export type VinCheckResult = {
  valid: boolean;
  reasons: string[];
  checkDigitExpected: string | null;
};

// Computes the expected check digit for a 17-char VIN. Position 9 is ignored
// (weight 0), so a placeholder like "0" works there. Null when length or
// characters make the check impossible.
export function computeCheckDigit(vin17: string): string | null {
  const vin = vin17.trim().toUpperCase();
  if (vin.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const t = TRANSLIT[vin[i]];
    if (t === undefined) return null;
    sum += t * WEIGHTS[i];
  }
  const rem = sum % 11;
  return rem === 10 ? "X" : String(rem);
}

export function validateVin(vin: string): VinCheckResult {
  const reasons: string[] = [];
  const v = vin.trim().toUpperCase();

  if (v.length !== 17) {
    reasons.push("Length must be 17 characters");
  }

  let badChar = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (!VIN_CHARS.includes(c)) {
      reasons.push(`Invalid character '${c}' at position ${i + 1}`);
      badChar = true;
    }
  }

  let expected: string | null = null;
  if (!badChar && v.length === 17) {
    expected = computeCheckDigit(v);
    const actual = v[8];
    if (actual !== expected) {
      reasons.push(`Check digit mismatch: expected ${expected}, found ${actual}`);
    }
  }

  return { valid: reasons.length === 0, reasons, checkDigitExpected: expected };
}

export type VinRegion =
  | "North America"
  | "Europe"
  | "Africa"
  | "Oceania"
  | "Asia"
  | "South America"
  | "Unknown";

// First WMI char determines the world region.
export function vinRegion(firstChar: string): VinRegion {
  const c = firstChar.toUpperCase();
  if (c >= "1" && c <= "5") return "North America";
  if (c >= "S" && c <= "Z") return "Europe";
  if (c >= "A" && c <= "H") return "Africa";
  if (c >= "J" && c <= "R") return "Asia";
  if (c === "6" || c === "7") return "Oceania";
  if (c === "8" || c === "9") return "South America";
  return "Unknown";
}

// Compact WMI -> manufacturer map covering the demo fleet.
export const WMI_MANUFACTURERS: Record<string, string> = {
  WVW: "Volkswagen",
  WBA: "BMW",
  "4T1": "Toyota",
  WAU: "Audi",
  "1FA": "Ford",
  WDD: "Mercedes-Benz",
};

export function wmiManufacturer(vin: string): string | null {
  return WMI_MANUFACTURERS[vin.trim().toUpperCase().slice(0, 3)] ?? null;
}

// Model-year codes cycle every 30 years starting at 1980
// (letters A-Y without I/O/Q/U/Z, then digits 1-9).
const YEAR_CODE_ORDER = [
  "A", "B", "C", "D", "E", "F", "G", "H", "J", "K",
  "L", "M", "N", "P", "R", "S", "T", "V", "W", "X",
  "Y", "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

// All possible years a position-10 character can mean (30-year cycle).
export function modelYearsForChar(char: string): number[] {
  const i = YEAR_CODE_ORDER.indexOf(char.toUpperCase());
  if (i < 0) return [];
  return [1980 + i, 2010 + i, 2040 + i];
}

// The position-10 character for a given model year.
export function yearCharFor(year: number): string | null {
  const i = (((year - 1980) % 30) + 30) % 30;
  return YEAR_CODE_ORDER[i] ?? null;
}

// Builds a structurally valid demo VIN:
// [1-3] WMI, [4-8] VDS, [9] computed check digit, [10] year char,
// [11] plant, [12-17] serial.
export function buildDemoVin(wmi: string, year: number, serial?: string): string {
  const w = wmi.trim().toUpperCase().slice(0, 3);
  const vds = "1JZXW"; // demo vehicle descriptor section (constant)
  const yr = yearCharFor(year) ?? "1";
  const plant = "P";
  const ser = (
    serial ?? String(Math.floor(Math.random() * 1_000_000))
  ).padStart(6, "0").slice(-6);

  const body = w + vds + "0" + yr + plant + ser; // 17 chars, pos 9 = placeholder
  const cd = computeCheckDigit(body);
  return body.slice(0, 8) + cd + body.slice(9);
}
