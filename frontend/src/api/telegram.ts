import { carWasRead } from "@/src/obd/diagnostics";
import type { Coverage, DiagnosticReport, Vehicle } from "@/src/obd/types";

// Baked into the bundle at build time from EAS env vars (preview/production).
// They are NOT in the repo: it is public, and a bot token in git is a token
// anyone can use to write into the report chat. Rotate via @BotFather and
// re-run `eas env:set` — no code change needed.
const BOT_TOKEN = process.env.EXPO_PUBLIC_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.EXPO_PUBLIC_TELEGRAM_CHAT_ID;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * How many codes the message carries.
 *
 * Above any real car — a module that reports eighty is a module with a
 * wiring fault, and the list stops being read long before this. It exists
 * so that a report can never be rejected by Telegram's 4096-character cap
 * and vanish without a trace.
 */
const MAX_CODES = 80;

/** Longer than any real reason, and short enough that two of them fit on
 *  the one line a failed pass gets. */
const MAX_REASON = 90;

/**
 * The message is three things and nothing else: when, which car, which codes.
 *
 * It used to be a document — a title with an emoji on every line, a VIN
 * line, a mileage line, the protocol, a breakdown of the fault lists by
 * status, the adapter's raw output, the build stamp. What that produced was
 * a wall the reader had to parse to find the one thing the message exists
 * for, which is the codes. Every one of those facts is still stored, still
 * on the results screen, still in the report the app builds; the chat is
 * for the list.
 *
 * No icons. Not a style preference: an emoji in front of every line is a
 * column of shapes the eye has to skip past on every reading, and the
 * codes are what is being read.
 */
export function reportText(vehicle: Vehicle, report: DiagnosticReport): string {
  // Device-local time — the phone knows the driver's timezone, the server
  // never did.
  const d = new Date(report.at);
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // "Unknown" is what an undecoded vehicle carries — a placeholder for the
  // code, not a name for a car. Joining it into the message is how a report
  // came to name a vehicle nobody had identified.
  const name = [vehicle.make, vehicle.model]
    .filter((part) => part && part !== "Unknown")
    .join(" ");
  const car =
    [name, vehicle.year > 0 ? String(vehicle.year) : ""].filter(Boolean).join(" · ") ||
    "Vehicle not identified";

  const codes = codeLines(report);

  return [when, car, ...codes].join("\n");
}

/**
 * The codes, one per line, at most once each.
 *
 * De-duplicated because the message shows nothing but the code: the same
 * code stored and pending is two entries in the report (they are two facts,
 * and the results screen says so) and would be two identical lines here,
 * which reads as a bug rather than as a distinction.
 */
function codeLines(report: DiagnosticReport): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const fault of report.faults) {
    if (seen.has(fault.code)) continue;
    seen.add(fault.code);
    codes.push(fault.code);
  }
  if (codes.length === 0) return [emptyLine(report)];
  if (codes.length <= MAX_CODES) return codes;
  return [...codes.slice(0, MAX_CODES), `+${codes.length - MAX_CODES} more`];
}

/**
 * What goes where the codes would have gone, when there are none.
 *
 * "No fault codes" and "nothing could be read" are opposite answers and the
 * message must not let them look alike: one says the car is fine, the other
 * says the app never got to ask. An empty body under the car's name would
 * read as the first of those every time.
 *
 * The reason rides along on the failure line because it is the whole
 * message when the pass read nothing, and because there is nowhere else
 * left to put it: the results screen shows the driver what it can, and this
 * line is what reaches anyone else.
 */
function emptyLine(report: DiagnosticReport): string {
  if (carWasRead(report.coverage)) return "No fault codes";
  const reasons = failureReasons(report.coverage);
  if (reasons.length === 0) return "Nothing could be read";
  const joined = reasons.join("; ");
  const short =
    joined.length > MAX_REASON ? `${joined.slice(0, MAX_REASON - 1)}…` : joined;
  return `Nothing could be read: ${short}`;
}

/**
 * Why the reads failed, from the reads that matter.
 *
 * The `AT` rows are excluded while any data row failed. The adapter's own
 * housekeeping is not the car: a pass that ends `ATPC error · 03 error`
 * would otherwise open with "does not implement AT PC", which is a fact
 * about a clone's firmware and not about the vehicle the reader is asking
 * after. They are used when they are all there is, because then they are
 * the only thing that came back at all.
 */
function failureReasons(coverage: Coverage[]): string[] {
  const failed = coverage.filter(
    (c) => c.status === "error" || c.status === "unsupported",
  );
  const data = failed.filter((c) => !/^AT/i.test(c.request));
  const reasons: string[] = [];
  for (const row of data.length > 0 ? data : failed) {
    const detail = (row.detail ?? "").trim();
    if (!detail || reasons.includes(detail)) continue;
    reasons.push(detail);
    if (reasons.length === 2) break;
  }
  return reasons;
}

export async function sendReport(
  vehicle: Vehicle,
  report: DiagnosticReport,
): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Telegram is not configured in this build");
  }
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No `parse_mode`. The escape-everything-or-Telegram-rejects-the-whole-
      // message dance (a car named `Škoda & Co` was a 400 waiting to happen)
      // is only needed for markup, and this message has none — a code list
      // reads the same in plain text, and there is nothing left to escape.
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: reportText(vehicle, report),
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage failed: ${res.status} ${body}`);
  }
}
