// issue013 (D0047): the pre-commit guard that refuses a staged test whose module under test does not exist.
import { describe, it, expect } from "vitest";
import { missingImports } from "../../scripts/check-staged-test-imports.mjs";

describe("issue013 staged-test import guard", () => {
  it("names a relative import that resolves to no file, and accepts one that does", () => {
    const exists = (p: string) => p.replace(/\\/g, "/").endsWith("client/src/present.ts");
    const src = `import { a } from "../../src/present";\nimport { b } from "../../src/absent";\nimport { c } from "vitest";\n`;
    expect(missingImports("client/test/e2ee/x.test.ts", src, exists)).toEqual(["../../src/absent"]);
    expect(missingImports("client/test/e2ee/x.test.ts", `import { a } from "../../src/present";`, exists)).toEqual([]);
  });
});
