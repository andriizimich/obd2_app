// Diagnostic trouble codes: the two raw bytes → a code string, and the code
// string → everything that can honestly be said about it without a lookup
// table.
//
// A DTC pair packs five characters into two bytes:
//
//   byte 1  bits 7-6  system:  P=00  C=01  B=10  U=11
//           bits 5-4  second character
//           bits 3-0  third character
//   byte 2  bits 7-4  fourth character
//           bits 3-0  fifth character
//
// `00 00` is padding at the end of a code list, not a code.
//
// The point of the structural decode is coverage: a bundled table holds a
// couple of hundred codes, a car can report any of several thousand. The
// second character alone says whether the code is SAE-defined or the
// manufacturer's own, and for powertrain codes the third character names
// the subsystem — which is enough for a driver to act on, and never claims
// more than the bytes actually carry.

import { DTC_DICTIONARY } from "@/src/obd/dtc-dictionary";
import { moduleLabel } from "@/src/obd/frames";
import type {
  DtcStatus,
  Fault,
  FaultGroup,
  FaultSeverity,
} from "@/src/obd/types";

const SYSTEM_CHARS = ["P", "C", "B", "U"] as const;
const SYSTEM_NAMES = ["Powertrain", "Chassis", "Body", "Network"] as const;

export type DtcSystem = (typeof SYSTEM_CHARS)[number];

/** Third character of a `P` code — the subsystem table from SAE J2012. */
const P_SUBSYSTEMS: Record<string, string> = {
  "0": "Fuel and air metering",
  "1": "Fuel and air metering",
  "2": "Fuel and air metering (injector circuit)",
  "3": "Ignition system or misfire",
  "4": "Auxiliary emission controls",
  "5": "Vehicle speed and idle control",
  "6": "Computer output circuit",
  "7": "Transmission",
  "8": "Transmission",
  "9": "Transmission",
  A: "Hybrid propulsion",
  B: "Hybrid propulsion",
  C: "Hybrid propulsion",
};

export type DtcStructure = {
  system: DtcSystem;
  systemName: string;
  /** True when the second character is 0 or 2 — an SAE J2012 code. False
   *  means the manufacturer's own numbering, which no generic table decodes. */
  generic: boolean;
  /** Coarse subsystem, or null where the standard has no table we trust. */
  subsystem: string | null;
  /** Always present, always honest about what is not known. */
  summary: string;
};

/** Two bytes → `"P0300"`, or null for the `00 00` list padding. */
export function decodeDtcPair(hi: number, lo: number): string | null {
  if (hi === 0 && lo === 0) return null;
  const system = SYSTEM_CHARS[(hi >> 6) & 0x03];
  const second = (hi >> 4) & 0x03;
  const third = (hi & 0x0f).toString(16).toUpperCase();
  const fourth = ((lo >> 4) & 0x0f).toString(16).toUpperCase();
  const fifth = (lo & 0x0f).toString(16).toUpperCase();
  return `${system}${second}${third}${fourth}${fifth}`;
}

/** `"P0300"` → the two bytes. Null when the string is not a DTC. */
export function encodeDtc(code: string): [number, number] | null {
  const m = /^([PCBU])([0-3])([0-9A-F])([0-9A-F])([0-9A-F])$/i.exec(
    code.trim(),
  );
  if (!m) return null;
  const system = SYSTEM_CHARS.indexOf(m[1].toUpperCase() as DtcSystem);
  const hi = (system << 6) | (parseInt(m[2], 10) << 4) | parseInt(m[3], 16);
  const lo = (parseInt(m[4], 16) << 4) | parseInt(m[5], 16);
  return [hi, lo];
}

function subsystemFor(system: DtcSystem, third: string): string | null {
  if (system === "P") return P_SUBSYSTEMS[third] ?? null;
  if (system === "U" && "0123".includes(third)) return "Network communication";
  return null;
}

/** What the code's own bytes say. Assumes a code produced by
 *  {@link decodeDtcPair}, i.e. one that starts with P, C, B or U. */
export function describeDtcStructurally(code: string): DtcStructure {
  const c = code.trim().toUpperCase();
  const index = Math.max(0, SYSTEM_CHARS.indexOf(c[0] as DtcSystem));
  const system = SYSTEM_CHARS[index];
  const systemName = SYSTEM_NAMES[index];
  const generic = c[1] === "0" || c[1] === "2";
  const subsystem = subsystemFor(system, c[2] ?? "");
  const origin = generic
    ? "SAE-defined"
    : "manufacturer-specific";
  const summary = subsystem
    ? `${origin} ${systemName.toLowerCase()} code — ${subsystem.toLowerCase()}. It is not in the bundled dictionary, so check the service documentation for this vehicle.`
    : `${origin} ${systemName.toLowerCase()} code. It is not in the bundled dictionary, so check the service documentation for this vehicle.`;
  return { system, systemName, generic, subsystem, summary };
}

/**
 * Which UI group a code belongs to. Derived from the code's own structure,
 * so it is right even for codes the dictionary has never heard of — which
 * matters when the table holds ~150 entries and a car speaks four hundred.
 */
export function groupForDtc(code: string): FaultGroup {
  const c = code.trim().toUpperCase();
  const third = c[2] ?? "";
  switch (c[0]) {
    case "P":
      if (third === "7" || third === "8" || third === "9") return "transmission";
      if (third === "4") return "emissions";
      return "engine";
    case "C":
      return "brakes";
    case "B":
      return "body";
    case "U":
      return "electrical";
    default:
      return "engine";
  }
}

/**
 * Severity from structure alone. The UI draws an estimated severity with a
 * hollow dot so a guess is never presented as a fact — the dictionary
 * (stage 2) overrides this wherever it has a real answer.
 */
export function estimateSeverity(code: string): FaultSeverity {
  const c = code.trim().toUpperCase();
  if (c.startsWith("U")) return "high"; // lost communication
  if (c.startsWith("C0") || c.startsWith("C1")) return "high"; // ABS / brakes
  // Cylinder misfire (P0300-P0312) dumps unburnt fuel into the catalyst.
  if (/^P03(0\d|1[0-2])$/.test(c)) return "high";
  if (c.startsWith("B")) return "low";
  return "medium";
}

/**
 * A code → a row the UI can draw.
 *
 * The bundled dictionary is consulted first, and it wins wherever it has an
 * entry: a written title beats a subsystem name. Everything it does not
 * cover falls back to the structural decode, which is why `known` is part of
 * the result — a driver comparing this against a service manual deserves to
 * know which of the two they are reading.
 *
 * `group` deliberately does NOT come from the dictionary: the structural
 * rule is right for every code the standard defines, including the several
 * thousand the table will never hold.
 */
export function toFault(
  code: string,
  status: DtcStatus,
  moduleId: number | null,
): Fault {
  const key = code.trim().toUpperCase();
  const entry = DTC_DICTIONARY[key];
  const structure = describeDtcStructurally(key);
  return {
    code: key,
    group: groupForDtc(key),
    // A bare system name ("Chassis") reads as a truncated label on a list
    // row and on the one line the report gives it; naming it as a code keeps
    // the line saying something.
    title: entry?.title ?? structure.subsystem ?? `${structure.systemName} code`,
    description: entry?.description ?? structure.summary,
    severity: entry?.severity ?? estimateSeverity(key),
    status,
    moduleId,
    module: moduleLabel(moduleId),
    ...(entry?.causes ? { causes: [...entry.causes] } : {}),
    known: !!entry,
  };
}
