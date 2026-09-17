// Offline + optional network smoke tests for the VIN utilities.
// Run: npx tsx scripts/vin-smoke.ts [--network]

import {
  computeCheckDigit,
  isFullVin,
  isPartialVin,
  keepVinChars,
  modelYearsForChar,
  validateVin,
  vinCheckDigitOk,
  vinRegion,
  wmiManufacturer,
} from "../src/utils/vin";
import { checkDigitOnlyFailure } from "../src/api/vpic";
import type {
  VinDecodeOk,
  VinDecodePartial,
  VinDecodeResult,
} from "../src/api/vpic";
import { identifyVehicle } from "../src/obd/identify";
import type { VinDecoder } from "../src/obd/identify";
import type { ObdTransport, VehicleInfo } from "../src/obd/transport";

let failures = 0;

function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail !== undefined ? ` — got: ${JSON.stringify(detail)}` : ""}`);
  }
}

function eq<T>(label: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? undefined : actual);
}

// --- Local validation -------------------------------------------------------

// Real published VINs (API-confirmed clean decodes).
eq("validates WBA5R1C5XKAK00001", validateVin("WBA5R1C5XKAK00001").valid, true);
eq("validates 1M8GDM9AXKP042788", validateVin("1M8GDM9AXKP042788").valid, true);
eq("validates lowercase/whitespace", validateVin("  wba5r1c5xkak00001 ").valid, true);

// Check digit with a placeholder at position 9.
eq("check digit BMW fixture", computeCheckDigit("WBA5R1C50KAK00001"), "X");
eq("check digit wiki fixture", computeCheckDigit("1M8GDM9A0KP042788"), "X");

// Invalid cases.
const short = validateVin("WBA5R1C5XKAK0000");
eq("rejects 16 chars", short.valid, false);
check("16-char reason mentions length", short.reasons[0].includes("17"), short.reasons[0]);

const badChar = validateVin("WBA5R1C5XKAK0000I");
eq("rejects I character", badChar.valid, false);
check("bad-char reason names the char", badChar.reasons.some((r) => r.includes("'I'")), badChar.reasons);

const tampered = validateVin("WAU1JZXW0KP000001"); // expected 1, found 0
eq("rejects tampered check digit", tampered.valid, false);
check("mismatch reason present", tampered.reasons.some((r) => r.includes("mismatch")), tampered.reasons);

// --- Decoding helpers -------------------------------------------------------

eq("region '1'", vinRegion("1"), "North America");
eq("region 'W'", vinRegion("W"), "Europe");
eq("region 'J'", vinRegion("J"), "Asia");
eq("region '6'", vinRegion("6"), "Oceania");
eq("region '9'", vinRegion("9"), "South America");
eq("region unknown", vinRegion("?"), "Unknown");

eq("year char J", modelYearsForChar("J"), [1988, 2018, 2048]);
eq("year char F", modelYearsForChar("F"), [1985, 2015, 2045]);
eq("year char L", modelYearsForChar("L"), [1990, 2020, 2050]);
eq("year char bogus", modelYearsForChar("I"), []);

eq("WMI WVW", wmiManufacturer("WVW1JZXWXJP000001"), "Volkswagen");
eq("WMI WBA", wmiManufacturer("WBA1JZXW2GP000001"), "BMW");
eq("WMI 4T1", wmiManufacturer("4T11JZXW1LP000001"), "Toyota");
eq("WMI WAU", wmiManufacturer("WAU1JZXW1KP000001"), "Audi");
eq("WMI 1FA", wmiManufacturer("1FA1JZXW3FP000001"), "Ford");
eq("WMI WDD", wmiManufacturer("WDD1JZXWXHP000001"), "Mercedes-Benz");
eq("WMI unknown", wmiManufacturer("ZZZ1JZXWXJP000001"), null);

// --- Synthetic fixture VINs -------------------------------------------------
// The WMI fixtures used above, checked as whole VINs: check digit included.
// All six were verified live against NHTSA vPIC — no check-digit error, and
// each WMI resolves to the manufacturer the check above expects.

const FIXTURE_VINS = [
  "WVW1JZXWXJP000001",
  "WBA1JZXW2GP000001",
  "4T11JZXW1LP000001",
  "WAU1JZXW1KP000001",
  "1FA1JZXW3FP000001",
  "WDD1JZXWXHP000001",
];

for (const vin of FIXTURE_VINS) {
  eq(`fixture ${vin.slice(0, 3)} validates`, validateVin(vin).valid, true);
}

// --- A VIN is 17 characters. The check digit is a separate fact. ------------
//
// The check digit is required by 49 CFR 565 in North America and by nothing
// anywhere else, so most European VINs fail it by arithmetic accident. The
// predicate the identification pipeline asks about must therefore be length
// and character set — the check digit is reported, never used to discard.

const EU_VIN = "WVWZZZ1JZXW000001"; // 17 legal characters, check digit fails

eq("isFullVin accepts a European VIN with no check digit", isFullVin(EU_VIN), true);
eq("…and the check digit really does fail", vinCheckDigitOk(EU_VIN), false);
eq("validateVin still rejects it (the rule is unchanged)", validateVin(EU_VIN).valid, false);
eq("isFullVin rejects 16 characters", isFullVin("WVWZZZ1JZXW00000"), false);
eq("isFullVin rejects 18 characters", isFullVin(`${EU_VIN}0`), false);
eq("isFullVin rejects a letter a VIN cannot contain", isFullVin("WVWZZZ1JZXW00000I"), false);
eq("isFullVin rejects null", isFullVin(null), false);
eq("vinCheckDigitOk is null, not false, for a non-VIN", vinCheckDigitOk("WVW"), null);

eq("isPartialVin rejects two characters", isPartialVin("WV"), false);
eq("isPartialVin accepts a bare WMI", isPartialVin("WVW"), true);
eq("isPartialVin accepts sixteen characters", isPartialVin("WVWZZZ1JZXW00000"), true);
eq("isPartialVin rejects a whole VIN", isPartialVin(EU_VIN), false);
eq("isPartialVin rejects empty", isPartialVin(""), false);
eq("isPartialVin rejects null", isPartialVin(null), false);

eq("keepVinChars drops separators", keepVinChars(" wvw-zzz 1jz xw0 00001 "), EU_VIN);
eq("keepVinChars drops I, O and Q", keepVinChars("IOWVW"), "WVW");
eq("keepVinChars uppercases", keepVinChars("wvw"), "WVW");

// The manufacturer table has to cover the cars a European scanner meets —
// Hyundai and Kia were missing entirely, which is how a readable VIN turned
// into an unknown make.
const WMI_CASES: [string, string][] = [
  ["KMHDU41DB8U123456", "Hyundai"],
  ["TMAJ3812W5J123456", "Hyundai"],
  ["U5YFF812ABL123456", "Kia"],
  ["KNALD2211B5123456", "Kia"],
  ["TMBEH41Z9B2123456", "Skoda"],
  ["VF1RFB00X12345678", "Renault"],
  ["UU1LSDFC123456789", "Dacia"],
  ["ZFA12300000123456", "Fiat"],
  ["JMBLYV97W8J123456", "Mitsubishi"],
  ["XTA21150012345678", "Lada"],
  ["JHMCM56557C123456", "Honda"],
  ["YV1SW58K1234567890", "Volvo"],
  ["W0L0XCF1234567890", "Opel"],
  ["ZAR12300001234567", "Alfa Romeo"],
  ["SAJWA1CB1234567890", "Jaguar"],
];
for (const [vin, make] of WMI_CASES) {
  eq(`WMI ${vin.slice(0, 3)} → ${make}`, wmiManufacturer(vin), make);
}

eq("vPIC error code 1 alone is a check-digit-only failure", checkDigitOnlyFailure("1"), true);
eq("…and so is 1 with a 0 beside it", checkDigitOnlyFailure("1,0"), true);
eq("a clean decode is not a failure", checkDigitOnlyFailure("0"), false);
eq("code 1 next to a real error is not check-digit-only", checkDigitOnlyFailure("1,5"), false);
eq("an empty code list is not a check-digit failure", checkDigitOnlyFailure(""), false);

// --- Network (optional) -----------------------------------------------------

async function runNetworkTests() {
  const { decodeVinRemote } = await import("../src/api/vpic");
  console.log("  … network tests (NHTSA vPIC) …");

  const ok = await decodeVinRemote("WBA5R1C5XKAK00001");
  if (ok.status === "ok") {
    eq("BMW fixture decodes ok", ok.make, "BMW");
    eq("BMW fixture model", ok.model, "330i");
    eq("BMW fixture year", ok.year, "2019");
  } else {
    check(`BMW fixture decodes ok (got ${ok.status})`, false, ok);
  }

  const partial = await decodeVinRemote("WVW1JZXWXJP000001");
  check("synthetic VW VIN -> partial", partial.status === "partial", partial.status);
  if (partial.status === "partial") {
    eq("partial resolves WMI make", partial.make, "VOLKSWAGEN");
  }
}

// --- The identification pipeline -------------------------------------------
//
// The decoder is injected, so the whole path runs offline — and the point of
// these cases is the one the app got wrong on a real car: a European VIN that
// fails the check digit, and an ECU that answers mode 09 with a fragment.

const transportWith = (info: Partial<VehicleInfo>): ObdTransport =>
  ({
    readVehicleInfo: async (): Promise<VehicleInfo> => ({
      vin: null,
      calid: [],
      ecuName: null,
      protocol: null,
      mileage: null,
      ...info,
    }),
  }) as unknown as ObdTransport;

const okDecoder = (fields: Partial<VinDecodeOk> = {}): VinDecoder =>
  async (): Promise<VinDecodeResult> => ({
    status: "ok",
    make: "Volkswagen",
    model: "Golf",
    year: "2018",
    manufacturer: "VOLKSWAGEN AG",
    plantCountry: "GERMANY",
    engineModel: "",
    engineCylinders: "",
    fuelType: "",
    transmission: "",
    driveType: "",
    confidence: "medium",
    ...fields,
  });

const partialDecoder = (
  errorCode: string,
  fields: Partial<VinDecodePartial> = {},
): VinDecoder =>
  async (): Promise<VinDecodeResult> => ({
    status: "partial",
    errorCode,
    errorText: "Check digit invalid",
    confidence: "low",
    ...fields,
  });

const failingDecoder: VinDecoder = async () => ({
  status: "error",
  reason: "network",
  message: "Network request to NHTSA failed",
});

async function runIdentificationTests() {
  console.log("  … identification pipeline …");

  // 1. The case that was broken: a clean 17-character European VIN, which
  //    vPIC answers with a failed check digit and a full identity anyway.
  const eu = await identifyVehicle(
    transportWith({ vin: EU_VIN, calid: ["06K9060234"] }),
    { decode: partialDecoder("1", { make: "VOLKSWAGEN", model: "GOLF", year: "2016" }) },
  );
  eq("id: the whole VIN is kept, not discarded", eu.vehicle.vin, EU_VIN);
  eq("id: the decoder's make is used", eu.vehicle.make, "VOLKSWAGEN");
  eq("id: the model comes through", eu.vehicle.model, "GOLF");
  eq("id: the year comes through", eu.vehicle.year, 2016);
  eq("id: a check-digit-only failure is medium, not low", eu.vehicle.confidence, "medium");
  eq("id: vPIC status is partial", eu.evidence.vpicStatus, "partial");
  check(
    "id: the check digit is explained, not hidden",
    eu.evidence.warnings.some((w) => w.includes("check digit")),
    eu.evidence.warnings,
  );

  // 2. A fragment: no model, no year, but a manufacturer — which is the
  //    whole answer when the ECU stops talking after six characters.
  const neverCalled: VinDecoder = async () => {
    throw new Error("the decoder was asked about a fragment");
  };
  const frag = await identifyVehicle(transportWith({ vin: "WVWZZZ" }), {
    decode: neverCalled,
  });
  eq("id: a fragment is not sent to NHTSA", frag.evidence.vpicStatus, "not-run");
  eq("id: a fragment still names the manufacturer", frag.vehicle.make, "Volkswagen");
  eq("id: a fragment carries no model", frag.vehicle.model, "");
  eq("id: a fragment carries no year", frag.vehicle.year, 0);
  eq("id: a fragment is low confidence, not unconfirmed", frag.vehicle.confidence, "low");
  eq("id: the fragment itself is kept as the VIN", frag.vehicle.vin, "WVWZZZ");
  check(
    "id: the incompleteness is stated in characters",
    frag.evidence.warnings.some((w) => w.includes("6 of the 17")),
    frag.evidence.warnings,
  );

  // 3. A three-character fragment — the floor.
  const wmiOnly = await identifyVehicle(transportWith({ vin: "KMH" }), {
    decode: neverCalled,
  });
  eq("id: a bare WMI names the make", wmiOnly.vehicle.make, "Hyundai");

  // 4. A fragment whose WMI is not in the table: honest, not guessed.
  const unknownWmi = await identifyVehicle(transportWith({ vin: "ZZZ1J" }), {
    decode: neverCalled,
  });
  eq("id: an unregistered WMI is Unknown", unknownWmi.vehicle.make, "Unknown");
  eq("id: …and unconfirmed", unknownWmi.vehicle.confidence, "unknown");
  check(
    "id: …and says which code it could not place",
    unknownWmi.evidence.warnings.some((w) => w.includes("ZZZ")),
    unknownWmi.evidence.warnings,
  );

  // 4b. The measured 2004 car, byte for byte. It refuses `0902` with
  //     `7F 09 12` and answers `1A 90` with `5A 90 42 33 33 33 38 FF 00` —
  //     `B3338`, five characters, which `B33` not being a manufacturer says
  //     is a part number sitting in the field the VIN's first five characters
  //     would occupy. The dashboard used to read "Partial VIN · 5 of 17",
  //     which is a claim about a car whose VIN starts `B3338`; there is no
  //     such car. The bytes are still shown — they are what the ECU said, and
  //     they are how the next reader recognises the shape — but no make and no
  //     VIN are invented from them.
  const partNumber = await identifyVehicle(
    transportWith({ vin: "B3338", vinFrom: "1A 90" }),
    { decode: neverCalled },
  );
  eq("id: bytes that are not a VIN prefix name no maker", partNumber.vehicle.make, "Unknown");
  eq("id: …and no VIN is carried out of them", partNumber.vehicle.vin, "");
  eq("id: …at no confidence at all", partNumber.vehicle.confidence, "unknown");
  eq("id: …while the ECU's own bytes are kept", partNumber.evidence.vinFromEcu, "B3338");
  eq("id: …and the request that produced them", partNumber.evidence.vinFrom, "1A 90");
  check(
    "id: the warning says these are not the start of a VIN, not that a VIN is short",
    partNumber.evidence.warnings.some((w) => w.includes("not a world manufacturer code")),
    partNumber.evidence.warnings,
  );
  check(
    "id: …and nothing claims a partial VIN",
    !partNumber.evidence.warnings.some((w) => /of the 17 VIN characters/.test(w)),
    partNumber.evidence.warnings,
  );

  // 5. No VIN at all — the odometer is still a real fact about the car.
  const silent = await identifyVehicle(
    transportWith({ vin: null, mileage: 178432, protocol: "ISO 14230-4 (KWP2000, fast init)" }),
    { decode: failingDecoder },
  );
  eq("id: silence keeps the odometer", silent.vehicle.mileage, 178432);
  eq("id: silence is unconfirmed", silent.vehicle.confidence, "unknown");
  check(
    // It points at the reads list rather than naming one request: two are
    // asked for a VIN, and a sentence that names one of them sends the reader
    // to a read that is not the only one that came back empty.
    "id: …and points at the reads, not at the car",
    silent.evidence.warnings.some((w) => w.includes("see the reads below")),
    silent.evidence.warnings,
  );

  // 6. NHTSA unreachable: the local WMI and the model-year character still
  //    identify the car, at reduced confidence, and the failure is admitted.
  const offline = await identifyVehicle(transportWith({ vin: EU_VIN }), {
    decode: failingDecoder,
  });
  eq("id: the local WMI table covers an offline decode", offline.vehicle.make, "Volkswagen");
  eq("id: the year comes from the model-year character", offline.vehicle.year, 1999);
  eq("id: an offline decode is low confidence", offline.vehicle.confidence, "low");
  eq("id: the lookup failure is recorded", offline.evidence.vpicStatus, "error");
  check(
    "id: …and reported",
    offline.evidence.warnings.some((w) => w.includes("NHTSA lookup failed")),
    offline.evidence.warnings,
  );

  // 7. The decoder and the WMI table disagree — the mismatch is the finding,
  //    and it must survive into the warnings.
  const mismatched = await identifyVehicle(
    transportWith({ vin: EU_VIN, calid: ["06K9060234"] }),
    { decode: okDecoder({ make: "Skoda", confidence: "high" }) },
  );
  check(
    "id: a decoder that contradicts the WMI is flagged",
    mismatched.evidence.warnings.some(
      (w) => w.includes("Skoda") && w.includes("Volkswagen"),
    ),
    mismatched.evidence.warnings,
  );
  eq("id: the contradiction lowers confidence", mismatched.vehicle.confidence, "medium");

  // 8. A clean decode with the second identification factor present.
  const clean = await identifyVehicle(
    transportWith({ vin: EU_VIN, calid: ["06K9060234"], mileage: 120000 }),
    { decode: okDecoder({ confidence: "high" }) },
  );
  eq("id: a clean decode keeps its confidence", clean.vehicle.confidence, "high");
  eq("id: …and the mileage rides along", clean.vehicle.mileage, 120000);
}

function finish() {
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

async function main() {
  await runIdentificationTests();
  if (process.argv.includes("--network")) await runNetworkTests();
  finish();
}

main().catch((e) => {
  console.error("Smoke run failed:", e);
  process.exit(1);
});
