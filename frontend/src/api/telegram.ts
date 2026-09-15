import type { Fault, Vehicle } from "@/src/obd/types";

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

export function reportText(vehicle: Vehicle, faults: Fault[]): string {
  const vin = escapeHtml(`${vehicle.make} — ${vehicle.vin}`);
  const dtc = escapeHtml(faults.map((f) => f.code).join(", ")) || "No errors";
  // Device-local time — the phone knows the driver's timezone, the server never did.
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `🚗 OBD\nVIN: ${vin}\nDTC: ${dtc}\nDate: ${ts}`;
}

export async function sendReport(
  vehicle: Vehicle,
  faults: Fault[],
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
        text: reportText(vehicle, faults),
        parse_mode: "HTML",
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage failed: ${res.status} ${body}`);
  }
}
