/**
 * Which build produced what you are looking at.
 *
 * "The new APK is installed" and "the new APK is running" are two different
 * facts, and a screenshot cannot tell them apart: the app looks the same
 * either way, and Android will happily keep an older file from Downloads.
 * That ambiguity cost a full test round — a fix that was proven correct on
 * the recorded bytes appeared not to work, because the phone was still
 * running the build from before it.
 *
 * Printed on the connect screen. It used to close the Telegram message, back
 * when the message was a document; the message is three lines now and the
 * stamp is not one of them, so it sits where it is read before anything is
 * plugged in and lands in every screenshot of the app by itself.
 *
 * Bump this by hand in the same change that produces a build worth testing;
 * a stamp that lies is worse than no stamp at all.
 */
export const BUILD_STAMP = "2026-09-21.3";
