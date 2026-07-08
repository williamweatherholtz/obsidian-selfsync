import { describe, it, expect } from "vitest";
import { canLogIn, canFinish, statusTitle, isValidVaultName, WizardState } from "../src/wizardsteps";

const base: WizardState = {
  server: "", serverOk: false, mode: "login",
  username: "", password: "", loggedIn: false,
  vaults: [], chosenVault: "", newVault: "",
};

describe("canLogIn", () => {
  it("needs server + username + password", () => {
    expect(canLogIn(base)).toBe(false);
    expect(canLogIn({ ...base, server: "https://x", username: "u" })).toBe(false);
    expect(canLogIn({ ...base, server: "https://x", username: "u", password: "p" })).toBe(true);
  });
});

describe("canFinish", () => {
  it("needs a login and a chosen or new vault name", () => {
    expect(canFinish(base)).toBe(false);
    expect(canFinish({ ...base, loggedIn: true })).toBe(false);
    expect(canFinish({ ...base, loggedIn: true, chosenVault: "notes" })).toBe(true);
    expect(canFinish({ ...base, loggedIn: true, newVault: "  x " })).toBe(true);
    expect(canFinish({ ...base, chosenVault: "notes" })).toBe(false); // not logged in
  });
});

describe("isValidVaultName", () => {
  it("accepts safe names, rejects traversal/separators/empty/overlong", () => {
    expect(isValidVaultName("notes")).toBe(true);
    expect(isValidVaultName("my_vault-2.0")).toBe(true);
    expect(isValidVaultName("")).toBe(false);
    expect(isValidVaultName(".")).toBe(false);
    expect(isValidVaultName("..")).toBe(false);
    expect(isValidVaultName("a/b")).toBe(false);
    expect(isValidVaultName("has space")).toBe(false);
    expect(isValidVaultName("x".repeat(65))).toBe(false);
  });
});

describe("statusTitle", () => {
  it("maps each phase to its headline (identity lives under Connection, not here)", () => {
    expect(statusTitle("off")).toBe("Not connected");
    expect(statusTitle("connecting")).toBe("Connecting…");
    expect(statusTitle("syncing")).toBe("Syncing…");
    expect(statusTitle("idle")).toBe("Fully synced");
    expect(statusTitle("offline")).toBe("Offline — retrying");
  });
});
