// Vehicle identification pipeline: ECU data (mode 09) → VIN decode (vPIC)
// → local WMI/pattern fallback → consistency checks → confidence score.
//
// The result is a Vehicle plus IdentificationEvidence (protocol, CALID,
// warnings) that the dashboard shows next to the vehicle info. Pure logic
// over the transport interface — unit-testable with recorded data.

import { decodeVinRemote } from "@/src/api/vpic";
import type { ObdTransport } from "@/src/obd/transport";
import type {
  IdentificationEvidence,
  Vehicle,
  VehicleConfidence,
} from "@/src/obd/types";
import { modelYearsForChar, validateVin, wmiManufacturer } from "@/src/utils/vin";

export type Identification = {
  vehicle: Vehicle;
  evidence: IdentificationEvidence;
};

/**
 * Plausible model year from the VIN position-10 character: the latest
 * 30-year-cycle value not in the future.
 */
export function guessYearFromVin(vin: string): number | null {
  const candidates = modelYearsForChar(vin[9] ?? "").filter((y) => y <= new Date().getFullYear() + 1);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/**
 * Rough era check: CAN-based OBD arrived on petrol cars around 2001 in
 * Europe (2008 in the US), while J1850/ISO 9141/KWP are pre-CAN. Exact
 * boundaries differ per market, so mismatches only produce a warning,
 * never a hard failure.
 */
export function protocolYearConsistent(protocol: string, year: number): boolean {
  const isCan = protocol.includes("CAN");
  return isCan ? year >= 2001 : year <= 2010;
}

/** Every unresolved inconsistency knocks the confidence down one step. */
export function downgradeConfidence(
  base: VehicleConfidence,
  warningCount: number,
): VehicleConfidence {
  if (warningCount === 0 || base === "unknown") return base;
  if (base === "high") return "medium";
  return "low";
}

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

function intOrUndefined(value: string): number | undefined {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The "nothing readable" vehicle, shown when the ECU gives no VIN at all. */
function unknownVehicle(vin: string | null): Vehicle {
  return {
    vin: vin ?? "",
    make: "Unknown",
    model: "",
    year: 0,
    mileage: null,
    confidence: "unknown",
  };
}

export async function identifyVehicle(
  transport: ObdTransport,
): Promise<Identification> {
  const info = await transport.readVehicleInfo();

  // Demo transport delivers a ready vehicle — nothing to decode or check.
  if (info.vehicle) {
    return {
      vehicle: info.vehicle,
      evidence: {
        source: "demo",
        vinFromEcu: info.vin,
        calid: info.calid,
        ecuName: info.ecuName,
        protocol: info.protocol,
        vpicStatus: "not-run",
        warnings: [],
      },
    };
  }

  const warnings: string[] = [];
  const rawVin = info.vin;
  const vinValid = rawVin ? validateVin(rawVin).valid : false;
  const vin = vinValid ? rawVin : null;

  if (!vin) {
    if (rawVin) warnings.push("ECU returned an invalid VIN — check digit or format failed.");
    else warnings.push("ECU did not provide a VIN (mode 09). Vehicle identity is unconfirmed.");
    return {
      vehicle: unknownVehicle(rawVin),
      evidence: {
        source: "ecu",
        vinFromEcu: rawVin,
        calid: info.calid,
        ecuName: info.ecuName,
        protocol: info.protocol,
        vpicStatus: "not-run",
        warnings,
      },
    };
  }

  const wmiMake = wmiManufacturer(vin);
  let make = "";
  let model = "";
  let year = 0;
  let enrichment: Partial<Vehicle> = {};
  let vpicStatus: IdentificationEvidence["vpicStatus"] = "not-run";
  let base: VehicleConfidence = "unknown";

  const decode = await decodeVinRemote(vin);
  if (decode.status === "ok") {
    vpicStatus = "ok";
    base = decode.confidence;
    make = clean(decode.make) ?? "";
    model = clean(decode.model) ?? "";
    year = intOrUndefined(decode.year) ?? 0;
    enrichment = {
      engineModel: clean(decode.engineModel),
      engineCylinders: intOrUndefined(decode.engineCylinders),
      fuelType: clean(decode.fuelType),
      transmission: clean(decode.transmission),
      driveType: clean(decode.driveType),
    };
    // Second opinion: the local WMI table must agree with the decoder.
    if (wmiMake && make && wmiMake.toLowerCase() !== make.toLowerCase()) {
      warnings.push(`VIN decoder says "${make}" but the WMI (${vin.slice(0, 3)}) is registered to ${wmiMake}.`);
    }
  } else if (decode.status === "partial") {
    vpicStatus = "partial";
    base = "low";
    make = clean(decode.make) ?? wmiMake ?? "";
    model = clean(decode.model) ?? "";
    year = intOrUndefined(decode.year ?? "") ?? guessYearFromVin(vin) ?? 0;
    if (!decode.make && !wmiMake) {
      warnings.push("VIN not found in NHTSA and its WMI is not in the local table.");
    }
  } else {
    vpicStatus = "error";
    base = "low";
    make = wmiMake ?? "";
    year = guessYearFromVin(vin) ?? 0;
    warnings.push(`NHTSA lookup failed (${decode.reason}) — used local WMI/year decode only.`);
  }

  if (!make) {
    make = "Unknown";
    base = "unknown";
    warnings.push("Vehicle make could not be determined from the VIN.");
  }

  // Era check: protocol vs. model year.
  if (info.protocol && year > 0 && !protocolYearConsistent(info.protocol, year)) {
    warnings.push(`${info.protocol} is unusual for a ${year} vehicle.`);
  }

  // CALID is the second identification factor; its absence weakens the score.
  if (info.calid.length === 0) {
    warnings.push("CALID not available — no second identification factor.");
  }

  const vehicle: Vehicle = {
    vin,
    make,
    model,
    year,
    mileage: null,
    ...enrichment,
    confidence: downgradeConfidence(base, warnings.length),
  };

  return {
    vehicle,
    evidence: {
      source: "ecu",
      vinFromEcu: info.vin,
      calid: info.calid,
      ecuName: info.ecuName,
      protocol: info.protocol,
      vpicStatus,
      warnings,
    },
  };
}
