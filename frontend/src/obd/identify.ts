// Vehicle identification pipeline: ECU data (mode 09) → VIN decode (vPIC)
// → local WMI/pattern fallback → consistency checks → confidence score.
//
// The result is a Vehicle plus IdentificationEvidence (protocol, CALID,
// warnings) that the dashboard shows next to the vehicle info. Pure logic
// over the transport interface — unit-testable with recorded data.

import { checkDigitOnlyFailure, decodeVinRemote } from "@/src/api/vpic";
import type { VinDecodeResult } from "@/src/api/vpic";
import type { ObdTransport, VehicleInfo } from "@/src/obd/transport";
import type {
  IdentificationEvidence,
  Vehicle,
  VehicleConfidence,
} from "@/src/obd/types";
import {
  isFullVin,
  keepVinChars,
  modelYearsForChar,
  VIN_LENGTH,
  vinCheckDigitOk,
  wmiManufacturer,
} from "@/src/utils/vin";

export type Identification = {
  vehicle: Vehicle;
  evidence: IdentificationEvidence;
};

/** The remote decoder, injectable so the whole pipeline can be exercised
 *  without a network — the same reason every parser beneath it is a pure
 *  function. */
export type VinDecoder = (
  vin: string,
  opts?: { timeoutMs?: number },
) => Promise<VinDecodeResult>;

/** Shortest VIN fragment still worth a make: three characters is a world
 *  manufacturer code, and a manufacturer is a real answer. */
const MIN_FRAGMENT_CHARS = 3;

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

/** The "nothing readable" vehicle. Takes the odometer because mileage does
 *  not depend on the VIN: a car whose VIN we failed to read can still
 *  report its kilometres. */
export function unidentifiedVehicle(
  vin: string | null,
  mileage: number | null = null,
): Vehicle {
  return {
    vin: vin ?? "",
    make: "Unknown",
    model: "",
    year: 0,
    mileage,
    confidence: "unknown",
  };
}

/** Identification for a connect that got a link but no readable vehicle —
 *  a transport that threw mid-read, say. Keeps the dashboard working and
 *  says why, instead of inventing a car. */
export function unidentified(reason: string): Identification {
  return {
    vehicle: unidentifiedVehicle(null),
    evidence: {
      vinFromEcu: null,
      calid: [],
      ecuName: null,
      protocol: null,
      vpicStatus: "not-run",
      warnings: [reason],
    },
  };
}

/**
 * Identification from a leading fragment of a VIN — what a car that answers
 * mode 09 and then stops talking leaves us. There is no model or year in
 * three to sixteen characters, but there is a manufacturer, and a dashboard
 * reading "Volkswagen" beats one reading "Unknown" for a driver holding a
 * fault code they cannot place.
 *
 * The manufacturer half of that sentence is load-bearing, and it is the half
 * that can be missing. A fragment names a maker only when its first three
 * characters are a manufacturer's — otherwise the bytes are not a short VIN
 * at all, they are whatever the ECU keeps under an identifier that happens to
 * be the VIN's. The measured 2004 car answers `1A 90` with `B3338`, and `B33`
 * is registered to nobody: a five-byte part number read as a VIN, which put
 * "Partial VIN · 5 of 17" on the dashboard and set a reader looking for a
 * sixth character of a car's identity in a field that never held one. The
 * bytes are kept on the evidence screen — they are what the ECU said, and
 * they are how the next reader recognises the shape — but the vehicle keeps
 * no VIN and no make.
 */
function identifyFromFragment(
  fragment: string,
  info: VehicleInfo,
  rawVin: string | null,
): Identification {
  const wmi = fragment.slice(0, 3);
  // Which request produced the fragment, when it is known. "The ECU returned
  // five characters" is the fact; "mode 09 returned five characters" was a
  // guess that the fragment came from the standard PID, and on a car that
  // refuses mode 09 and answers the maker's own service instead it sent the
  // reader to look at a read that had returned nothing at all.
  const from = info.vinFrom ? ` ${info.vinFrom}` : "";
  const make = wmiManufacturer(fragment);
  if (make === null) {
    return {
      vehicle: unidentifiedVehicle(null, info.mileage ?? null),
      evidence: {
        vinFromEcu: rawVin,
        vinFrom: info.vinFrom ?? null,
        calid: info.calid,
        ecuName: info.ecuName,
        protocol: info.protocol,
        reads: info.reads,
        vpicStatus: "not-run",
        warnings: [
          `The ECU answered${from} with ${fragment.length} characters (${fragment}), and ${wmi} is not a world manufacturer code — so these bytes are not the start of a VIN and no make can be read from them.`,
        ],
      },
    };
  }
  return {
    vehicle: {
      vin: fragment,
      make,
      model: "",
      year: guessYearFromVin(fragment) ?? 0,
      mileage: info.mileage ?? null,
      confidence: "low",
    },
    evidence: {
      vinFromEcu: rawVin,
      vinFrom: info.vinFrom ?? null,
      calid: info.calid,
      ecuName: info.ecuName,
      protocol: info.protocol,
      reads: info.reads,
      vpicStatus: "not-run",
      warnings: [
        `The ECU answered${from} with ${fragment.length} of the ${VIN_LENGTH} VIN characters, so the VIN is incomplete.`,
        `The make comes from the world manufacturer code ${wmi} alone — the fragment carries no model or year.`,
      ],
    },
  };
}

