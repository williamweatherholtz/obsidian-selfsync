import { describe, it, expect } from "vitest";
import { canAdvance, nextStep, statusTitle, WizardState } from "../src/wizardsteps";

const base: WizardState = {
  server: "", serverOk: false, mode: "login",
  username: "", password: "", loggedIn: false,
  vaults: [], chosenVault: "", newVault: "",
};

describe("canAdvance gating", () => {
  it("welcome always advances", () => expect(canAdvance("welcome", base)).toBe(true));
  it("server needs a passing connection test", () => {
    expect(canAdvance("server", base)).toBe(false);
    expect(canAdvance("server", { ...base, serverOk: true })).toBe(true);
  });
  it("account needs a successful login", () => {
    expect(canAdvance("account", { ...base, serverOk: true })).toBe(false);
    expect(canAdvance("account", { ...base, serverOk: true, loggedIn: true })).toBe(true);
  });
  it("vault needs a chosen or a new vault name", () => {
    expect(canAdvance("vault", base)).toBe(false);
    expect(canAdvance("vault", { ...base, chosenVault: "notes" })).toBe(true);
    expect(canAdvance("vault", { ...base, newVault: "  x " })).toBe(true);
  });
});

describe("nextStep", () => {
  it("welcome → server normally, → account when a setup link prefilled server+user", () => {
    expect(nextStep("welcome")).toBe("server");
    expect(nextStep("welcome", { haveLink: true })).toBe("account");
  });
  it("server → account → vault → done, done is terminal", () => {
    expect(nextStep("server")).toBe("account");
    expect(nextStep("account")).toBe("vault");
    expect(nextStep("vault")).toBe("done");
    expect(nextStep("done")).toBe("done");
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
