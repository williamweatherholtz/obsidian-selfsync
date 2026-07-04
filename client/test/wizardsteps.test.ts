import { describe, it, expect } from "vitest";
import { canAdvance, nextStep, statusLine, WizardState } from "../src/wizardsteps";

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

describe("statusLine", () => {
  it("unconfigured (no user/vault) → Not set up regardless of phase", () => {
    expect(statusLine("idle", {})).toEqual({ title: "Not set up", detail: "Sync your notes to your own server." });
  });
  it("phase → title, with who + optional last-synced label", () => {
    const who = { user: "will", vault: "notes" };
    expect(statusLine("connecting", who).title).toBe("Connecting…");
    expect(statusLine("syncing", who).title).toBe("Syncing…");
    expect(statusLine("offline", who).title).toBe("Offline — retrying");
    const idle = statusLine("idle", { ...who, lastSyncedLabel: "Last synced 2m ago" });
    expect(idle.title).toBe("Fully synced");
    expect(idle.detail).toContain("will");
    expect(idle.detail).toContain("notes");
    expect(idle.detail).toContain("Last synced 2m ago");
  });
  it("configured but off → Not set up (signed out)", () => {
    expect(statusLine("off", { user: "will", vault: "notes" }).title).toBe("Not set up");
  });
});
