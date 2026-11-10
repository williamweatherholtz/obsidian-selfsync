import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkE2eeDefine, readDecisionTexts } from "./scripts/e2ee-define-check.mjs";

// SELFSYNC_E2EE (D0112, spec section 4.9): a COMMITTED literal, so a tag rebuilds byte-identical. false
// compiles the E2EE entry points out (create, join, Re-enrol); a pinned device syncs regardless. The
// commit that follows the owner's acceptance of the KDF default Decision flips it to true, and this
// script refuses a true literal with no such accepted Decision in the model (manual vigilance is not the
// control, D0047). release.yml and verify-released.yml run `npm run build`, so the publishing path enforces it.
const SELFSYNC_E2EE = false;

// A false literal needs no model: a client-only checkout or a tarball without .engine/ still builds.
if (SELFSYNC_E2EE) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const verdict = checkE2eeDefine({
    literal: SELFSYNC_E2EE,
    decisionTexts: readDecisionTexts(new URL("../.engine/decisions/", import.meta.url)),
    kdfSource: readFileSync(`${here}src/e2ee/kdf.ts`, "utf8"),
  });
  if (!verdict.ok) {
    console.error(`[selfsync build] ${verdict.reason}`);
    process.exit(1);
  }
}

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  platform: "browser",
  sourcemap: true,
  define: { SELFSYNC_E2EE: String(SELFSYNC_E2EE) },
});
