import { describe, it, expect, afterEach } from "vitest";
import {
  identityKey, sameFile, identityGroups, identityIndex, pathViolation, setPathViolationHandler,
  PathIdentityError, PathViolation, describePathViolation, PathFs, EXACT_FS,
} from "../src/pathidentity";

// The three device families SelfSync runs on, by their filesystem's same-file rules.
const WINDOWS: PathFs = { caseInsensitive: true, normInsensitive: false };  // NTFS: case folds, NFC/NFD do not
const MACOS: PathFs = { caseInsensitive: true, normInsensitive: true };     // APFS/HFS+: both fold
const LINUX = EXACT_FS;                                                     // ext4, Android: nothing folds

const NFC = "Café.md".normalize("NFC");
const NFD = "Café.md".normalize("NFD");

afterEach(() => { setPathViolationHandler(null); });

describe("identityKey — one rule per filesystem family", () => {
  it("folds case where the filesystem does, and nowhere else", () => {
    expect(sameFile("Notes/A.md", "notes/a.md", WINDOWS)).toBe(true);
    expect(sameFile("Notes/A.md", "notes/a.md", MACOS)).toBe(true);
    expect(sameFile("Notes/A.md", "notes/a.md", LINUX)).toBe(false);
  });
  it("folds NFC vs NFD only where the filesystem does (macOS/iOS), NOT on Windows where both are real files", () => {
    expect(NFC).not.toBe(NFD); // the fixture really is two strings
    expect(sameFile(NFC, NFD, MACOS)).toBe(true);
    expect(sameFile(NFC, NFD, WINDOWS)).toBe(false);
    expect(sameFile(NFC, NFD, LINUX)).toBe(false);
  });
  it("folds a decomposed capital the same way as a composed one", () => {
    expect(identityKey("CAFÉ.md".normalize("NFD"), MACOS)).toBe(identityKey("café.md".normalize("NFC"), MACOS));
  });
  it("identityIndex keeps the FIRST spelling seen for a file", () => {
    expect(identityIndex(["Note.md", "note.md"], WINDOWS).get(identityKey("NOTE.md", WINDOWS))).toBe("Note.md");
  });
});

describe("identityGroups — spellings that are one file here", () => {
  it("finds a case pair on Windows and an NFC/NFD pair only on macOS", () => {
    expect(identityGroups(["a.md", "A.md", "b.md"], WINDOWS)).toEqual([["a.md", "A.md"]]);
    expect(identityGroups([NFC, NFD], WINDOWS)).toEqual([]);
    expect(identityGroups([NFC, NFD], MACOS)).toEqual([[NFC, NFD]]);
  });
  it("is empty on an exact filesystem and when every key is its own file", () => {
    expect(identityGroups(["a.md", "A.md"], LINUX)).toEqual([]);
    expect(identityGroups(["a.md", "b.md"], MACOS)).toEqual([]);
  });
  it("does not report the same exact spelling twice as a pair", () => {
    expect(identityGroups(["a.md", "a.md"], WINDOWS)).toEqual([]);
  });
});

describe("pathViolation — fail early, fail loud", () => {
  const v: PathViolation = { kind: "duplicate-identity", site: "test/site", paths: ["a.md", "A.md"], detail: "why" };

  it("THROWS by default, so a violation fails the test (or the caller) at the site", () => {
    expect(() => pathViolation(v)).toThrow(PathIdentityError);
    try { pathViolation(v); } catch (e) { expect((e as PathIdentityError).violation).toEqual(v); }
  });
  it("the message names the kind, the site and every spelling", () => {
    const msg = describePathViolation(v);
    for (const part of ["duplicate-identity", "test/site", "'a.md'", "'A.md'", "why"]) expect(msg).toContain(part);
  });
  it("an installed handler receives it instead, and restoring (null) brings the throw back", () => {
    const got: PathViolation[] = [];
    const prev = setPathViolationHandler((x) => got.push(x));
    pathViolation(v);
    expect(got).toEqual([v]);
    setPathViolationHandler(null);
    expect(() => pathViolation(v)).toThrow(PathIdentityError);
    expect(typeof prev).toBe("function");
  });
});
