// Pure ELM327 framing layer: accumulates raw bytes from any transport
// (BLE characteristic, serial port, …) and resolves complete AT-command
// responses. No transport dependencies — fully unit-testable with recorded
// or fabricated byte streams.

const DEFAULT_TIMEOUT_MS = 4000;
// Silence after the last complete line: a real ELM327 sends whole lines
// in quick succession, so a short gap means the response is complete even
// without the trailing ">" prompt (some clones print none).
//
// This is a gap *inside* an answer, never the wait *for* one — see
// `isInterimLine` and `command`.
const SETTLE_MS = 300;

/**
 * How long an abandoned command is given to finish talking before the next
 * one may be sent.
 *
 * A timed-out command has not stopped existing. The adapter is still working
 * on it, and its answer arrives after the caller has given up and moved on —
 * into a channel that by then has a *different* command pending. The lines
 * land on that command instead: its own reply is preceded by a stranger's
 * data, and a lone `>` from the abandoned answer ends it with nothing at all.
 *
 * That is not a rare shape. It is exactly what a session looks like when
 * every request resolves with no data and no error — `no readable reply` on
 * every read while the AT commands still answer — and it is permanent once
 * it happens, because each misread reply leaves the next command waiting for
 * an answer that has already been consumed. The channel's job is to make a
 * reply attach to the command that caused it, so it drains the abandoned
 * answer first.
 *
 * A drain that hears nothing runs the full window, so an adapter that has
 * genuinely gone quiet pays this much per timed-out command. A drain that
 * hears anything at all ends on the adapter's own prompt, which is the
 * adapter saying it is finished — so the wait is only ever long when there is
 * really something to wait for.
 */
const FLUSH_MS = 1000;

/**
 * The ceiling on a single drain.
 *
 * The quiet window is re-armed by every line, which is right for a slow answer
 * and wrong for an adapter that never stops talking: a drain that is extended
 * forever wedges every later command in `waitForFlush`, which — unlike a
 * command — has no timeout of its own. Past this, the channel stops listening
 * and takes its chances.
 */
const FLUSH_MAX_MS = 4000;

const HEX_TOKEN = /^[0-9a-f]{2}$/i;

/**
 * Lines the adapter prints while it is still working: the answer has not
 * started yet, and the gap before it can be seconds — an auto protocol search
 * alone takes several, and a KWP2000 init can print `BUS INIT: OK` long
 * before the ECU's first byte.
 *
 * `BUS INIT: ...ERROR` is deliberately not one of these: that is the adapter
 * giving up, and nothing follows it.
 */
function isInterimLine(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (t.startsWith("searching")) return true;
  return t.startsWith("bus init") && !t.includes("error");
}

/**
 * Pull every byte token out of raw ELM lines. Frame counters ("014"), the
 * `0:`/`1:` multi-line index prefixes and CAN headers all vanish here: the
 * counter and the header are not 2-hex tokens, and the index prefix is
 * consumed by the `[\s:]+` split. The result is still a flat byte soup —
 * callers must anchor on their own service byte rather than trust offsets.
 *
 * Lives here because both mode 09 and mode 01 readers need it, and mode 09
 * must be able to import mode 01 without a cycle.
 */
export function extractBytes(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const tokens = line.split(/[\s:]+/).filter((t) => HEX_TOKEN.test(t));
    for (const t of tokens) out.push(parseInt(t, 16));
  }
  return out;
}

