import { BUILD_STAMP } from "@/src/build";
import { groupDigits } from "@/src/format";
import { carWasRead } from "@/src/obd/diagnostics";
import { isFullVin, VIN_LENGTH } from "@/src/utils/vin";
import type { Coverage, DiagnosticReport, Fault, Vehicle } from "@/src/obd/types";

// Baked into the bundle at build time from EAS env vars (preview/production).
// They are NOT in the repo: it is public, and a bot token in git is a token
// anyone can use to write into the report chat. Rotate via @BotFather and
// re-run `eas env:set` — no code change needed.
const BOT_TOKEN = process.env.EXPO_PUBLIC_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.EXPO_PUBLIC_TELEGRAM_CHAT_ID;

/** parse_mode is HTML, so anything interpolated must be escaped or Telegram
 *  rejects the whole message with 400 and nothing is delivered. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const pad = (n: number) => String(n).padStart(2, "0");

/** Telegram's hard cap is 4096; HTML entities expand after counting, so the
 *  message is held well below it rather than measured exactly. */
const MAX_LEN = 3500;
const MAX_FAULT_LINES = 12;

/** One line per read: what was asked, and what came back. This is the part
 *  that says whether "no codes" means a healthy car or an unanswered ECU. */
const COVERAGE_MARK: Record<Coverage["status"], string> = {
  ok: "✓",
  empty: "✓",
  unsupported: "✗",
  error: "✗",
  skipped: "–",
};

function coverageLine(coverage: Coverage[]): string {
  if (coverage.length === 0) return "";
  const parts = coverage.map((c) => `${c.request} ${COVERAGE_MARK[c.status]}`);
  return `📋 Read: ${parts.join(" · ")}`;
}

/** Longer than any real reason; a wall of adapter text in a chat message
 *  helps nobody, and the field is only ever a phrase. */
const MAX_DETAIL = 110;

/**
 * Why each read came back empty — printed only when none of them worked.
 *
 * `03 ✗ · 07 ✗ · 0A ✗` is a footnote while the pass mostly succeeds. When
 * every mark is ✗ it is the entire message and it explains nothing, and the
 * five reasons behind those marks are different facts that call for
 * different things from the driver: `NO DATA` (the car does not do that),
 * `UNABLE TO CONNECT` (nothing answered on the bus at all — check the
 * ignition), a bare timeout (the adapter never finished), a negative
 * response (the ECU refused). The pass already knows which one it was; this
 * is that sentence, and without it the failure report says only "it did not
 * work".
 *
 * Gated on the all-✗ case on purpose. Under five ✓ marks the same lines would
 * push the fault list — the thing the message exists for — off the screen.
 */
function failureLines(coverage: Coverage[]): string[] {
  return coverage
    .filter((c) => c.status === "error" || c.status === "unsupported")
    .slice(0, 6)
    .map((c) => {
      const detail = c.detail ?? "no reason given";
      const short =
        detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail;
      return `   • ${c.request} — ${short}`;
    });
}

/** How much of the adapter's own output a failure report carries. */
const MAX_RAW_LINES = 12;

/**
 * The adapter's own words, when nothing could be read.
 *
 * "No readable reply" is the same sentence for two opposite situations: the
 * adapter sent nothing at all (only its prompt), or it sent bytes that this
 * app's parsers did not recognise. The first is an adapter or wiring problem,
 * the second is a parsing bug — and the coverage line cannot tell them apart,
 * because by the time the detail is built the difference has been thrown
 * away. The raw lines still carry it, so they ride along.
 *
 * Printed only when the pass read nothing. On a working car these lines are
 * the traffic the message is already summarising, and repeating it there
 * would bury the fault list.
 */
function rawLineBlock(rawLines: string[]): string[] {
  const shown = rawLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== ">")
    .slice(0, MAX_RAW_LINES);
  // An empty transcript is itself the finding: the adapter answered the AT
  // commands and then had nothing whatsoever to say about the vehicle.
  if (shown.length === 0) {
    return ["🔧 Adapter output: none — not a single data line came back"];
  }
  return [
    "🔧 Adapter output:",
    ...shown.map((line) =>
      `   | ${line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line}`,
    ),
  ];
}

/**
 * One fault, exactly one line — the shape the reader asked for.
 *
 * What belongs on the line is settled by what a person does with it: the
 * code identifies the fault, the title says what it means, and the module
 * says whose fault it is on a car with more than one. `stored` is left off
 * because it is the default, and a bracket that is always there stops being
 * read.
 */
function faultLine(fault: Fault): string {
  const title = fault.title?.trim() || "unknown code";
  const qualifiers = [
    fault.status && fault.status !== "stored" ? fault.status : null,
    fault.module ?? null,
    // A code the dictionary does not hold is titled with the category its own
    // bytes name — `P1246` comes out as "Fuel and air metering (injector
    // circuit)" — and on this line there is no second paragraph to say that
    // the dictionary never decoded it. The results screen can afford to let
    // `description` do the talking; a line in a chat cannot, and without this
    // the category reads as a diagnosis. Stated only for a definite `false`:
    // a fault built by hand carries no verdict either way.
    fault.known === false ? "not decoded" : null,
  ].filter(Boolean);
  const tag = qualifiers.length > 0 ? ` [${qualifiers.join(" · ")}]` : "";
  return `• ${fault.code} — ${title}${tag}`;
}

