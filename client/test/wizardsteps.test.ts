import { describe, it, expect } from "vitest";
import { canLogIn, canFinish, statusTitle, isValidVaultName, sanitizeVaultName, wizardCredentials, WizardState } from "../src/wizardsteps";

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
  // Regression: uppercase must be REJECTED so isValidVaultName matches the server's lowercase-only
  // safe_name rule — a name that passes here must never 400 server-side.
  it("rejects uppercase (server safe_name is lowercase-only)", () => {
    expect(isValidVaultName("Testbrsin")).toBe(false);
    expect(isValidVaultName("Notes")).toBe(false);
  });
});

describe("sanitizeVaultName", () => {
  it("trims and lowercases so uppercase input becomes a valid name", () => {
    expect(sanitizeVaultName("  Testbrsin ")).toBe("testbrsin");
    expect(sanitizeVaultName("MyVault")).toBe("myvault");
    // sanitize → validate is the real pipeline: what the user typed now passes.
    expect(isValidVaultName(sanitizeVaultName("Testbrsin"))).toBe(true);
  });
});

describe("wizardCredentials (P1: token-only-at-rest)", () => {
  const loggedIn: WizardState = { ...base, server: "https://s", username: "u", password: "secret", loggedIn: true };
  it("does NOT persist the plaintext password by default (token-only)", () => {
    const c = wizardCredentials(loggedIn, "notes", "tok-123", false);
    expect(c.password).toBe("");            // the fix: never written unless opted in
    expect(c.authToken).toBe("tok-123");    // the session token is what's kept
    expect(c).toMatchObject({ serverUrl: "https://s", username: "u", vaultId: "notes" });
  });
  it("persists the password only when the user opted into storing it", () => {
    expect(wizardCredentials(loggedIn, "notes", "tok-123", true).password).toBe("secret");
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
