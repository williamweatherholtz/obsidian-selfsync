import { describe, it, expect } from "vitest";
import { validateFileMeta, validateChanges } from "../src/protocol";

// PROTO-3: the transport must REJECT a malformed server response before it reaches
// reconcile, so a hostile/buggy server can't drive spurious deletes or a corrupt rebuild.
describe("response-shape validation (PROTO-3)", () => {
  const goodMeta = { path: "a.md", hash: "h", size: 3, mtime: 1, version: 5, chunks: ["c1", "c2"] };

  it("accepts a well-formed FileMeta and returns a fresh validated value (construct, not cast)", () => {
    expect(validateFileMeta(goodMeta)).toEqual(goodMeta); // equal by value...
    // ...and CONSTRUCTED (parse-don't-validate): the result carries only the validated fields, so an
    // extra/hostile property on the wire object can't ride along into trusted state.
    expect(validateFileMeta({ ...goodMeta, evil: "x" })).not.toHaveProperty("evil");
  });

  it("rejects a FileMeta whose chunks are not string[]", () => {
    expect(() => validateFileMeta({ ...goodMeta, chunks: [1, 2] })).toThrow(/chunks/);
    expect(() => validateFileMeta({ ...goodMeta, chunks: "c1" })).toThrow(/chunks/);
  });

  it("rejects a FileMeta missing required scalar fields", () => {
    expect(() => validateFileMeta({ ...goodMeta, hash: undefined })).toThrow(/hash/);
    expect(() => validateFileMeta({ ...goodMeta, version: "5" })).toThrow(/version/);
    expect(() => validateFileMeta(null)).toThrow();
  });

  // issueValidateFileMetaMtimeUnchecked: mtime is part of the FileMeta contract (flows into base
  // stat-stamping) but was never validated — a hostile server could send a non-numeric mtime that the
  // returned type falsely asserted. It must be rejected like every other numeric field.
  it("rejects a FileMeta whose mtime is not a non-negative integer", () => {
    expect(() => validateFileMeta({ ...goodMeta, mtime: "evil" })).toThrow(/mtime/);
    expect(() => validateFileMeta({ ...goodMeta, mtime: NaN })).toThrow(/mtime/);
    expect(() => validateFileMeta({ ...goodMeta, mtime: 1.5 })).toThrow(/mtime/);
    const { mtime, ...noMtime } = goodMeta; void mtime;
    expect(() => validateFileMeta(noMtime)).toThrow(/mtime/);
  });

  it("accepts a well-formed ChangesResponse", () => {
    const c = { version: 7, upserts: [goodMeta], deletes: [{ path: "b.md", version: 6 }] };
    expect(validateChanges(c)).toBe(c);
  });

  it("rejects a ChangesResponse whose upserts/deletes are not arrays", () => {
    expect(() => validateChanges({ version: 1, upserts: {}, deletes: [] })).toThrow(/arrays/);
    expect(() => validateChanges({ version: 1, upserts: [], deletes: null })).toThrow(/arrays/);
  });

  it("rejects a ChangesResponse containing a malformed upsert or delete", () => {
    expect(() => validateChanges({ version: 1, upserts: [{ ...goodMeta, chunks: [1] }], deletes: [] })).toThrow(/chunks/);
    expect(() => validateChanges({ version: 1, upserts: [], deletes: [{ path: "b.md" }] })).toThrow(/delete\.version/);
  });

  it("type-checks the optional history_floor field (R23): accepts absent/number, rejects a non-number", () => {
    expect(validateChanges({ version: 1, upserts: [], deletes: [] })).toBeTruthy();                       // absent OK
    expect(validateChanges({ version: 1, upserts: [], deletes: [], history_floor: 3 })).toBeTruthy();     // number OK
    expect(() => validateChanges({ version: 1, upserts: [], deletes: [], history_floor: "999" })).toThrow(/history_floor/);
  });
});