/**
 * The message body. The vehicle is passed separately because it carries the
 * VIN and the decoded identity, which the diagnostic pass never touches.
 */
export function reportText(vehicle: Vehicle, report: DiagnosticReport): string {
  const head: string[] = ["🚗 Radacini OBD"];

  // "Unknown" is what an undecoded vehicle carries — a placeholder, not a
  // name. Joining it into a `VIN:` line is how the report came to state a
  // VIN it had never read; each fact gets its own line, and a fact that was
  // not read gets no line at all.
  const name = [vehicle.make, vehicle.model]
    .filter((part) => part && part !== "Unknown")
    .join(" ");
  const title = [name, vehicle.year > 0 ? String(vehicle.year) : ""]
    .filter(Boolean)
    .join(" · ");

  if (title) head.push(`🚘 ${escapeHtml(title)}`);
  // A fragment is not a VIN. Five characters off a KWP2000 frame went out as
  // `🔑 VIN: B3338` — a report stating a VIN the car never gave — while the
  // dashboard printed the same five characters as "Partial VIN · 5 of 17".
  // The line is kept either way, because a report that drops what the ECU did
  // answer is worse than one that labels it; the label is the fix.
  if (vehicle.vin) {
    const vin = vehicle.vin.trim();
    head.push(
      isFullVin(vin)
        ? `🔑 VIN: ${escapeHtml(vin)}`
        : `🔑 Partial VIN: ${escapeHtml(vin)} (${vin.length} of ${VIN_LENGTH} characters)`,
    );
  }

  // Nothing was decoded and no VIN came back. The line says only what is
  // known — no VIN was read — because that is all that was observed. It used
  // to read "the ECU returned no VIN", which picks one of two very different
  // situations and picked wrong on a bus that answered nothing at all: the
  // result is identical, and the message blamed the car for the adapter's
  // silence. Which of the two it was is a fact for the identification screen,
  // not a guess to print here.
  //
  // It also no longer names `09 02`. Two questions are asked for a VIN now —
  // the standard PID and the maker's KWP2000 service — and this line prints
  // only when *both* came back empty, so naming one of them would send the
  // reader to look at a read that is not the only one that failed.
  if (!title && !vehicle.vin) {
    head.push("🚘 Vehicle: not identified — no VIN was read");
  }

  // A missing odometer prints no line at all: "Mileage: —" reads as "about
  // zero", while an absent line reads as "not reported".
  if (report.mileage !== null) {
    head.push(`🛣 Mileage: ${groupDigits(report.mileage)} km`);
  }
  if (report.protocol) head.push(`🔌 ${escapeHtml(report.protocol)}`);

  const opening: string[] = [];

  // Whether anything at all was read decides how the codes are introduced —
  // an empty list from an ECU that answered nothing is not a clean bill of
  // health, and must never be sent as one.
  const readSomething = carWasRead(report.coverage);

  if (report.status?.milOn) opening.push("⚠️ Check engine light: ON");

  const counts = [
    ["stored", report.faults.filter((f) => !f.status || f.status === "stored").length],
    ["pending", report.faults.filter((f) => f.status === "pending").length],
    ["permanent", report.faults.filter((f) => f.status === "permanent").length],
  ] as const;

  if (report.faults.length > 0) {
    const breakdown = counts
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${n} ${label}`)
      .join(" · ");
    opening.push(`🔴 ${report.faults.length} fault(s) — ${breakdown}`);
  } else if (readSomething) {
    opening.push("✅ No fault codes reported");
  } else {
    opening.push("⚠️ Nothing could be read from the ECU — no result, not a clean car");
  }

  const faultLines = (limit: number): string[] => {
    const lines = report.faults.slice(0, limit).map((f) => escapeHtml(faultLine(f)));
    if (report.faults.length > limit) {
      lines.push(`… and ${report.faults.length - limit} more`);
    }
    return lines;
  };

  const noteLines = report.notes.slice(0, 3).map((n) => `ℹ️ ${escapeHtml(n)}`);
  const coverage = coverageLine(report.coverage);
  const coverageLines = coverage ? [escapeHtml(coverage)] : [];
  // The reasons ride with the roll call rather than with the notes, because
  // the trimming ladder drops the notes first and these must survive: in the
  // all-✗ case they are the only part of the message that is worth reading.
  if (!readSomething) {
    coverageLines.push(...failureLines(report.coverage).map(escapeHtml));
    coverageLines.push(...rawLineBlock(report.rawLines ?? []).map(escapeHtml));
  }

  // Device-local time — the phone knows the driver's timezone, the server never did.
  const d = new Date(report.at);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · build ${BUILD_STAMP}`;

  const assemble = (body: string[]) => `${head.join("\n")}\n\n${[...body, stamp].join("\n")}`;

  // Trimming ladder: the codes and the coverage line are what make the
  // message worth sending, so the notes go first and the list shortens after.
  const attempts = [
    assemble([...opening, ...faultLines(MAX_FAULT_LINES), ...noteLines, ...coverageLines]),
    assemble([...opening, ...faultLines(MAX_FAULT_LINES), ...coverageLines]),
    assemble([...opening, ...faultLines(3), ...coverageLines]),
  ];

  return attempts.find((t) => t.length <= MAX_LEN) ?? attempts[attempts.length - 1];
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
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: reportText(vehicle, report),
        parse_mode: "HTML",
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage failed: ${res.status} ${body}`);
  }
}
