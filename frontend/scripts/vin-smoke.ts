// Offline + optional network smoke tests for the VIN utilities.
// Run: npx tsx scripts/vin-smoke.ts [--network]

import {
  buildDemoVin,
  computeCheckDigit,
  modelYearsForChar,
  validateVin,
  vinRegion,
  wmiManufacturer,
} from "../src/utils/vin";

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

// --- Demo VIN generation (deterministic via injected serial) ----------------

// All six were verified live against NHTSA vPIC: no check-digit error,
// WMI resolves to the expected manufacturer.
eq("demo VW", buildDemoVin("WVW", 2018, "000001"), "WVW1JZXWXJP000001");
eq("demo BMW", buildDemoVin("WBA", 2016, "000001"), "WBA1JZXW2GP000001");
eq("demo Toyota", buildDemoVin("4T1", 2020, "000001"), "4T11JZXW1LP000001");
eq("demo Audi", buildDemoVin("WAU", 2019, "000001"), "WAU1JZXW1KP000001");
eq("demo Ford", buildDemoVin("1FA", 2015, "000001"), "1FA1JZXW3FP000001");
eq("demo Mercedes", buildDemoVin("WDD", 2017, "000001"), "WDD1JZXWXHP000001");

// Every generated demo VIN must validate.
for (const [wmi, year] of [["WVW", 2018], ["WBA", 2016], ["4T1", 2020], ["WAU", 2019], ["1FA", 2015], ["WDD", 2017]] as const) {
  const vin = buildDemoVin(wmi, year);
  eq(`demo ${wmi} validates`, validateVin(vin).valid, true);
}

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

function finish() {
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

if (process.argv.includes("--network")) {
  runNetworkTests().then(finish).catch((e) => {
    console.error("Network test run failed:", e);
    process.exit(1);
  });
} else {
  finish();
}
