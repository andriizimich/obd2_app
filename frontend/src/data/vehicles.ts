// The car the driver tells us they are in.
//
// This exists because the car cannot be asked. A read of mode 09 is the right
// way to learn a VIN and it is the way this app tried first, but on the cars
// it has actually met the answer was `BUS BUSY`, `NO DATA` or five characters
// of a KWP2000 frame — and a diagnostic screen that waits twelve seconds to
// print "Vehicle not identified" is worse than one that asks. So the driver
// picks, and the app stops guessing.
//
// The catalogue is a bundled JSON file rather than a service: it has to work
// in a car park with no signal, which is the only place this app is ever
// opened. See `vehicles-ro.json` for provenance and its one caveat.
import catalogue from "@/src/data/vehicles-ro.json";

export type Generation = {
  id: string;
  name: string;
  /** First model year of this generation. */
  from: number;
  /** Last model year, or null while the generation is still built. */
  to: number | null;
};

export type Model = {
  id: string;
  name: string;
  generations: Generation[];
};

export type Make = {
  id: string;
  name: string;
  models: Model[];
};

/**
 * File order is the display order, and it is not alphabetical on purpose:
 * the catalogue is sorted by Romanian market presence, so the car most
 * drivers are standing in front of is the first row rather than somewhere
 * after `Subaru`. Re-sorting this anywhere would undo that.
 */
export const MAKES: Make[] = catalogue.makes as Make[];

/** Why the catalogue is not a register, shown once on the picker. */
export const CATALOGUE_CAVEAT: string = catalogue.caveat;

/**
 * Fold a name for searching: lower case, and without the diacritics nobody
 * types. `Škoda` has to be reachable by typing `skoda`, `Citroën` by
 * `citroen` — a driver searching for a car they own will not reach for the
 * caron key, and a search that returns nothing for a car that is in the list
 * is worse than having no search at all.
 */
const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

export function foldForSearch(s: string): string {
  return s.normalize("NFD").replace(DIACRITICS, "").toLowerCase().trim();
}

/** Rows whose name matches `query`. An empty query keeps everything. */
export function filterByName<T extends { name: string }>(
  rows: T[],
  query: string,
): T[] {
  const needle = foldForSearch(query);
  if (!needle) return rows;
  return rows.filter((row) => foldForSearch(row.name).includes(needle));
}

/** A generation's last model year — the current one while it is still built. */
export function lastYearOf(generation: Generation, currentYear: number): number {
  return generation.to ?? currentYear;
}

/**
 * Every model year this generation covers, newest first.
 *
 * Newest first because the car in front of the driver is far more often a
 * recent one, and the year they want is then at the top of the list instead
 * of behind twenty rows of its own history.
 */
export function yearsOf(generation: Generation, currentYear: number): number[] {
  const last = lastYearOf(generation, currentYear);
  const years: number[] = [];
  for (let year = last; year >= generation.from; year--) years.push(year);
  return years;
}

/** What the driver picked, in the shape the rest of the app speaks. */
export type CarPick = {
  make: Make;
  model: Model;
  generation: Generation;
  year: number;
};

/**
 * What to call the model on a line that also carries the year.
 *
 * Generation names in this catalogue repeat the model name — `Logan III`,
 * `Sandero II` — so the naive `${model} ${generation}` produces `Logan Logan
 * III`. When the generation already says which car it is, it is the whole
 * label; when it does not (`Golf VII` under `Volkswagen Golf`), the two are
 * joined.
 *
 * The generation is dropped entirely for a model that only ever had one: it
 * would be a version number the driver never chose and the car never had.
 */
export function modelLabel(model: Model, generation: Generation | null): string {
  if (!generation || model.generations.length <= 1) return model.name;
  return generation.name.toLowerCase().startsWith(model.name.toLowerCase())
    ? generation.name
    : `${model.name} ${generation.name}`;
}

/**
 * The name for the report and the results line: `Dacia Logan III · 2021`.
 */
export function describeCar(pick: CarPick): string {
  return `${pick.make.name} ${modelLabel(pick.model, pick.generation)} · ${pick.year}`;
}
