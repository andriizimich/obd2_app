import { groupDigits } from "@/src/format";
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

const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  permanent: "permanent",
};

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
  return `Read: ${parts.join(" · ")}`;
}

function faultLine(fault: Fault): string {
  const where = fault.module ? ` ${fault.module}` : "";
  const status = fault.status ? STATUS_LABEL[fault.status] : undefined;
  const tag = status ? ` [${status}]` : "";
  return `• ${fault.code}${where} — ${fault.title}${tag}`;
}

/**
 * The message body. The vehicle is passed separately because it carries the
 * VIN and the decoded identity, which the diagnostic pass never touches.
 */
export function reportText(vehicle: Vehicle, report: DiagnosticReport): string {
  const head: string[] = ["🚗 Radacini OBD"];

  const name = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
  const identity = [name, vehicle.vin].filter(Boolean).join(" · ");
  head.push(`VIN: ${escapeHtml(identity || "not read")}`);

  // A missing odometer prints no line at all: "Mileage: —" reads as "about
  // zero", while an absent line reads as "not reported".
  if (report.mileage !== null) {
    head.push(`Mileage: ${groupDigits(report.mileage)} km`);
  }
  if (report.protocol) head.push(escapeHtml(report.protocol));

  const opening: string[] = [];

  // Whether anything at all was read decides how the codes are introduced —
  // an empty list from an ECU that answered nothing is not a clean bill of
  // health, and must never be sent as one.
  const readSomething = report.coverage.some(
    (c) => c.status === "ok" || c.status === "empty",
  );

  if (report.status?.milOn) opening.push("⚠️ Check engine light ON");

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

  // Device-local time — the phone knows the driver's timezone, the server never did.
  const d = new Date(report.at);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

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
