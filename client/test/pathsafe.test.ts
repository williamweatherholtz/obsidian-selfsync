import { describe, it, expect } from "vitest";
import { isSafeVaultPath } from "../src/pathsafe";

const NUL = String.fromCharCode(0);
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

describe("isSafeVaultPath — receive-side traversal guard (R23)", () => {
  it("accepts ordinary vault-relative paths", () => {
    for (const p of ["note.md", "folder/deep/img.png", ".obsidian/plugins/foo/main.js",
                     "a name (with) punctuation.md", "日本語/メモ.md", "emoji \u{1f600}.md"]) {
      expect(isSafeVaultPath(p)).toBe(true);
    }
  });

  it("rejects traversal, absolute, and smuggling paths a malicious server could send", () => {
    const bad = [
      "../secret.md",
      "../../../.config/autostart/x.desktop",
      ".obsidian/plugins/allowed/../obsidian-selfsync/main.js", // defeats the self-folder exclusion
      "a/../../b.md",
      "/etc/passwd",                 // absolute POSIX
      "C:\\Windows\\system32\\x",    // Windows drive + backslash
      "\\\\server\\share\\x",        // UNC
      "folder\\note.md",             // backslash separator
      "a//b.md",                     // empty segment
      "trailing/",                   // trailing slash -> empty segment
      "./rel.md",                    // single-dot segment
      "..",
      ".",
      "",
      "a/" + NUL + "/b.md",          // NUL byte
      "a" + NL + "b.md",             // newline (log-forge class)
      "a" + ESC + "[31m/b.md",       // ANSI escape
    ];
    for (const p of bad) {
      expect(isSafeVaultPath(p), `must reject: ${JSON.stringify(p)}`).toBe(false);
    }
  });

  it("rejects an absurdly long path", () => {
    expect(isSafeVaultPath("a/".repeat(600) + "x.md")).toBe(false);
  });
});
