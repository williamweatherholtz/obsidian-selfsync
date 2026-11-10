// The build-time control on the SELFSYNC_E2EE define (D0112, spec section 4.9). A true literal ships the
// E2EE entry points, so it is allowed only when the model holds an ACCEPTED Decision that depends on d0112
// (the KDF cost policy) and states the shipped cost in the literal form `m_kib=N, t=N, p=N`, equal to the
// createKeyring defaults in src/e2ee/kdf.ts. The esbuild config calls this on every build, so release.yml
// and verify-released.yml enforce it through `npm run build`; a vitest test asserts the same rule.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The KDF_DEFAULT cost from the kdf.ts source text: { m_kib, t, p }. */
export function parseKdfDefault(kdfSource) {
  const m = kdfSource.match(/KDF_DEFAULT\s*:\s*KdfCost\s*=\s*\{\s*m_kib:\s*(\d+),\s*t:\s*(\d+),\s*p:\s*(\d+)\s*\}/);
  if (!m) throw new Error("kdf.ts: KDF_DEFAULT not found in the expected literal form");
  return { m_kib: Number(m[1]), t: Number(m[2]), p: Number(m[3]) };
}

/**
 * Every accepted Decision in `text` that depends on d0112 and states a cost literal in ITS OWN decision
 * field. The match is scoped to the `part dNNNN : Decision { ... }` block that owns the DependsOn edge.
 * So a file with several parts cannot satisfy the rule by a sibling, and a rationale that quotes a
 * rejected cost does not count.
 */
export function acceptedKdfDecisions(text) {
  const out = [];
  const owners = [...text.matchAll(/#DependsOn\s+dependency\s+from\s+(\w+)\s+to\s+d0112\s*;/g)].map((m) => m[1]);
  for (const name of owners) {
    const block = text.match(new RegExp(`part\\s+${name}\\s*:\\s*Decision\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
    if (!block) continue;
    const body = block[1];
    if (!/status\s*=\s*DecisionStatus::accepted/.test(body)) continue;
    const field = body.match(/:>>\s*decision\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (!field) continue;
    for (const m of field[1].matchAll(/m_kib=(\d+),\s*t=(\d+),\s*p=(\d+)/g)) {
      out.push({ m_kib: Number(m[1]), t: Number(m[2]), p: Number(m[3]) });
    }
  }
  return out;
}

/**
 * The rule. `literal` is the committed define value. Returns { ok: true } or { ok: false, reason }.
 * A false literal is always fine (the entries are compiled out).
 */
export function checkE2eeDefine({ literal, decisionTexts, kdfSource }) {
  if (literal !== true) return { ok: true };
  const want = parseKdfDefault(kdfSource);
  for (const text of decisionTexts) {
    for (const d of acceptedKdfDecisions(text)) {
      if (d.m_kib === want.m_kib && d.t === want.t && d.p === want.p) return { ok: true };
    }
  }
  return { ok: false, reason: `SELFSYNC_E2EE is true but no accepted Decision that depends on d0112 states m_kib=${want.m_kib}, t=${want.t}, p=${want.p} (D0112: the shipped KDF default needs the owner's accepted Decision)` };
}

/** Read every decision file under `decisionsDir` as text. */
export function readDecisionTexts(decisionsDir) {
  const dir = typeof decisionsDir === "string" ? decisionsDir : fileURLToPath(decisionsDir);
  return readdirSync(dir).filter((f) => f.endsWith(".sysml")).map((f) => readFileSync(join(dir, f), "utf8"));
}
