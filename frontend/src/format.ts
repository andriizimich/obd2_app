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

/** What to call an adapter on screen when its advertised name is not text.
 *
 *  Cheap clones broadcast names that are not valid UTF-8 — the decoder turns
 *  the stray bytes into replacement characters, and the device pill on the
 *  main screen then reads `oCfm◆◆◆`. Printing the replacement characters
 *  reports a decoding failure as if it were the adapter's name.
 *
 *  Only characters that cannot be part of a name are dropped: letters,
 *  digits, spaces and ordinary punctuation stay, so a genuinely odd name is
 *  still shown as the adapter spells it. A name that is nothing but junk
 *  falls back to the generic label rather than to an empty pill.
 */
export function deviceLabel(name: string | null | undefined): string {
  const fallback = "OBD-II adapter";
  if (!name) return fallback;
  // U+FFFD (the decoder's "I could not read this byte"), control characters
  // and the object-replacement glyph some clones send.
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F\uFFFC\uFFFD]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}
