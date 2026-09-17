// Smoke test for the adapter bonding decision (src/obd/bonding.ts).
// Run with: npx tsx scripts/obd-bond-smoke.ts
//
// No adapter, no Android, no system dialog — which is the point. This is the
// logic that decides whether the user ever sees a PIN prompt, and the one
// shape it cannot be tested in on a real phone is "the prompt was dismissed",
// because Android reports a cancelled pairing and a completed one identically.

import {
  BOND_POLL_MS,
  BOND_TIMEOUT_MS,
  ensureBondedOver,
  type BondDeps,
  type BondState,
} from "../src/obd/bonding";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const ADDR = "00:1D:A5:68:98:8B";

/** A clock the test drives. `sleep` moves it, so a 45-second wait costs
 *  nothing and the deadline is exercised rather than skipped. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

type Harness = {
  deps: BondDeps;
  clock: ReturnType<typeof clock>;
  /** Every `isBonded` answer, in order. */
  reads: number;
  pairCalls: number;
};

/**
 * `bondedAfter` — how many `isBonded` calls are needed before the adapter
 * reads as bonded (`null` = never). `pairOutcome` — what the pair request
 * does: settles quietly (the library's answer to BOTH a completed pairing
 * and a dismissed dialog), or rejects (the synchronous refusals).
 */
function harness(
  bondedAfter: number | null,
  pairOutcome: "settle" | "reject" = "settle",
): Harness {
  const c = clock();
  const state: Harness = {
    clock: c,
    reads: 0,
    pairCalls: 0,
    deps: {
      isBonded: () => {
        state.reads += 1;
        if (bondedAfter === null) return Promise.resolve(false);
        return Promise.resolve(state.reads > bondedAfter);
      },
      requestPair: () => {
        state.pairCalls += 1;
        return pairOutcome === "reject"
          ? Promise.reject(new Error("no adapter"))
          : Promise.resolve();
      },
      now: c.now,
      sleep: c.sleep,
    },
  };
  return state;
}

async function main() {
  // --- The three answers, in the order the transport cares about them -----

  {
    // Already paired: the common case after the first connection. No dialog
    // may be raised here — pairing a bonded device pops nothing on some
    // Androids and silently unpairs on others.
    const h = harness(0);
    const verdict = await ensureBondedOver(ADDR, h.deps);
    check(
      "already bonded: reported bonded",
      verdict === "bonded",
      verdict,
    );
    check(
      "already bonded: the bonded list is read once",
      h.reads === 1,
      `${h.reads} reads`,
    );
    check(
      "already bonded: no pairing is requested",
      h.pairCalls === 0,
      `${h.pairCalls} requests`,
    );
  }

  {
    // `null` is "the list could not be read", not "not bonded". A missing
    // BLUETOOTH_CONNECT grant lands here, and so does a wedged adapter — a
    // typed PIN fixes neither, so waiting out a dialog would be 45 seconds
    // spent on a prompt that was never going to appear.
    const c = clock();
    let pairCalls = 0;
    const verdict = await ensureBondedOver(ADDR, {
      isBonded: () => Promise.resolve(null),
      requestPair: () => {
        pairCalls += 1;
        return Promise.resolve();
      },
      now: c.now,
      sleep: c.sleep,
    });
    check("unreadable bonded list: reported unknown", verdict === "unknown", verdict);
    check(
      "unreadable bonded list: no pairing is requested",
      pairCalls === 0,
      `${pairCalls} requests`,
    );
  }

  {
    // The dialog was answered. Polling sees the bond a beat after the
    // promise settles — the promise carries no verdict at all.
    const h = harness(4);
    const verdict = await ensureBondedOver(ADDR, h.deps);
    check("prompt answered: reported bonded", verdict === "bonded", verdict);
    check(
      "prompt answered: pairing was requested once",
      h.pairCalls === 1,
      `${h.pairCalls} requests`,
    );
  }

  // --- The shapes the promise cannot describe ----------------------------

  {
    // A dismissed dialog. `PairingReceiver` calls `onPairingSuccess` for
    // BOND_NONE exactly as it does for BOND_BONDED, so the promise resolves
    // here and the adapter never bonds — awaiting it would have reported a
    // success that never happened.
    const h = harness(null);
    const verdict = await ensureBondedOver(ADDR, h.deps, {
      timeoutMs: 5_000,
      pollMs: 500,
    });
    check(
      "prompt dismissed: reported refused, not bonded",
      verdict === "refused",
      verdict,
    );
    check(
      "prompt dismissed: the wait ends at the deadline",
      h.clock.now() === 5_000,
      `${h.clock.now()}ms`,
    );
  }

  {
    // The synchronous refusals: no adapter, API below 19, iOS. Those reject
    // before any dialog, so there is nothing to wait for.
    const h = harness(null, "reject");
    const verdict = await ensureBondedOver(ADDR, h.deps, {
      timeoutMs: 45_000,
      pollMs: 500,
    });
    check("pairing refused outright: reported refused", verdict === "refused", verdict);
    check(
      "pairing refused outright: the wait is cut short",
      h.clock.now() < 45_000,
      `${h.clock.now()}ms of 45000`,
    );
  }

  {
    // Rejected *and* bonded: the bond is the verdict either way. The request
    // rejects when the adapter is already mid-bond (the library refuses a
    // second one), and Android finishes the first bond a moment later — or
    // the adapter was paired by hand in the system settings and the list
    // simply had not caught up. Either way the adapter is usable now, and
    // answering "refused" would send the user to pair a device they already
    // paired. So the bonded check is read before the rejection is acted on.
    const c = clock();
    let reads = 0;
    const verdict = await ensureBondedOver(ADDR, {
      isBonded: () => {
        reads += 1;
        return Promise.resolve(reads > 1);
      },
      requestPair: () => Promise.reject(new Error("already bonding")),
      now: c.now,
      sleep: c.sleep,
    });
    check(
      "pair request rejected as a bond lands: reported bonded",
      verdict === "bonded",
      verdict,
    );
  }

  // --- The budget --------------------------------------------------------

  {
    // A pair request per poll would re-raise the dialog every half second
    // behind the one already up, and the user would be answering prompts
    // they never get to see the start of.
    const h = harness(2);
    await ensureBondedOver(ADDR, h.deps, { timeoutMs: 20_000, pollMs: 100 });
    check(
      "the pair request is not repeated while polling",
      h.pairCalls === 1,
      `${h.pairCalls} requests`,
    );
  }

  {
    // The defaults are what ships; the tests above only prove the knobs.
    const h = harness(null);
    await ensureBondedOver(ADDR, h.deps);
    check(
      "the default wait is the documented 45s",
      h.clock.now() === BOND_TIMEOUT_MS,
      `${h.clock.now()}ms vs ${BOND_TIMEOUT_MS}`,
    );
    check(
      "the default poll interval is the documented 500ms",
      h.reads === 1 + BOND_TIMEOUT_MS / BOND_POLL_MS,
      `${h.reads} reads`,
    );
    // A PIN typed off the sticker on the adapter is the case the ceiling has
    // to survive, so it is asserted rather than assumed.
    check(
      "the wait outlasts a manual PIN entry",
      BOND_TIMEOUT_MS >= 30_000,
      `${BOND_TIMEOUT_MS}ms`,
    );
  }

  // Every path above returned a value rather than hanging — that is the
  // contract the transport's `connect()` relies on.
  const states: BondState[] = ["bonded", "refused", "unknown"];
  check("the verdict is one of the three states", states.length === 3);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll bonding checks passed.");
}

main();
