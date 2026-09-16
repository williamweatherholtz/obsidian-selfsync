// A CRASH-SURVIVING breadcrumb log.
//
// Why this exists: the in-memory log (main.ts `log()`) and console.debug are both lost the moment the host
// is force-killed, and a hang is exactly when the user cannot open devtools to read the console (owner
// report 2026-09-16: "the IDE totally hangs on failure so i can't pull logs from there"). A diagnosis needs
// the lines that were written BEFORE the freeze, on disk, after the process is gone.
//
// The shape that makes a hang readable is a PAIR: a line before a suspected-blocking operation and a line
// after it. A completed operation leaves `beg`/`end` with a duration; an operation that never returns leaves
// a `beg` with no `end` — and that dangling line names the culprit. Appends are small and ordered, and they
// are deliberately NOT batched: a buffer flushed on a timer loses precisely the last few hundred
// milliseconds, which is the only part that matters here.
//
// What it must never become: a cost of its own. Only PHASE-level events are logged (a pass, a write, a
// connect, a render) — never per keystroke or per file — so the volume is lines per second, against a
// data.json write that is megabytes.

export interface LogAdapter {
  append(path: string, data: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number } | null>;
  remove(path: string): Promise<void>;
}

export const FILE_LOG_MAX_BYTES = 1_000_000; // rotate at ~1 MB; one previous generation is kept

// Levels, so one log serves both jobs: a quiet record of what happened, or a dense trace for a live hunt.
// The threshold is a setting - info for normal use, trace when chasing something. Phase markers alone could
// not place the first two captured hangs (owner, 2026-09-16: "no real debugging?").
export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";
const RANK: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const TAG: Record<Exclude<LogLevel, "off">, string> = { error: "ERR", warn: "WRN", info: "INF", debug: "DBG", trace: "TRC" };

/** A SYNCHRONOUS appender (desktop: Node fs.appendFileSync). See the note in line() for why it matters. */
export type SyncAppend = (text: string) => void;

export class FileLog {
  // Appends are chained so lines can never interleave or land out of order, even though callers are
  // fire-and-forget (a breadcrumb must never make the caller await disk).
  private tail: Promise<void> = Promise.resolve();
  private bytes = 0;
  private seq = 0;
  private broken = false; // one failure disables the log rather than logging about logging, forever

  constructor(
    private readonly fs: LogAdapter,
    private readonly path: string,
    private level: LogLevel,
    // When present, every line is ALSO written synchronously, so a freeze in the same task cannot lose it.
    private readonly syncAppend?: SyncAppend,
  ) {}

  setLevel(level: LogLevel): void { this.level = level; }
  getLevel(): LogLevel { return this.level; }
  setEnabled(on: boolean): void { this.level = on ? "info" : "off"; }
  /** Await every queued append. Used by unload (so the last breadcrumbs reach disk) and by tests. */
  flush(): Promise<void> { return this.tail.catch(() => undefined); }
  isEnabled(): boolean { return this.level !== "off" && !this.broken; }
  private allows(level: Exclude<LogLevel, "off">): boolean { return !this.broken && RANK[level] <= RANK[this.level]; }

  error(msg: string): void { this.write("error", msg); }
  warn(msg: string): void { this.write("warn", msg); }
  info(msg: string): void { this.write("info", msg); }
  debug(msg: string): void { this.write("debug", msg); }
  trace(msg: string): void { this.write("trace", msg); }

  /** An info line - the name the rest of the plugin already calls. */
  line(msg: string): void { this.write("info", msg); }

  /** Fire-and-forget: ordered, never awaited by the caller. */
  private write(level: Exclude<LogLevel, "off">, msg: string): void {
    if (!this.allows(level)) return;
    const n = ++this.seq;
    const stamp = new Date().toISOString();
    const text = `${stamp} #${n} ${TAG[level]} ${msg}\n`;
    if (this.syncAppend) {
      // Synchronous path: on disk BEFORE this call returns, so a freeze in the very next statement still
      // leaves the line behind. This is the lesson of the first captured hang — the log ended mid-session
      // with no marker at all, because the async append was still queued when the thread stopped turning.
      try { this.syncAppend(text); return; } catch { /* fall through to the adapter */ }
    }
    this.tail = this.tail.then(() => this.appendChecked(text)).catch(() => { this.broken = true; });
  }

  /**
   * Mark the START of an operation; the returned function marks its END with a duration.
   * A hang leaves the `beg` line with no matching `end` — which is the whole point.
   */
  begin(op: string, detail = "", level: Exclude<LogLevel, "off"> = "debug"): (result?: string) => void {
    const id = ++this.seq;
    const t0 = Date.now();
    this.write(level, `beg ${op}${detail ? ` ${detail}` : ""} (id=${id})`);
    let ended = false;
    return (result = "ok") => {
      if (ended) return; // an op that reports twice must not corrupt the pairing
      ended = true;
      const ms = Date.now() - t0;
      // A SLOW operation is promoted to a WARNING: the interesting lines must not be invisible at info.
      this.write(ms >= 1_000 ? "warn" : level, `end ${op} ${result} ${ms}ms (id=${id})`);
    };
  }

  private async appendChecked(text: string): Promise<void> {
    if (this.bytes === 0) {
      // First write of the session: learn the current size so a long-lived file still rotates.
      const st = await this.fs.stat(this.path).catch(() => null);
      this.bytes = st?.size ?? 0;
    }
    if (this.bytes + text.length > FILE_LOG_MAX_BYTES) {
      // Keep exactly one previous generation: the hang we are chasing is recent, and an unbounded log in
      // the vault would be its own problem.
      const prev = `${this.path}.1`;
      if (await this.fs.exists(prev).catch(() => false)) await this.fs.remove(prev).catch(() => undefined);
      await this.fs.write(prev, "").catch(() => undefined); // touch, then move by copy-free rewrite below
      const rotated = await this.readAll();
      await this.fs.write(prev, rotated).catch(() => undefined);
      await this.fs.write(this.path, "").catch(() => undefined);
      this.bytes = 0;
    }
    await this.fs.append(this.path, text);
    this.bytes += text.length;
  }

  private async readAll(): Promise<string> {
    // Only used on rotation; the adapter's read is not in LogAdapter because nothing else needs it.
    const anyFs = this.fs as unknown as { read?: (p: string) => Promise<string> };
    return anyFs.read ? await anyFs.read(this.path).catch(() => "") : "";
  }
}
