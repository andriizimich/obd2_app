/**
 * Thousands separators, without `Intl`.
 *
 * Hermes ships different Intl builds on different platforms, and a locale
 * that renders `1,5,0,0,0` is worse than a hand-rolled loop. Whole numbers
 * only — every caller here is a kilometre count.
 */
export function groupDigits(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += " ";
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}
