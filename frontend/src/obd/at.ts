// Pure ELM327 framing layer: accumulates raw bytes from any transport
// (BLE characteristic, serial port, …) and resolves complete AT-command
// responses. No transport dependencies — fully unit-testable with recorded
// or fabricated byte streams.

const DEFAULT_TIMEOUT_MS = 4000;
// Silence after the last complete line: a real ELM327 sends whole lines
// in quick succession, so a short gap means the response is complete even
// without the trailing ">" prompt (single-line replies like ATI have none).
const SETTLE_MS = 300;

type Pending = {
  /** Trimmed command text, used to detect and strip the echo line. */
  command: string;
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  lines: string[];
  settle: ReturnType<typeof setTimeout>;
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
 *  - responses also resolve after SETTLE_MS of silence.
 */
export class Elm327Channel {
  private buffer = "";
  private pending: Pending | null = null;

  constructor(private readonly send: (raw: string) => void | Promise<void>) {}

  /** Issue an AT/ISO command and await its response lines (echo stripped). */
  async command(cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
    if (this.pending) throw new Error("ELM327: command already in flight");
    const raw = cmd.endsWith("\r") ? cmd : `${cmd}\r`;
    const promise = new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending) {
          const partial = this.pending.lines;
          this.pending = null;
          reject(new Error(`ELM327: timeout waiting for "${cmd.trim()}"${partial.length ? ` (got: ${partial.join(" | ")})` : ""}`));
        }
      }, timeoutMs);
      const settle = setTimeout(() => this.finish(), SETTLE_MS);
      this.pending = { command: raw.trim(), resolve, reject, lines: [], settle, timeout };
    });
    await this.send(raw);
    return promise;
  }

  /** Feed a decoded UTF-8 chunk (may split lines arbitrarily). */
  feed(text: string): void {
    this.buffer += text;
    // Normalize \r\n and lone \n to \r, then process complete lines.
    const normalized = this.buffer.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
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
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !this.pending) return;
    // ELM327 prompt — response complete.
    if (trimmed === ">") {
      this.finish();
      return;
    }
    const cmd = this.pending.command;
    const isEcho =
      this.pending.lines.length === 0 &&
      trimmed.toLowerCase() === cmd.toLowerCase();
    if (!isEcho) this.pending.lines.push(trimmed);
    // Wait a bit longer: more lines may follow.
    clearTimeout(this.pending.settle);
    this.pending.settle = setTimeout(() => this.finish(), SETTLE_MS);
  }

  private finish(): void {
    if (!this.pending) return;
    const { resolve, lines } = this.pending;
    this.clearPending();
    resolve(lines);
  }

  private clearPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.settle);
    clearTimeout(this.pending.timeout);
    this.pending = null;
  }
}
