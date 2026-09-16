import { describe, it, expect } from "vitest";
import { FileLog, FILE_LOG_MAX_BYTES, type LogAdapter } from "../src/filelog";

// The breadcrumb log exists for ONE job: after the host is force-killed, the file must still say what was
// happening (owner report 2026-09-16 — "the IDE totally hangs on failure so i can't pull logs from there").
// So the properties that matter are: lines land in order, an operation that never returns leaves a dangling
// `beg`, the file cannot grow without bound, and a broken adapter can never throw into the caller.

function memFs() {
  const files = new Map<string, string>();
  const fs: LogAdapter & { read: (p: string) => Promise<string>; files: Map<string, string> } = {
    files,
    async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
    async write(p, d) { files.set(p, d); },
    async exists(p) { return files.has(p); },
    async stat(p) { const v = files.get(p); return v === undefined ? null : { size: v.length }; },
    async remove(p) { files.delete(p); },
    async read(p) { return files.get(p) ?? ""; },
  };
  return fs;
}

// Drain the append chain deterministically rather than guessing a tick count.
let current: FileLog;
const settle = () => current.flush();
const LOG = "plugins/selfsync/selfsync-debug.log";

describe("FileLog — the record that outlives the process", () => {
  it("writes lines IN ORDER even though callers never await", async () => {
    const fs = memFs();
    const log = current = new FileLog(fs, LOG, true);
    log.line("first"); log.line("second"); log.line("third");
    await settle();
    const lines = fs.files.get(LOG)!.trim().split("\n");
    expect(lines.map((l) => l.split(" ").slice(2).join(" "))).toEqual(["first", "second", "third"]);
    expect(lines.map((l) => l.split(" ")[1])).toEqual(["#1", "#2", "#3"]); // monotonic, so a gap is visible
  });

  // THE load-bearing property: a hang leaves the pair OPEN, and the dangling line names the culprit.
  it("an operation that never finishes leaves a beg with NO end", async () => {
    const fs = memFs();
    const log = current = new FileLog(fs, LOG, true);
    log.begin("persist", "entries=2000 bytes=10500000"); // never called back — this is the hang
    const done = log.begin("connect");
    done();
    await settle();
    const text = fs.files.get(LOG)!;
    expect(text).toContain("beg persist entries=2000 bytes=10500000");
    expect(text).not.toMatch(/end persist/);   // the smoking gun
    expect(text).toContain("beg connect");
    expect(text).toMatch(/end connect ok \d+ms/); // a completed op reports its duration
  });

  it("a finished operation reports its duration and cannot double-report", async () => {
    const fs = memFs();
    const log = current = new FileLog(fs, LOG, true);
    const done = log.begin("reconcileAll");
    done("full v7");
    done("full v7"); // a second call must not emit a second end (pairing would be corrupted)
    await settle();
    expect(fs.files.get(LOG)!.match(/end reconcileAll/g)).toHaveLength(1);
  });

  it("rotates at the cap, keeping exactly one previous generation", async () => {
    const fs = memFs();
    const log = current = new FileLog(fs, LOG, true);
    fs.files.set(LOG, "x".repeat(FILE_LOG_MAX_BYTES - 10)); // nearly full already
    log.line("this one tips it over");
    await settle();
    expect(fs.files.get(`${LOG}.1`)).toContain("x");                 // the old content was preserved…
    expect(fs.files.get(LOG)!).toContain("this one tips it over");   // …and the new file starts fresh
    expect(fs.files.get(LOG)!.length).toBeLessThan(FILE_LOG_MAX_BYTES);
  });

  it("a failing adapter never throws into the caller, and stops trying", async () => {
    const fs = memFs();
    fs.append = async () => { throw new Error("disk full"); };
    const log = current = new FileLog(fs, LOG, true);
    expect(() => log.line("boom")).not.toThrow();
    await settle();
    expect(log.isEnabled()).toBe(false); // disabled itself rather than logging about logging forever
  });

  it("writes nothing at all when disabled", async () => {
    const fs = memFs();
    const log = current = new FileLog(fs, LOG, false);
    log.line("nope"); log.begin("persist")();
    await settle();
    expect(fs.files.size).toBe(0);
  });
});
