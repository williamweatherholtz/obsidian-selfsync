// E3a (7), D0047: a correction becomes a guard. Every content identity goes through the codec, so no module
// outside the allowlist may import sha256hex: chunker.ts defines it, frontmatter.ts and streamhash.ts hash
// plaintext on both sides on purpose, the codec wraps it, and main.ts keeps ONE call for the main.js build
// fingerprint. A new import anywhere else fails here, by file.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const ALLOWED_IMPORTERS = new Set(["frontmatter.ts", "e2ee/codec.ts", "main.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("E3a (7) sha256hex stays behind the codec", () => {
  it("only the allowlisted modules import sha256hex, and main.ts calls it once (the build fingerprint)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      const text = readFileSync(file, "utf8");
      const imports = /import\s*\{[^}]*\bsha256hex\b[^}]*\}\s*from/.test(text);
      if (rel === "chunker.ts") { expect(text).toMatch(/export (async )?function sha256hex/); continue; }
      if (imports && !ALLOWED_IMPORTERS.has(rel)) offenders.push(rel);
      if (rel === "main.ts") {
        const calls = text.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("import")).filter((l) => l.includes("sha256hex(")).length;
        expect(calls, "main.ts: exactly one sha256hex call, the main.js build fingerprint").toBe(1);
      }
      if (rel === "reconcile.ts" || rel === "sync.ts") expect(imports, `${rel} must not import sha256hex`).toBe(false);
    }
    expect(offenders).toEqual([]);
  });
});
