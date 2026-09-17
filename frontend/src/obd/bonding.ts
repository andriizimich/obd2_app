// Getting Android to bond the adapter — the step that makes the PIN dialog
// appear at all.
//
// Nothing here touches the Bluetooth library. The decision this file makes
// (is the adapter bonded, and if it is not, did pairing finish?) is the one
// that decides whether the user ever sees a prompt, and it was the whole of a
// real failure: an unbonded adapter, no dialog, and a socket error that named
// nothing. Logic like that has to be provable with no adapter in the room, so
// it takes its clock, its sleep and its two questions about the world as
// arguments — the same shape the parsers use.

/** What {@link ensureBondedOver} concluded. */
export type BondState = "bonded" | "refused" | "unknown";

export type BondDeps = {
  /**
   * Whether Android has the address on its bonded list — or `null` when the
   * list cannot be read at all, which is a different answer from "no". A
   * missing `BLUETOOTH_CONNECT` grant and an unpaired adapter both leave the
   * adapter unusable, but only one of them is fixed by typing a PIN.
   */
  isBonded: (address: string) => Promise<boolean | null>;
  /**
   * Ask Android to bond. Fire-and-forget by contract: the library's promise
   * settles on `BOND_NONE` exactly as it does on `BOND_BONDED`, so it reports
   * a cancelled prompt as success (see `PairingReceiver`). It is observed
   * here only for the synchronous refusals — no adapter, API below 19, iOS —
   * which reject before any dialog is shown.
   */
  requestPair: (address: string) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * How long to keep asking. This is the ceiling on a manual PIN entry, not on
 * a dialog: the system prompt is modal, and someone reading `1234` off the
 * sticker on the adapter is the case that has to survive. Reaching it means
 * the prompt never appeared, or was dismissed.
 */
export const BOND_TIMEOUT_MS = 45_000;

/** Between two readings of the bonded list. */
export const BOND_POLL_MS = 500;

/**
 * Make sure Android has bonded the adapter, asking it to if it has not.
 *
 * The polling is not belt-and-braces — it is the only way to get an answer.
 * Awaiting `requestPair` cannot distinguish a completed pairing from a
 * cancelled one, so the bonded list is the verdict and the promise is only a
 * hint that the request was refused outright. Polling also survives the
 * library's receiver being torn down when the app pauses behind the system
 * dialog.
 */
export async function ensureBondedOver(
  address: string,
  deps: BondDeps,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BondState> {
  const already = await deps.isBonded(address);
  if (already === true) return "bonded";
  // An unreadable list means the permission or the adapter itself is in
  // question. Waiting out a dialog that may never appear would be worse than
  // letting the connect attempt say what actually happened.
  if (already === null) return "unknown";

  let rejected = false;
  void deps.requestPair(address).then(
    () => {},
    () => {
      rejected = true;
    },
  );

  const deadline = deps.now() + (opts.timeoutMs ?? BOND_TIMEOUT_MS);
  const pollMs = opts.pollMs ?? BOND_POLL_MS;
  while (deps.now() < deadline) {
    await deps.sleep(pollMs);
    if ((await deps.isBonded(address)) === true) return "bonded";
    if (rejected) return "refused";
  }
  return "refused";
}
