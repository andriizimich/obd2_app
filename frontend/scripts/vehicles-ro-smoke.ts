// Smoke test for the Romanian vehicle dataset (src/data/vehicles-ro.json).
// Run with: npx tsx scripts/vehicles-ro-smoke.ts
//
// No adapter, no network — the dataset is a static file and this only checks
// that it is shaped the way the picker walks it: one unique id per node,
// every level non-empty, and year ranges that read oldest → newest. What it
// cannot check is whether the years are *true*; a wrong-but-plausible range
// passes here. A typo like 920 does not — that is what the floor is for.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "data",
  "vehicles-ro.json",
);

type Generation = { id: string; name: string; from: number; to: number | null };
type Model = { id: string; name: string; generations: Generation[] };
type Make = { id: string; name: string; models: Model[] };
type Dataset = { version: number; makes: Make[] };

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

/** A slug is lowercase ASCII, digits, single hyphens between segments. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Newest production year the dataset is allowed to claim. */
const MAX_YEAR = 2100;

/** The car is younger than this, so no generation may have ended before it. */
const YEAR_FLOOR = 1950;

const list = (items: string[], max = 4) =>
  items.length <= max
    ? items.join("; ")
    : `${items.slice(0, max).join("; ")} (+${items.length - max} more)`;

function load(): { dataset: Dataset | null; problem: string | null; bytes: number } {
  let raw: string;
  try {
    raw = readFileSync(DATA_PATH, "utf8");
  } catch (e) {
    return { dataset: null, problem: `cannot read the file: ${(e as Error).message}`, bytes: 0 };
  }
  try {
    return { dataset: JSON.parse(raw) as Dataset, problem: null, bytes: Buffer.byteLength(raw) };
  } catch (e) {
    return { dataset: null, problem: (e as Error).message, bytes: raw.length };
  }
}

function main() {
  const { dataset, problem, bytes } = load();

  check(
    "the dataset file parses as JSON",
    problem === null && dataset !== null,
    problem ?? `${bytes} bytes`,
  );
  if (!dataset) {
    report();
    return;
  }

  check(
    "the dataset declares a version",
    Number.isInteger(dataset.version),
    String(dataset.version),
  );
  check(
    "the dataset declares a non-empty makes array",
    Array.isArray(dataset.makes) && dataset.makes.length > 0,
    Array.isArray(dataset.makes) ? `${dataset.makes.length} makes` : "not an array",
  );

  // --- The walk -----------------------------------------------------------

  /** Every id in the whole tree, mapped to where it was claimed. */
  const owners = new Map<string, string>();
  const duplicates: string[] = [];
  const badSlugs: string[] = [];
  const emptyNames: string[] = [];
  const makesWithoutModels: string[] = [];
  const modelsWithoutGenerations: string[] = [];
  const badFrom: string[] = [];
  const badTo: string[] = [];
  const unordered: string[] = [];
  const tooOld: string[] = [];

  let modelCount = 0;
  let generationCount = 0;

  const claim = (id: unknown, where: string) => {
    const key = String(id);
    const owner = owners.get(key);
    if (owner) duplicates.push(`"${key}" in ${owner} and ${where}`);
    else owners.set(key, where);
    if (typeof id !== "string" || !SLUG.test(id)) {
      badSlugs.push(`${where} = ${JSON.stringify(id)}`);
    }
  };

  const checkName = (name: unknown, where: string) => {
    if (typeof name !== "string" || name.trim().length === 0) {
      emptyNames.push(`${where} = ${JSON.stringify(name)}`);
    }
  };

  for (const [mi, make] of dataset.makes.entries()) {
    claim(make.id, `make[${mi}]`);
    checkName(make.name, `make[${mi}] name`);

    const models = Array.isArray(make.models) ? make.models : [];
    if (models.length === 0) makesWithoutModels.push(`${make.id} (make[${mi}])`);

    for (const [mmi, model] of models.entries()) {
      modelCount += 1;
      const modelPath = `${make.id}.${model.id}`;
      claim(model.id, `${modelPath} (model)`);
      checkName(model.name, `${modelPath} name`);

      const gens = Array.isArray(model.generations) ? model.generations : [];
      if (gens.length === 0) modelsWithoutGenerations.push(`${modelPath} (model[${mmi}])`);

      for (const [gi, gen] of gens.entries()) {
        generationCount += 1;
        const genPath = `${modelPath}.${gen.id}`;
        claim(gen.id, `${genPath} (generation)`);
        checkName(gen.name, `${genPath} name`);

        const from = gen.from as unknown;
        if (!Number.isInteger(from) || (from as number) < 1885 || (from as number) > MAX_YEAR) {
          badFrom.push(`${genPath} from = ${JSON.stringify(gen.from)}`);
        }

        const to = gen.to as unknown;
        if (to !== null) {
          if (
            !Number.isInteger(to) ||
            (to as number) < (from as number) ||
            (to as number) > MAX_YEAR
          ) {
            badTo.push(`${genPath} ${JSON.stringify(gen.from)}–${JSON.stringify(gen.to)}`);
          } else if ((to as number) < YEAR_FLOOR) {
            tooOld.push(`${genPath} ends in ${to}`);
          }
        }

        // Strictly increasing: two generations of one model sharing a start
        // year would make the picker's order arbitrary.
        const prev = gens[gi - 1] as Generation | undefined;
        if (prev && !((prev.from as number) < (from as number))) {
          unordered.push(`${modelPath}: ${JSON.stringify(gen.from)} after ${JSON.stringify(prev.from)}`);
        }
      }
    }
  }

  check("every id in the tree is unique", duplicates.length === 0, list(duplicates));
  check("every id is a lowercase ASCII slug", badSlugs.length === 0, list(badSlugs));
  check("every make, model and generation is named", emptyNames.length === 0, list(emptyNames));
  check("every make has at least one model", makesWithoutModels.length === 0, list(makesWithoutModels));
  check(
    "every model has at least one generation",
    modelsWithoutGenerations.length === 0,
    list(modelsWithoutGenerations),
  );
  check("every from is an integer in 1885..2100", badFrom.length === 0, list(badFrom));
  check("every to is null or an integer at or after from", badTo.length === 0, list(badTo));
  check(
    "generations run oldest to newest",
    unordered.length === 0,
    list(unordered),
  );
  check(
    `no generation ends before ${YEAR_FLOOR}`,
    tooOld.length === 0,
    list(tooOld),
  );

  console.log(
    `\n${dataset.makes.length} makes · ${modelCount} models · ${generationCount} generations · ${bytes} bytes`,
  );
  report();
}

function report() {
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

main();
