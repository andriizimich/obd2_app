/**
 * Which build produced a report.
 *
 * "The new APK is installed" and "the new APK is running" are two different
 * facts, and a screenshot cannot tell them apart: the app looks the same
 * either way, and Android will happily keep an older file from Downloads.
 * That ambiguity cost a full test round — a fix that was proven correct on
 * the recorded bytes appeared not to work, because the phone was still
 * running the build from before it.
 *
 * So every report carries the stamp, and the Telegram message ends with it.
 * Bump this by hand in the same change that produces a build worth testing;
 * a stamp that lies is worse than no stamp at all.
 */
export const BUILD_STAMP = "2026-09-20.2";