export async function identifyVehicle(
  transport: ObdTransport,
  opts: {
    decode?: VinDecoder;
    sweepIdentification?: boolean;
    /** Modules a scan has already heard from — see
     *  {@link VehicleInfoOptions.moduleAddresses}. */
    moduleAddresses?: number[];
  } = {},
): Promise<Identification> {
  const decodeVin = opts.decode ?? decodeVinRemote;
  // Passed through rather than decided here: whether twelve seconds of
  // probing is affordable is a fact about the caller's moment, not about the
  // car — the scan re-identifies with the codes already in hand, and a
  // connect must not.
  const info = await transport.readVehicleInfo({
    sweepIdentification: opts.sweepIdentification,
    moduleAddresses: opts.moduleAddresses,
  });

  const warnings: string[] = [];
  // A check digit that does not add up is a fact about the *rule*, not about
  // the car: ISO 3779 requires it only in North America and most European
  // manufacturers never compute one. Said out loud, but it must not lower a
  // confidence the decoder earned.
  const softWarnings: string[] = [];
  const rawVin = info.vin;
  const vin = rawVin ? keepVinChars(rawVin) : "";

  // A fragment is not a failure. The old rule — a VIN is either 17 clean
  // characters or it is thrown away — discarded exactly the case a real
  // car produces, and with it the only identification the car had given.
  if (vin.length >= MIN_FRAGMENT_CHARS && !isFullVin(vin)) {
    return identifyFromFragment(vin, info, rawVin);
  }

  if (vin.length !== VIN_LENGTH) {
    if (rawVin) {
      warnings.push(
        `The ECU answered${info.vinFrom ? ` ${info.vinFrom}` : ""} with ${vin.length} usable VIN character${vin.length === 1 ? "" : "s"}.`,
      );
    } else {
      // Which of the several ways it did not is on the reads list right
      // below; this line says only what is certain from every one of them.
      // It no longer names mode 09: two questions are asked for a VIN — the
      // standard PID and the maker's own service — and when both come back
      // empty, naming one of them points at a read that is not the only one
      // that failed.
      warnings.push("No VIN came back — see the reads below for what each request returned.");
    }
    return {
      vehicle: unidentifiedVehicle(rawVin, info.mileage ?? null),
      evidence: {
        vinFromEcu: rawVin,
        vinFrom: info.vinFrom ?? null,
        calid: info.calid,
        ecuName: info.ecuName,
        protocol: info.protocol,
        reads: info.reads,
        vpicStatus: "not-run",
        warnings,
      },
    };
  }

  if (vinCheckDigitOk(vin) === false) {
    softWarnings.push(
      "The VIN check digit (position 9) does not add up — a North-American requirement that European makers usually do not compute. The VIN was decoded as read.",
    );
  }

  const wmiMake = wmiManufacturer(vin);
  let make = "";
  let model = "";
  let year = 0;
  let enrichment: Partial<Vehicle> = {};
  let vpicStatus: IdentificationEvidence["vpicStatus"] = "not-run";
  let base: VehicleConfidence = "unknown";

  const decode = await decodeVin(vin);
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
    // A European VIN trips exactly one rule in vPIC — the check digit — and
    // comes back with make, model and year decoded anyway. Calling that a
    // low-confidence identity would be repeating the decoder's own mistake.
    const checkDigitOnly = checkDigitOnlyFailure(decode.errorCode);
    base = checkDigitOnly && clean(decode.make) ? "medium" : "low";
    make = clean(decode.make) ?? wmiMake ?? "";
    model = clean(decode.model) ?? "";
    year = intOrUndefined(decode.year ?? "") ?? guessYearFromVin(vin) ?? 0;
    if (checkDigitOnly) {
      softWarnings.push(
        `NHTSA decoded the VIN and flagged only the check digit: ${decode.errorText}`,
      );
    } else if (!decode.make && !wmiMake) {
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
    mileage: info.mileage ?? null,
    ...enrichment,
    confidence: downgradeConfidence(base, warnings.length),
  };

  return {
    vehicle,
    evidence: {
      vinFromEcu: info.vin,
      vinFrom: info.vinFrom ?? null,
      calid: info.calid,
      ecuName: info.ecuName,
      protocol: info.protocol,
      vpicStatus,
      warnings: [...warnings, ...softWarnings],
    },
  };
}
