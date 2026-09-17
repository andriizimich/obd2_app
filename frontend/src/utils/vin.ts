// ISO 3779 VIN validation & decoding.
// Pure module with zero imports so it runs identically under tsx, RN, and web.

export const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

/** ISO 3779 length. A VIN is exactly this long or it is not a VIN. */
export const VIN_LENGTH = 17;

/** True for the 33 characters a VIN may contain — I, O and Q never occur. */
export function isVinChar(char: string): boolean {
  return char.length === 1 && VIN_CHARS.includes(char.toUpperCase());
}

/** Uppercases and drops everything a VIN cannot contain. */
export function keepVinChars(raw: string): string {
  let out = "";
  for (const c of raw.toUpperCase()) if (VIN_CHARS.includes(c)) out += c;
  return out;
}

/**
 * 17 characters, all of them legal — **without** the check-digit test.
 *
 * The check digit is a North-American requirement (49 CFR 565); most of the
 * world's manufacturers never compute one, so roughly ten out of eleven
 * European VINs fail it by arithmetic accident. Discarding those VINs threw
 * away the only identification a car had given — which is why this is the
 * predicate the pipeline asks about, and {@link validateVin} is not.
 */
export function isFullVin(vin: string | null | undefined): boolean {
  if (!vin) return false;
  const v = vin.trim().toUpperCase();
  return v.length === VIN_LENGTH && keepVinChars(v).length === VIN_LENGTH;
}

/** A leading fragment of a VIN: long enough for a world manufacturer code
 *  (3 characters) to mean something, too short to be a whole VIN. */
export function isPartialVin(vin: string | null | undefined): boolean {
  if (!vin) return false;
  const v = keepVinChars(vin.trim());
  return v.length >= 3 && v.length < VIN_LENGTH;
}

/** Whether position 9 carries the check digit a North-American VIN must
 *  have. Null when the VIN is not 17 legal characters. */
export function vinCheckDigitOk(vin: string): boolean | null {
  const v = vin.trim().toUpperCase();
  if (!isFullVin(v)) return null;
  const expected = computeCheckDigit(v);
  return expected !== null && expected === v[8];
}

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

/**
 * World manufacturer identifier → make. The offline half of identification:
 * the NHTSA lookup needs a network and a complete VIN, and neither is
 * guaranteed — a car that answers mode 09 with six characters has still told
 * us who built it, because the first three of them are the WMI.
 *
 * Names are spelled the way vPIC spells them (plain ASCII, no diacritics),
 * because {@link wmiManufacturer} is used as a second opinion against the
 * decoder and "Škoda" against "SKODA" would read as a disagreement.
 *
 * One make commonly holds several codes: the WMI identifies the *plant* or
 * the division as much as the brand (KMH and KM8 are both Hyundai, one for
 * cars and one for SUVs). A VIN that is not in here keeps whatever the
 * decoder said.
 */
export const WMI_MANUFACTURERS: Record<string, string> = {
  // --- Germany ---
  WVW: "Volkswagen", WV1: "Volkswagen", WV2: "Volkswagen",
  WAU: "Audi", WUA: "Audi", TRU: "Audi",
  WBA: "BMW", WBS: "BMW", WBY: "BMW",
  WMW: "Mini",
  WDB: "Mercedes-Benz", WDC: "Mercedes-Benz", WDD: "Mercedes-Benz", WMX: "Mercedes-Benz",
  W0L: "Opel", W0V: "Vauxhall",
  WME: "Smart",
  // --- France, Italy, Spain ---
  VF1: "Renault", VF3: "Peugeot", VF7: "Citroen",
  UU1: "Dacia", UU2: "Dacia", UU3: "Dacia",
  VSS: "Seat",
  ZFA: "Fiat", ZAR: "Alfa Romeo", ZAM: "Maserati", ZLA: "Lancia",
  ZFF: "Ferrari", ZHW: "Lamborghini",
  // --- Czechia, Sweden, UK, Russia ---
  TMB: "Skoda",
  YV1: "Volvo", YV4: "Volvo",
  YS3: "Saab",
  SAJ: "Jaguar", SAL: "Land Rover", SAR: "Rover",
  SCA: "Rolls-Royce", SCB: "Bentley", SCC: "Lotus", SCF: "Aston Martin",
  XTA: "Lada",
  // --- Korea ---
  KMH: "Hyundai", KM8: "Hyundai", TMA: "Hyundai",
  KNA: "Kia", KNB: "Kia", KND: "Kia", U5Y: "Kia",
  KLA: "Daewoo", KL1: "Chevrolet",
  // --- Japan ---
  JTD: "Toyota", JTM: "Toyota", JTH: "Lexus",
  JN1: "Nissan", JN8: "Nissan", JNK: "Infiniti", VSK: "Nissan",
  JHM: "Honda", SHH: "Honda",
  JMZ: "Mazda", JM1: "Mazda",
  JMB: "Mitsubishi",
  JSA: "Suzuki", TSM: "Suzuki",
  JF1: "Subaru", JF2: "Subaru",
  // --- North America ---
  "1FA": "Ford", WF0: "Ford",
  "1G1": "Chevrolet", "1G6": "Cadillac", "1GT": "GMC", "1G4": "Buick",
  "1C3": "Chrysler", "1B3": "Dodge", "1J4": "Jeep", "1C4": "Jeep",
  "4T1": "Toyota", "4T3": "Toyota", "5TD": "Toyota", "4JG": "Mercedes-Benz",
  "5YJ": "Tesla",
  // --- China ---
  LVV: "Chery",
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

