import { describe, it, expect } from "vitest";
import { validateFileMeta, validateChanges } from "../src/protocol";

// PROTO-3: the transport must REJECT a malformed server response before it reaches
// reconcile, so a hostile/buggy server can't drive spurious deletes or a corrupt rebuild.
describe("response-shape validation (PROTO-3)", () => {
  const goodMeta = { path: "a.md", hash: "h", size: 3, mtime: 1, version: 5, chunks: ["c1", "c2"] };

  it("accepts a well-formed FileMeta and returns it", () => {
    expect(validateFileMeta(goodMeta)).toBe(goodMeta);
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
});
