// E3a (10): the SELFSYNC_E2EE define. The committed literal in esbuild.config.mjs is false until the owner
// accepts the KDF default Decision; the build script refuses a true literal with no accepted Decision that
// depends on d0112 and states the cost in the literal form `m_kib=N, t=N, p=N` equal to KDF_DEFAULT. This
// test asserts the same rule the build runs, over fixtures and over the real decisions directory.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkE2eeDefine, parseKdfDefault, acceptedKdfDecisions, readDecisionTexts } from "../../scripts/e2ee-define-check.mjs";
import { e2eeBuildEnabled, setE2eeBuildEnabledForTests } from "../../src/e2ee/build";
import { KDF_DEFAULT } from "../../src/e2ee/kdf";

const kdfSource = readFileSync(fileURLToPath(new URL("../../src/e2ee/kdf.ts", import.meta.url)), "utf8");
const esbuildConfig = readFileSync(fileURLToPath(new URL("../../esbuild.config.mjs", import.meta.url)), "utf8");

const accepted = (cost: string, dep = "d0112") => `
    part d0999 : Decision {
        :>> status = DecisionStatus::accepted;
        :>> decision = "The shipped KDF default is ${cost} after the owner's phone measurements.";
    }
    #DependsOn dependency from d0999 to ${dep};
`;

describe("E3a (10) the define and its build-time control", () => {
  it("the committed literal is a literal, and false until the owner accepts the KDF default", () => {
    const m = esbuildConfig.match(/^const SELFSYNC_E2EE = (true|false);$/m);
    expect(m, "esbuild.config.mjs holds `const SELFSYNC_E2EE = <literal>;`").not.toBeNull();
    expect(esbuildConfig).toContain("define: { SELFSYNC_E2EE: String(SELFSYNC_E2EE) }");
    expect(esbuildConfig).toContain("checkE2eeDefine(");
  });

  it("parses KDF_DEFAULT from the source and matches the exported constant", () => {
    expect(parseKdfDefault(kdfSource)).toEqual(KDF_DEFAULT);
  });

  it("a false literal always passes; a true literal needs an accepted Decision on d0112 with the equal cost", () => {
    const want = `m_kib=${KDF_DEFAULT.m_kib}, t=${KDF_DEFAULT.t}, p=${KDF_DEFAULT.p}`;
    expect(checkE2eeDefine({ literal: false, decisionTexts: [], kdfSource }).ok).toBe(true);
    expect(checkE2eeDefine({ literal: true, decisionTexts: [], kdfSource }).ok).toBe(false);
    expect(checkE2eeDefine({ literal: true, decisionTexts: [accepted(want)], kdfSource }).ok).toBe(true);
    // a proposed Decision does not count
    expect(checkE2eeDefine({ literal: true, decisionTexts: [accepted(want).replace("accepted", "proposed")], kdfSource }).ok).toBe(false);
    // a different cost does not count
    const other = `m_kib=${KDF_DEFAULT.m_kib * 2}, t=${KDF_DEFAULT.t}, p=${KDF_DEFAULT.p}`;
    expect(checkE2eeDefine({ literal: true, decisionTexts: [accepted(other)], kdfSource }).ok).toBe(false);
    // a Decision that depends on something else does not count
    expect(checkE2eeDefine({ literal: true, decisionTexts: [accepted(want, "d0111")], kdfSource }).ok).toBe(false);
    expect(acceptedKdfDecisions(accepted(want))).toEqual([KDF_DEFAULT]);
    // the cost must sit in the decision field of the block that OWNS the edge: a sibling part in the same
    // file, or the rationale quoting a rejected cost, never counts
    const sibling = `
    part d0998 : Decision { :>> status = DecisionStatus::accepted; :>> decision = "we reject ${want}"; }
    part d0999 : Decision { :>> status = DecisionStatus::accepted; :>> decision = "no cost here"; :>> rationale = "not ${want}"; }
    #DependsOn dependency from d0999 to d0112;
`;
    expect(acceptedKdfDecisions(sibling)).toEqual([]);
    expect(checkE2eeDefine({ literal: true, decisionTexts: [sibling], kdfSource }).ok).toBe(false);
    const r = checkE2eeDefine({ literal: true, decisionTexts: [], kdfSource });
    expect(r.ok ? "" : r.reason).toContain("d0112");
  });

  it("today's model holds no accepted KDF default Decision, so a true literal would fail the build", () => {
    const texts = readDecisionTexts(fileURLToPath(new URL("../../../.engine/decisions/", import.meta.url)));
    expect(texts.length).toBeGreaterThan(10);
    expect(checkE2eeDefine({ literal: true, decisionTexts: texts, kdfSource }).ok).toBe(false);
    expect(checkE2eeDefine({ literal: false, decisionTexts: texts, kdfSource }).ok).toBe(true);
  });

  it("in tests the entries are on, and the override flips them for one scenario", () => {
    expect(e2eeBuildEnabled()).toBe(true);
    setE2eeBuildEnabledForTests(false);
    expect(e2eeBuildEnabled()).toBe(false);
    setE2eeBuildEnabledForTests(undefined);
    expect(e2eeBuildEnabled()).toBe(true);
  });
});