type Pending = {
  /** Trimmed command text, used to detect and strip the echo line. */
  command: string;
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  lines: string[];
  /** Null until the adapter has started answering. */
  settle: ReturnType<typeof setTimeout> | null;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * One ELM327 channel over a byte stream. Feed decoded UTF-8 chunks into
 * {@link feed} and await {@link command} for complete response lines.
 *
 * Framing rules handled here:
 *  - lines end with \r (some clones send \n or \r\n — all accepted);
 *  - the first line of a response usually echoes the command (AT E1) —
 *    the echo is stripped;
 *  - a ">" line is the ELM327 prompt and ends multi-line replies;
 *  - an answer that stops mid-stream (no prompt, some clones print none)
 *    resolves after SETTLE_MS of silence — but only once it has started;
 *  - a command that is never answered rejects after `timeoutMs`, and whatever
 *    the adapter says afterwards is drained rather than handed to the command
 *    that follows it.
 */
export class Elm327Channel {
  private buffer = "";
  private pending: Pending | null = null;
  /** Set while an abandoned command's answer is still being drained. */
  private flushing: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock instant the current drain must be over by, however much the
   *  adapter still has to say. Set when the drain starts. */
  private flushDeadline = 0;
  /** One promise per drain, so several callers can park on it without the
   *  last one to arrive stealing the others' resolver. */
  private flushWait: Promise<void> | null = null;
  private flushDone: (() => void) | null = null;

  constructor(private readonly send: (raw: string) => void | Promise<void>) {}

  /** Issue an AT/ISO command and await its response lines (echo stripped). */
  async command(cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
    if (this.pending) throw new Error("ELM327: command already in flight");
    // Never write over a reply that is still arriving: it would be read as
    // this command's own. Only the drain needs waiting for — the common case
    // stays synchronous all the way to `this.pending = …` below, which is what
    // makes the guard above hold.
    if (this.flushing) {
      await this.waitForFlush();
      // Someone else may have claimed the channel while this one waited.
      if (this.pending) throw new Error("ELM327: command already in flight");
    }
    const raw = cmd.endsWith("\r") ? cmd : `${cmd}\r`;
    const promise = new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.clearPending();
        if (!pending) return;
        // A half-received line belongs to the command we just gave up on;
        // keeping it would glue its tail onto the next reply's first line.
        this.buffer = "";
        // And the answer is not necessarily over — the adapter may still be
        // working on the command we just abandoned. Drain it before anything
        // else is written (see FLUSH_MS).
        this.beginFlush();
        const partial = pending.lines;
        pending.reject(new Error(`ELM327: timeout waiting for "${cmd.trim()}"${partial.length ? ` (got: ${partial.join(" | ")})` : ""}`));
      }, timeoutMs);
      // No settle timer yet: it is armed by the answer itself (onLine), so
      // the wait for a reply is bounded by `timeoutMs` alone. Arming one here
      // would end every command that has not *started* answering within
      // SETTLE_MS — which is every request the ECU is slower than 300 ms to
      // answer, i.e. every request over a non-CAN bus, and the first request
      // of an auto protocol search. Those resolved with zero lines, which the
      // callers can only read as "the adapter said nothing".
      this.pending = { command: raw.trim(), resolve, reject, lines: [], settle: null, timeout };
    });
    try {
      await this.send(raw);
    } catch (err) {
      // A failed write must not leave the channel wedged. Without this the
      // in-flight slot stays occupied and every later command is refused
      // with "already in flight" — so one bad BLE write during a scan reads
      // as a dead adapter until the user reconnects.
      const failure = err instanceof Error ? err : new Error(String(err));
      this.clearPending()?.reject(failure);
    }
    return promise;
  }

  /** Feed a decoded UTF-8 chunk (may split lines arbitrarily). */
  feed(text: string): void {
    this.buffer += text;
    // Normalize \r\n and lone \n to \r, then process complete lines.
    //
    // The prompt is the third terminator, and it is not a line ending: the
    // adapter prints a bare `>` when it is done and puts nothing after it, so
    // `A5\r>` is a complete answer followed by a complete prompt, while
    // `A5\r>OK\r` is that same answer, that same prompt, and the next
    // command's reply already arriving. Splitting on \r alone leaves the `>`
    // in the buffer waiting for a \r that never comes, and the next bytes
    // then land behind it: `>A5`, `>OK`, `>7F 09 12` — lines the adapter
    // never sent. That is not a cosmetic difference. `ATDPN` answers `A5`,
    // the only line that names the protocol, and a parser handed `>A5` finds
    // no protocol at all; the same shift pushed a mode 09 reply one command
    // out of step, so each read was parsed against the previous one's
    // leftovers. A `>` is never data here — every reply is hex or ASCII, and
    // `>` is not a character a VIN may contain — so it can be cut out
    // wherever it appears.
    const normalized = this.buffer
      .replace(/\r\n/g, "\r")
      .replace(/\n/g, "\r")
      .replace(/>/g, "\r>\r");
    const last = normalized.lastIndexOf("\r");
    if (last === -1) {
      this.buffer = normalized;
      return;
    }
    const lines = normalized.slice(0, last).split("\r");
    this.buffer = normalized.slice(last + 1);
    for (const line of lines) this.onLine(line);
  }

  /** Cancel any in-flight command without rejecting it. */
  dispose(): void {
    this.clearPending();
    // A drain has no owner left once the transport is gone. Ending it lets a
    // caller parked in `waitForFlush` go rather than wait out the ceiling.
    if (this.flushing) this.endFlush();
  }

  /**
   * Begin — or extend — the drain of an abandoned command's answer. Called
   * when a command times out; from here on nothing that arrives belongs to
   * anybody.
   */
  private beginFlush(): void {
    const now = Date.now();
    if (this.flushing) {
      clearTimeout(this.flushing);
    } else {
      // First line of this drain: the ceiling starts counting from here, so a
      // clone that keeps talking cannot extend it indefinitely.
      this.flushDeadline = now + FLUSH_MAX_MS;
    }
    const wait = Math.min(FLUSH_MS, Math.max(0, this.flushDeadline - now));
    this.flushing = setTimeout(() => this.endFlush(), wait);
  }

  /** The adapter has stopped talking. Discard what it said and let the next
   *  command through. */
  private endFlush(): void {
    if (this.flushing) clearTimeout(this.flushing);
    this.flushing = null;
    // Whatever the abandoned answer left half-written belongs to it too.
    this.buffer = "";
    const done = this.flushDone;
    this.flushWait = null;
    this.flushDone = null;
    done?.();
  }

  private waitForFlush(): Promise<void> {
    if (!this.flushWait) {
      this.flushWait = new Promise<void>((resolve) => {
        this.flushDone = resolve;
      });
    }
    return this.flushWait;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // An abandoned command's answer is still arriving. Its lines answer a
    // question nobody is waiting for any more, and the one thing they can
    // still do is corrupt the next reply — so they are dropped, and the drain
    // is extended for as long as the adapter keeps talking.
    if (this.flushing) {
      if (trimmed === ">") {
        // The prompt is the adapter saying it is done, and nothing follows it.
        this.endFlush();
        return;
      }
      this.beginFlush();
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    // ELM327 prompt — response complete.
    if (trimmed === ">") {
      this.finish();
      return;
    }
    const isEcho =
      pending.lines.length === 0 &&
      trimmed.toLowerCase() === pending.command.toLowerCase();
    if (isEcho) return;
    pending.lines.push(trimmed);

    if (isInterimLine(trimmed)) {
      // Still working, not answering: disarm any gap timer and wait for the
      // reply, the prompt, or the timeout.
      if (pending.settle) clearTimeout(pending.settle);
      pending.settle = null;
      return;
    }

    // The answer has started. Wait a bit longer: more lines may follow.
    if (pending.settle) clearTimeout(pending.settle);
    pending.settle = setTimeout(() => this.finish(), SETTLE_MS);
  }

  private finish(): void {
    if (!this.pending) return;
    const { resolve, lines } = this.pending;
    this.clearPending();
    resolve(lines);
  }

  /** Drop the in-flight slot and hand it back, so a caller that means to
   *  settle it (rather than just abandon it) does not have to read the field
   *  again. */
  private clearPending(): Pending | null {
    if (!this.pending) return null;
    const pending = this.pending;
    if (pending.settle) clearTimeout(pending.settle);
    clearTimeout(pending.timeout);
    this.pending = null;
    return pending;
  }
}
