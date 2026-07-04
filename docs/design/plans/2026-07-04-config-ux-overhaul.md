# SelfSync Config-UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SelfSync's ad-hoc settings with a status-first settings tab + a guided setup wizard + a device-bootstrap connection link, following the approved spec `docs/design/specs/2026-07-04-config-ux-overhaul.md`.

**Architecture:** Client-only (no server changes). All decision logic lives in two pure, unit-tested modules (`connstr.ts`, `wizardsteps.ts`); the `SetupWizardModal` and the restructured settings tab are thin Obsidian-DOM renderers over that logic + the existing `HttpTransport` + the `syncstate` FSM. One persisted `settings` object is the single source of truth.

**Tech Stack:** TypeScript, esbuild, vitest, Obsidian plugin API (`Modal`, `Setting`, `PluginSettingTab`), `requestUrl` transport.

## Global Constraints

- **Client-only.** No files under `server/` change. Endpoints used already exist: `POST /api/login`, `POST /api/register`, `GET /api/vaults`, `POST /api/vaults`, `GET /api/v/:vault/status`, `GET /health`.
- **Never sync SelfSync's own config** — unchanged M6 rule; do not touch `configsync.ts` semantics.
- **The connection string carries server + username only — NEVER the password.** (`connstr.ts` has no password field at all.)
- **No E2E content encryption, no version history** — out of scope (spec §1 non-goals).
- **Plain vocabulary** (spec §1, §7): "Remote vault", "Connect", "Fully synced", "Automatically merge" / "Create conflict file", "Sync log", "Device name", "Disconnect". Never "database"/"replicate"/"chunk" in user-facing copy.
- **Pure logic is unit-tested; DOM renderers are manual-tested** (Obsidian `Modal`/`Setting` cannot render headlessly). Push all decisions into `connstr`/`wizardsteps`.
- **Test runner:** `cd client && npx vitest run <file>`. Type/build check: `cd client && npx tsc --noEmit && npm run build`.
- **Commits:** use `git commit --no-verify` (the external keel pre-commit hook is broken this repo; note it in the body). End messages with the repo's Co-Authored-By / Claude-Session trailer.
- **`main.js` is git-ignored** (built locally) — never commit it.

---

### Task 1: `connstr.ts` — the `selfsync://` setup link (pure)

**Files:**
- Create: `client/src/connstr.ts`
- Test: `client/test/connstr.test.ts`

**Interfaces:**
- Produces: `interface SetupLink { server: string; user: string }`, `encodeSetupLink(link: SetupLink): string`, `parseSetupLink(str: string): SetupLink`, `normalizeServer(server: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/connstr.test.ts
import { describe, it, expect } from "vitest";
import { encodeSetupLink, parseSetupLink, normalizeServer } from "../src/connstr";

describe("connstr round-trip", () => {
  it("encodes then parses back to the same server+user", () => {
    const link = encodeSetupLink({ server: "https://sync.example.com:443", user: "will" });
    expect(link.startsWith("selfsync://")).toBe(true);
    const back = parseSetupLink(link);
    expect(back).toEqual({ server: "https://sync.example.com:443", user: "will" });
  });
  it("preserves http vs https and custom ports", () => {
    const back = parseSetupLink(encodeSetupLink({ server: "http://192.168.1.9:8789", user: "a" }));
    expect(back.server).toBe("http://192.168.1.9:8789");
  });
});

describe("connstr never carries a secret", () => {
  it("the encoded link contains no password (there is no password field)", () => {
    const link = encodeSetupLink({ server: "https://s.example.com", user: "will" });
    expect(link.toLowerCase()).not.toContain("password");
    expect(link).not.toContain("hunter2");
  });
});

describe("connstr validation", () => {
  it("rejects a non-selfsync string", () => {
    expect(() => parseSetupLink("https://example.com?user=x")).toThrow(/setup link/i);
  });
  it("rejects a link missing user or server", () => {
    expect(() => parseSetupLink("selfsync://connect?server=https%3A%2F%2Fs.example.com")).toThrow(/missing/i);
  });
  it("normalizeServer strips path/query and trailing slash, rejects non-http(s)", () => {
    expect(normalizeServer("https://s.example.com/base/")).toBe("https://s.example.com");
    expect(() => normalizeServer("ftp://s.example.com")).toThrow(/http/i);
    expect(() => normalizeServer("not a url")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run connstr`
Expected: FAIL — cannot find module `../src/connstr`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/connstr.ts
// A shareable setup link for bootstrapping another device. Carries the server URL
// and username ONLY — never the password (there is no password field here by design).
export interface SetupLink { server: string; user: string; }

// Canonical server origin: scheme + host(:port), no path/query/trailing slash.
export function normalizeServer(server: string): string {
  const u = new URL(server); // throws on a non-absolute / malformed URL
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Server must be an http(s) URL");
  }
  return `${u.protocol}//${u.host}`;
}

export function encodeSetupLink({ server, user }: SetupLink): string {
  if (!user) throw new Error("username required");
  const p = new URLSearchParams({ server: normalizeServer(server), user });
  return `selfsync://connect?${p.toString()}`;
}

export function parseSetupLink(str: string): SetupLink {
  const trimmed = str.trim();
  if (!trimmed.startsWith("selfsync://")) throw new Error("Not a SelfSync setup link");
  // Swap the custom scheme for one the URL parser accepts, then read query params.
  const u = new URL(trimmed.replace(/^selfsync:\/\//, "https://"));
  const server = u.searchParams.get("server") ?? "";
  const user = u.searchParams.get("user") ?? "";
  if (!server || !user) throw new Error("Setup link is missing server or username");
  return { server: normalizeServer(server), user };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run connstr`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/connstr.ts client/test/connstr.test.ts
git commit --no-verify -m "feat(client): selfsync:// setup-link encode/parse (goal #1)"
```

---

### Task 2: `wizardsteps.ts` — wizard gating + status-line text (pure)

**Files:**
- Create: `client/src/wizardsteps.ts`
- Test: `client/test/wizardsteps.test.ts`

**Interfaces:**
- Consumes: `Phase` from `./syncstate` (existing: `"off" | "connecting" | "idle" | "syncing" | "offline"`).
- Produces:
  - `type WizardStep = "welcome" | "server" | "account" | "vault" | "done"`
  - `interface WizardState { server: string; serverOk: boolean; mode: "login" | "register"; username: string; password: string; loggedIn: boolean; vaults: string[]; chosenVault: string; newVault: string }`
  - `canAdvance(step: WizardStep, s: WizardState): boolean`
  - `nextStep(step: WizardStep, opts?: { haveLink?: boolean }): WizardStep`
  - `interface StatusLineInput { user?: string; vault?: string; lastSyncedLabel?: string }`
  - `interface StatusLines { title: string; detail: string }`
  - `statusLine(phase: Phase, i: StatusLineInput): StatusLines`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/wizardsteps.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run wizardsteps`
Expected: FAIL — cannot find module `../src/wizardsteps`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/wizardsteps.ts
// Pure logic behind the setup wizard + the settings status card. No Obsidian API,
// so it is fully unit-testable; SetupWizardModal / the settings tab render over it.
import { Phase } from "./syncstate";

export type WizardStep = "welcome" | "server" | "account" | "vault" | "done";

export interface WizardState {
  server: string;
  serverOk: boolean;          // set true once "Test connection" succeeds
  mode: "login" | "register";
  username: string;
  password: string;
  loggedIn: boolean;          // set true once login/register succeeds
  vaults: string[];           // fetched after login
  chosenVault: string;        // an existing vault
  newVault: string;           // a to-be-created vault name
}

export function canAdvance(step: WizardStep, s: WizardState): boolean {
  switch (step) {
    case "welcome": return true;
    case "server": return s.serverOk;
    case "account": return s.loggedIn;
    case "vault": return Boolean(s.chosenVault || s.newVault.trim());
    case "done": return true;
  }
}

// A setup link prefills server + username and validates them, so we skip the server
// step and land on account (password only).
export function nextStep(step: WizardStep, opts?: { haveLink?: boolean }): WizardStep {
  switch (step) {
    case "welcome": return opts?.haveLink ? "account" : "server";
    case "server": return "account";
    case "account": return "vault";
    case "vault": return "done";
    case "done": return "done";
  }
}

export interface StatusLineInput { user?: string; vault?: string; lastSyncedLabel?: string; }
export interface StatusLines { title: string; detail: string; }

const NOT_SET_UP: StatusLines = { title: "Not set up", detail: "Sync your notes to your own server." };

export function statusLine(phase: Phase, i: StatusLineInput): StatusLines {
  const configured = Boolean(i.user && i.vault);
  if (!configured || phase === "off") return NOT_SET_UP;
  const who = `Signed in as ${i.user} · Remote vault '${i.vault}'`;
  switch (phase) {
    case "connecting": return { title: "Connecting…", detail: who };
    case "syncing":    return { title: "Syncing…", detail: who };
    case "offline":    return { title: "Offline — retrying", detail: who };
    case "idle":       return { title: "Fully synced", detail: who + (i.lastSyncedLabel ? ` · ${i.lastSyncedLabel}` : "") };
    default:           return NOT_SET_UP;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run wizardsteps`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/wizardsteps.ts client/test/wizardsteps.test.ts
git commit --no-verify -m "feat(client): pure wizard-step gating + status-line builder (goal #1)"
```

---

### Task 3: Settings model fields + `transport.testConnection()`

**Files:**
- Modify: `client/src/settings.ts` (the `NewLiveSyncSettings` interface + `DEFAULT_SETTINGS`)
- Modify: `client/src/transport.ts` (add `testConnection`)

**Interfaces:**
- Produces: `NewLiveSyncSettings` gains `authToken?: string` and `lastSyncedAt?: number`; `HttpTransport.testConnection(baseUrl: string): Promise<boolean>` (static).

- [ ] **Step 1: Add the two settings fields**

In `client/src/settings.ts`, add to the `NewLiveSyncSettings` interface (after `vaultId`):

```ts
  authToken?: string;    // cached bearer token to skip re-login (B7 will make server-side tokens durable/revocable)
  lastSyncedAt?: number; // epoch ms of the last successful reconcile; shown in the status card
```

Add to `DEFAULT_SETTINGS` (after `vaultId: "default",`):

```ts
  authToken: undefined,
  lastSyncedAt: undefined,
```

- [ ] **Step 2: Add `testConnection` to the transport**

In `client/src/transport.ts`, add this static method alongside the other statics (e.g. after `login`):

```ts
  // Lightweight reachability probe for the setup wizard's "Test connection" button.
  // Hits the unauthenticated /health endpoint; true iff the server answers 200 "ok".
  static async testConnection(baseUrl: string): Promise<boolean> {
    try {
      const r = await requestUrl({ url: `${baseUrl.replace(/\/+$/, "")}/health`, method: "GET", throw: false });
      return r.status === 200;
    } catch {
      return false;
    }
  }
```

- [ ] **Step 3: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add client/src/settings.ts client/src/transport.ts
git commit --no-verify -m "feat(client): settings authToken/lastSyncedAt + transport.testConnection (goal #1)"
```

---

### Task 4: `SetupWizardModal` (replaces `OnboardingModal`)

**Files:**
- Create: `client/src/setupwizard.ts`
- Modify: `client/src/main.ts` (import + `openSetup()` + the "setup" command; auto-open on first run)
- (Do NOT delete `onboarding.ts` yet — Task 8 removes it after all references are gone.)

**Interfaces:**
- Consumes: `parseSetupLink` (Task 1); `WizardStep`, `WizardState`, `canAdvance`, `nextStep` (Task 2); `HttpTransport.testConnection` + existing `login`/`register`/`listVaults`/`createVault` (Task 3); `plugin.settings`, `plugin.saveSettings()`, `plugin.reconnect()`, `plugin.setAuthToken(token)` (Task 5 adds `setAuthToken`; until then set `plugin.settings.authToken` directly — Task 5 refactors).
- Produces: `class SetupWizardModal extends Modal` with `constructor(app, plugin)` and `open()`.

- [ ] **Step 1: Write the modal**

```ts
// client/src/setupwizard.ts
import { App, Modal, Notice, Setting } from "obsidian";
import { HttpTransport } from "./transport";
import { parseSetupLink } from "./connstr";
import { WizardStep, WizardState, canAdvance, nextStep } from "./wizardsteps";
import type NewLiveSyncPlugin from "./main";

// Guided first-run setup: Welcome → Server(test) → Account → Remote vault → Done.
// Next is disabled until the current step validates. A pasted setup link prefills
// server+username and skips straight to the account (password) step.
export class SetupWizardModal extends Modal {
  private step: WizardStep = "welcome";
  private token = "";
  private s: WizardState;

  constructor(app: App, private plugin: NewLiveSyncPlugin) {
    super(app);
    const st = plugin.settings;
    this.s = {
      server: st.serverUrl ?? "", serverOk: false, mode: "login",
      username: st.username ?? "", password: "", loggedIn: false,
      vaults: [], chosenVault: st.vaultId ?? "", newVault: "",
    };
  }

  onOpen() { this.render(); }
  onClose() { this.contentEl.empty(); }

  private render() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("Set up SelfSync");
    switch (this.step) {
      case "welcome": return this.renderWelcome(c);
      case "server": return this.renderServer(c);
      case "account": return this.renderAccount(c);
      case "vault": return this.renderVault(c);
      case "done": return this.renderDone(c);
    }
  }

  private goto(step: WizardStep) { this.step = step; this.render(); }

  private renderWelcome(c: HTMLElement) {
    c.createEl("p", { text: "Sync your notes to your own server." });
    new Setting(c)
      .addButton((b) => b.setButtonText("Get started").setCta().onClick(() => this.goto(nextStep("welcome"))))
      .addButton((b) => b.setButtonText("I have a setup link").onClick(() => this.promptSetupLink()));
  }

  private promptSetupLink() {
    const c = this.contentEl; c.empty();
    this.titleEl.setText("Paste setup link");
    let text = "";
    new Setting(c).setName("Setup link").setDesc("selfsync://… from another device")
      .addText((t) => t.setPlaceholder("selfsync://connect?…").onChange((v) => { text = v; }));
    new Setting(c)
      .addButton((b) => b.setButtonText("Back").onClick(() => this.goto("welcome")))
      .addButton((b) => b.setButtonText("Use link").setCta().onClick(() => {
        try {
          const link = parseSetupLink(text);
          this.s.server = link.server; this.s.username = link.user; this.s.serverOk = false;
          this.goto(nextStep("welcome", { haveLink: true })); // → account
        } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
      }));
  }

  private renderServer(c: HTMLElement) {
    let status = "";
    new Setting(c).setName("Server URL")
      .addText((t) => t.setValue(this.s.server).onChange((v) => { this.s.server = v.trim(); this.s.serverOk = false; }));
    const statusEl = c.createEl("p", { text: status });
    new Setting(c)
      .addButton((b) => b.setButtonText("Test connection").onClick(async () => {
        this.s.serverOk = await HttpTransport.testConnection(this.s.server);
        statusEl.setText(this.s.serverOk ? "Reachable ✓" : "Couldn't reach that server. Check the URL and that the server is running.");
        this.renderNav(c, "server");
      }));
    this.renderNav(c, "server", () => this.goto("welcome"));
  }

  private renderAccount(c: HTMLElement) {
    new Setting(c).setName("Account")
      .addDropdown((dd) => dd.addOption("login", "Log in").addOption("register", "Create account")
        .setValue(this.s.mode).onChange((v) => { this.s.mode = v as "login" | "register"; }));
    new Setting(c).setName("Username").addText((t) => t.setValue(this.s.username).onChange((v) => { this.s.username = v.trim(); this.s.loggedIn = false; }));
    new Setting(c).setName("Password").addText((t) => { t.inputEl.type = "password"; t.onChange((v) => { this.s.password = v; this.s.loggedIn = false; }); });
    new Setting(c).addButton((b) => b.setButtonText(this.s.mode === "login" ? "Log in" : "Create & log in").setCta()
      .onClick(() => void this.doLogin(c)));
    this.renderNav(c, "account", () => this.goto("server"));
  }

  private async doLogin(c: HTMLElement) {
    try {
      if (this.s.mode === "register") await HttpTransport.register(this.s.server, this.s.username, this.s.password);
      this.token = await HttpTransport.login(this.s.server, this.s.username, this.s.password);
      this.s.vaults = await HttpTransport.listVaults(this.s.server, this.token);
      this.s.chosenVault = this.s.vaults[0] ?? this.s.chosenVault;
      this.s.loggedIn = true;
      this.goto("vault");
    } catch (e: any) {
      new Notice(`SelfSync: ${this.friendlyAuthError(e)}`);
    }
  }

  private friendlyAuthError(e: any): string {
    const m = String(e?.message ?? e);
    if (m.includes("401") && this.s.mode === "register") return "This server doesn't allow new accounts. Ask the admin for login details.";
    if (m.includes("401")) return "Wrong username or password.";
    return m;
  }

  private renderVault(c: HTMLElement) {
    if (this.s.vaults.length) {
      new Setting(c).setName("Sync this vault to")
        .addDropdown((dd) => { for (const v of this.s.vaults) dd.addOption(v, v); dd.setValue(this.s.chosenVault).onChange((v) => { this.s.chosenVault = v; this.s.newVault = ""; }); });
    } else {
      c.createEl("p", { text: "No remote vaults yet — create one below." });
    }
    new Setting(c).setName("Or create a new vault")
      .addText((t) => t.setPlaceholder("e.g. notes").onChange((v) => { this.s.newVault = v.trim(); }));
    this.renderNav(c, "vault", () => this.goto("account"), "Start syncing", () => void this.finish());
  }

  private async finish() {
    try {
      let vault = this.s.chosenVault;
      if (this.s.newVault) { await HttpTransport.createVault(this.s.server, this.token, this.s.newVault); vault = this.s.newVault; }
      if (!vault) { new Notice("SelfSync: pick or name a vault"); return; }
      const st = this.plugin.settings;
      st.serverUrl = this.s.server; st.username = this.s.username; st.password = this.s.password;
      st.vaultId = vault; st.authToken = this.token;
      await this.plugin.saveSettings();
      this.goto("done");
    } catch (e: any) { new Notice(`SelfSync: ${e?.message ?? e}`); }
  }

  private renderDone(c: HTMLElement) {
    this.titleEl.setText("All set");
    c.createEl("p", { text: `SelfSync is now syncing '${this.plugin.settings.vaultId}'.` });
    new Setting(c).addButton((b) => b.setButtonText("Done").setCta().onClick(() => { this.close(); void this.plugin.reconnect(); }));
  }

  // Back / Next nav; Next is disabled until the step validates.
  private renderNav(c: HTMLElement, step: WizardStep, back?: () => void, nextLabel = "Next", nextAction?: () => void) {
    const nav = new Setting(c);
    if (back) nav.addButton((b) => b.setButtonText("Back").onClick(back));
    nav.addButton((b) => {
      b.setButtonText(nextLabel).setCta().setDisabled(!canAdvance(step, this.s))
        .onClick(nextAction ?? (() => this.goto(nextStep(step))));
    });
  }
}
```

- [ ] **Step 2: Wire it into `main.ts`**

In `client/src/main.ts`: replace the `OnboardingModal` import with `SetupWizardModal`:

```ts
import { SetupWizardModal } from "./setupwizard";
```
(Leave the existing `import { OnboardingModal } from "./onboarding";` line for now if other code still references it — Task 8 removes both `onboarding.ts` and any leftover import.)

Change `openSetup()`:

```ts
  openSetup() { new SetupWizardModal(this.app, this).open(); }
```

Change the "setup" command callback (line ~109) to use `openSetup()`:

```ts
    this.addCommand({ id: "setup", name: "Set up / switch vault", callback: () => this.openSetup() });
```

Auto-open on first run — change the `onLayoutReady` line (line ~120) to:

```ts
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.vaultId || !this.settings.serverUrl || !this.settings.username) this.openSetup();
      else void this.reconnect();
    });
```

- [ ] **Step 3: Type-check + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 4: Manual checklist (record results in the PR/commit body)**

In Obsidian with a running server:
- Fresh vault (no settings) → wizard auto-opens; Next on Server disabled until "Test connection" is green; bad URL shows the reachability error.
- Log in with wrong password → "Wrong username or password."; correct → advances to vault step.
- Create a new vault → "Start syncing" → Done → status goes green.
- "I have a setup link" with a link from Task 6's Add-a-device → prefills server+username, lands on the password step.

- [ ] **Step 5: Commit**

```bash
git add client/src/setupwizard.ts client/src/main.ts
git commit --no-verify -m "feat(client): guided SetupWizardModal + auto-open on first run (goal #1)"
```

---

### Task 5: `main.ts` auth wiring — token reuse, re-auth, disconnect, last-synced

**Files:**
- Modify: `client/src/main.ts`

**Interfaces:**
- Consumes: `HttpTransport` (existing). `settings.authToken`, `settings.lastSyncedAt` (Task 3).
- Produces: `setAuthToken(token: string): void`, `disconnect(): Promise<void>`, `signOut(): Promise<void>`, `addDeviceLink(): string`, and updated `reconnect()` that reuses the token and falls back to a password re-login. `lastSyncedAt` is stamped after each successful reconcile.

- [ ] **Step 1: Read the current `reconnect()`**

Open `client/src/main.ts` and locate `async reconnect()` (around line 144) and the `HttpTransport.login(...)` call inside it. This task changes only the login acquisition + adds a `lastSyncedAt` stamp; the FSM dispatches, WS, polling, and the M5 `/status` guard stay as-is.

- [ ] **Step 2: Add token reuse + re-login fallback in `reconnect()`**

Replace the single login line:

```ts
      const token = await HttpTransport.login(this.settings.serverUrl, this.settings.username, this.settings.password);
      this.log("login OK");
      this.api = new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default");
```

with:

```ts
      const token = await this.acquireToken();
      this.api = new HttpTransport(this.settings.serverUrl, token, this.settings.vaultId || "default");
```

Add these methods to the plugin class (near `openSetup`):

```ts
  setAuthToken(token: string) { this.settings.authToken = token; void this.saveSettings(); }

  // Reuse the cached token when it still works; otherwise re-login with the stored
  // password (tokens are ephemeral server-side until B7). listVaults is a cheap
  // authenticated probe. Throws if neither path yields a working token.
  private async acquireToken(): Promise<string> {
    const url = this.settings.serverUrl;
    if (this.settings.authToken) {
      try { await HttpTransport.listVaults(url, this.settings.authToken); this.log("token OK"); return this.settings.authToken; }
      catch { this.log("cached token rejected — re-logging in"); }
    }
    if (!this.settings.password) throw new Error("no password stored; re-run setup");
    const token = await HttpTransport.login(url, this.settings.username, this.settings.password);
    this.setAuthToken(token);
    this.log("login OK");
    return token;
  }

  // Unbind this vault (keep local files); return to the unconfigured state.
  async disconnect() {
    this.settings.vaultId = "";
    await this.saveSettings();
    this.ws?.close();
    if (this.pollTimer !== undefined) { window.clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.machine.dispatch("unload");
    this.log("disconnected (local files kept)", true);
  }

  // Sign out: forget credentials + token, drop to Not-set-up.
  async signOut() {
    this.settings.authToken = undefined;
    this.settings.password = "";
    await this.disconnect();
  }

  // A shareable setup link for another device (server + username only, never password).
  addDeviceLink(): string {
    return encodeSetupLink({ server: this.settings.serverUrl, user: this.settings.username });
  }
```

Add the import at the top of `main.ts`:

```ts
import { encodeSetupLink } from "./connstr";
```

- [ ] **Step 3: Stamp `lastSyncedAt` after a successful reconcile**

In `reconnect()`, immediately after the existing `this.machine.dispatch("connected");` line, add:

```ts
      this.settings.lastSyncedAt = Date.now(); void this.saveSettings();
```

And in `onRemoteChanged()`, immediately after the existing `this.machine.dispatch("syncDone");` at the end of the success path, add:

```ts
      this.settings.lastSyncedAt = Date.now();
```

- [ ] **Step 4: Type-check + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 5: Manual checklist**

- Connect once; restart Obsidian → reconnect uses cached token (log shows "token OK"), no password round-trip.
- Stop the server, restart it → client recovers (token rejected → re-login).
- Clear the stored password (via Sign out), then reconnect → shows the "re-run setup" path.

- [ ] **Step 6: Commit**

```bash
git add client/src/main.ts
git commit --no-verify -m "feat(client): token reuse + re-login fallback, disconnect/signOut, last-synced stamp (goal #1)"
```

---

### Task 6: Restructure the settings tab (status-first + Advanced)

**Files:**
- Modify: `client/src/settings.ts`

**Interfaces:**
- Consumes: `statusLine` (Task 2); `encodeSetupLink` via `plugin.addDeviceLink()` (Task 5); `plugin.disconnect()`, `plugin.signOut()`, `plugin.openSetup()`, `plugin.reconnect()`, `plugin.statusText()` (returns the FSM `Phase`), `plugin.settings`, `plugin.saveSettings()`; existing `renderSelectiveSync` (M6).
- Produces: a rewritten `display()` with `renderStatusCard`, `renderConnection`, `renderWhatSyncs`, `renderAdvanced`; keeps `renderSelectiveSync`/`renderPluginChecklist` unchanged.

- [ ] **Step 1: Rewrite `display()` and add the section renderers**

Replace the body of `display()` (from `const { containerEl } = this;` through the closing of the method) with:

```ts
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings;
    const configured = Boolean(s.vaultId && s.serverUrl && s.username);

    this.renderStatusCard(containerEl, s, configured);
    if (!configured) return; // unconfigured: only the status card + Set up button

    this.renderConnection(containerEl, s);
    this.renderWhatSyncs(containerEl, s);
    this.renderAdvanced(containerEl, s);
  }

  private lastSyncedLabel(s: NewLiveSyncSettings): string | undefined {
    if (!s.lastSyncedAt) return undefined;
    const mins = Math.round((Date.now() - s.lastSyncedAt) / 60000);
    if (mins <= 0) return "Last synced just now";
    if (mins < 60) return `Last synced ${mins}m ago`;
    return `Last synced ${new Date(s.lastSyncedAt).toLocaleTimeString()}`;
  }

  private renderStatusCard(c: HTMLElement, s: NewLiveSyncSettings, configured: boolean): void {
    const phase = this.plugin.statusText(); // FSM Phase
    const spec = light(phase);
    const lines = statusLine(phase, { user: s.username, vault: s.vaultId, lastSyncedLabel: this.lastSyncedLabel(s) });
    const card = c.createEl("div");
    card.setAttribute("style", "padding:12px;border:1px solid var(--background-modifier-border);border-radius:8px;margin-bottom:16px;");
    const head = card.createEl("div", { text: "● " + lines.title });
    head.setAttribute("style", `font-weight:600;color:${spec.color};`);
    card.createEl("div", { text: lines.detail }).setAttribute("style", "opacity:0.8;font-size:12px;margin-top:2px;");
    const bar = card.createEl("div"); bar.setAttribute("style", "display:flex;gap:8px;margin-top:10px;");
    if (!configured) {
      const setup = bar.createEl("button", { text: "Set up SelfSync" }); setup.addClass("mod-cta");
      setup.onclick = () => this.plugin.openSetup();
      return;
    }
    if (phase === "offline") { const r = bar.createEl("button", { text: "Reconnect" }); r.onclick = () => this.plugin.reconnect(); }
    const add = bar.createEl("button", { text: "Add a device" }); add.onclick = () => this.showDeviceLink();
  }

  private showDeviceLink(): void {
    // Reuse a lightweight modal-free notice + a read-only field in the tab.
    const link = this.plugin.addDeviceLink();
    navigator.clipboard?.writeText(link).then(
      () => new Notice("SelfSync: setup link copied — paste it on the other device"),
      () => new Notice(`SelfSync setup link: ${link}`),
    );
  }

  private renderConnection(c: HTMLElement, s: NewLiveSyncSettings): void {
    c.createEl("h3", { text: "Connection" });
    new Setting(c).setName("Server").setDesc(s.serverUrl)
      .addButton((b) => b.setButtonText("Change").onClick(() => this.plugin.openSetup()));
    new Setting(c).setName("Account").setDesc(s.username)
      .addButton((b) => b.setButtonText("Sign out").onClick(async () => { await this.plugin.signOut(); this.display(); }));
    new Setting(c).setName("Remote vault").setDesc(s.vaultId)
      .addButton((b) => b.setButtonText("Switch vault").onClick(() => this.plugin.openSetup()));
  }

  private renderWhatSyncs(c: HTMLElement, s: NewLiveSyncSettings): void {
    c.createEl("h3", { text: "What syncs" });
    new Setting(c).setName("Notes & attachments").setDesc("Always synced.");
    const cs = s.configSync;
    const summary = !cs.enabled ? "Off" :
      `On${cs.pluginDeny.length ? ` — ${cs.pluginDeny.length} plugin(s) excluded` : ""}`;
    const detail = c.createEl("details");
    detail.createEl("summary", { text: `Obsidian settings — ${summary}` });
    this.renderSelectiveSync(detail, s); // existing M6 panel, now nested
  }

  private renderAdvanced(c: HTMLElement, s: NewLiveSyncSettings): void {
    const adv = c.createEl("details");
    adv.createEl("summary", { text: "Advanced" });
    new Setting(adv).setName("Conflict resolution")
      .addDropdown((dd) => dd
        .addOption("auto-merge", "Automatically merge")
        .addOption("conflict-file", "Create conflict file")
        .setValue(s.conflictStrategy)
        .onChange(async (v) => { s.conflictStrategy = v as NewLiveSyncSettings["conflictStrategy"]; await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Device name").setDesc("Shown in conflict-copy filenames. Blank = auto.")
      .addText((t) => t.setValue(s.deviceName).onChange(async (v) => { s.deviceName = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Detailed logging")
      .addToggle((tg) => tg.setValue(s.verbose).onChange(async (v) => { s.verbose = v; await this.plugin.saveSettings(); }));
    new Setting(adv).setName("Diagnostics")
      .addButton((b) => b.setButtonText("Show sync log").onClick(() => this.plugin.showLog()))
      .addButton((b) => b.setButtonText("Copy debug info").onClick(() => this.copyDebugInfo(s)));
    new Setting(adv).setName("Disconnect").setDesc("Stop syncing this vault. Local files are kept.")
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(async () => { await this.plugin.disconnect(); this.display(); }));
  }

  private copyDebugInfo(s: NewLiveSyncSettings): void {
    let host = s.serverUrl;
    try { host = new URL(s.serverUrl).host; } catch { /* keep raw */ }
    const info = [
      `phase: ${this.plugin.statusText()}`,
      `server: ${host}`,
      `vault: ${s.vaultId}`,
      `configSync: ${s.configSync.enabled ? "on" : "off"}`,
      "--- recent log ---",
      this.plugin.getLogText(),
    ].join("\n");
    navigator.clipboard?.writeText(info).then(
      () => new Notice("SelfSync: debug info copied"),
      () => new Notice("SelfSync: copy failed — open the sync log instead"),
    );
  }
```

- [ ] **Step 2: Fix imports in `settings.ts`**

Ensure the top of `settings.ts` imports `Notice` and the pure helpers:

```ts
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { statusLine } from "./wizardsteps";
import { light } from "./syncstate";
```
(Keep the existing `ConfigSyncSelection`/`DEFAULT_CONFIG_SYNC` import.)

- [ ] **Step 3: Type-check + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 4: Manual checklist**

- Configured vault: status card shows "● Fully synced", "Signed in as …", last-synced label; "Add a device" copies a `selfsync://` link.
- Connection section shows server/account/vault with Change/Sign out/Switch.
- "What syncs" → expand shows the M6 selective-sync panel unchanged.
- Advanced collapsed by default; conflict dropdown persists; "Copy debug info" contains NO password; Disconnect returns the tab to the "Not set up" card.

- [ ] **Step 5: Commit**

```bash
git add client/src/settings.ts
git commit --no-verify -m "feat(client): status-first settings tab with progressive disclosure (goal #1)"
```

---

### Task 7: E2E — testConnection ping + wizard-happy-path data flow

**Files:**
- Modify: `client/test/e2e.spec.ts`

**Interfaces:**
- Consumes: existing E2E harness (`spawn`, `NodeTransport`, `login`, `connect`); `HttpTransport.testConnection` is Obsidian-only (`requestUrl`), so the E2E asserts the underlying `/health` + the account→vault flow via `NodeTransport`, mirroring what the wizard drives.

- [ ] **Step 1: Add the test**

Add inside the `describe.skipIf(!canRun)(...)` block in `client/test/e2e.spec.ts` (after the M6 test, before the closing `});`):

```ts
  it("goal#1: wizard data flow — health ping, register/login, create+list vault, then sync works", async () => {
    // /health reachability (what the wizard's Test-connection button checks)
    const health = await fetch(`${base}/health`).then((r) => r.status);
    expect(health).toBe(200);

    // account → vault, mirroring SetupWizardModal.finish()
    const token = await NodeTransport.login(base, "admin", "admin");
    await NodeTransport.createVault(base, token, "wizardvault");
    const vaults = await NodeTransport.listVaults(base, token);
    expect(vaults).toContain("wizardvault");

    // and the newly-created vault actually syncs a file
    const a = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-wzA-")), "A", "wizardvault");
    const b = await connect(base, mkdtempSync(path.join(os.tmpdir(), "nls-wzB-")), "B", "wizardvault");
    await a.io.write("hello.md", enc("hi from wizard vault"));
    await pushFile(a.api, a.io, a.state, a.cache, "hello.md");
    await pull(b.api, b.io, b.state, b.cache);
    expect(dec(await b.io.read("hello.md"))).toBe("hi from wizard vault");

    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }, 30000);
```

If `NodeTransport` lacks `listVaults`/`createVault` statics, mirror them from `HttpTransport` (same URLs) — check the top of `e2e.spec.ts` where `NodeTransport` is defined and add them if missing (they were added for the M4 test, so they should exist).

- [ ] **Step 2: Build server + run the E2E**

Run: `cd server && cargo build && cd ../client && npx vitest run e2e`
Expected: PASS — all E2E tests including the new `goal#1` one.

- [ ] **Step 3: Commit**

```bash
git add client/test/e2e.spec.ts
git commit --no-verify -m "test(client): E2E for the wizard data flow (health + account→vault→sync) (goal #1)"
```

---

### Task 8: Remove `onboarding.ts` + final full-suite verification

**Files:**
- Delete: `client/src/onboarding.ts`
- Modify: `client/src/main.ts` (remove any leftover `OnboardingModal` import/reference)

- [ ] **Step 1: Find remaining references**

Run: `cd client && grep -rn "OnboardingModal\|onboarding" src/`
Expected: only the import line + none-or-few usages. Replace any remaining `new OnboardingModal(...)` with `new SetupWizardModal(...)` (or `this.openSetup()`), then remove the `import { OnboardingModal } from "./onboarding";` line.

- [ ] **Step 2: Delete the file**

```bash
git rm client/src/onboarding.ts
```

- [ ] **Step 3: Full verification**

Run: `cd client && npx tsc --noEmit && npm run build && npx vitest run`
Expected: tsc clean; build succeeds; ALL tests pass (prior 57 + connstr 7 + wizardsteps 10 + the new E2E = ~75).

Run: `cd server && cargo test`
Expected: 25 pass (unchanged — no server edits).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit --no-verify -m "refactor(client): remove OnboardingModal, superseded by SetupWizardModal (goal #1)"
```

- [ ] **Step 5: Update the backlog note**

In `docs/design/backlog.md`, the goal-#1 line at the bottom (the parenthetical about "The full config-UX overhaul remains the deferred goal #1") — leave B1/B2 as-is but the maintainer may mark goal #1 done in the project's tracking. (No code change; optional doc touch.)

---

## Self-Review

**Spec coverage** (spec §→task):
- §2 two surfaces/one truth → Tasks 4 (wizard) + 6 (tab), both write `settings`. ✓
- §3 tab layout + status states → Task 6 (+ `statusLine` Task 2). ✓
- §4 elimination pass (password off-tab, conflict demoted, deviceName demoted, verbose→Detailed logging, configSync collapsed) → Task 6. ✓
- §5 wizard flow + connection string + error copy + re-auth → Tasks 4 (flow/copy), 1 (connstr), 5 (re-auth). ✓
- §6 auth mechanism (token reuse + password fallback) → Task 5. ✓
- §7 files → Tasks 1–8 cover connstr, wizardsteps, setupwizard, settings, main, transport, syncstate reuse, onboarding removal. ✓
- §8 testing (pure units + E2E + manual) → Tasks 1,2 (units), 7 (E2E), 4,5,6 (manual checklists). ✓
- §9 risks: DOM manual-only (checklists present), hostname fallback (existing `deviceLabel` unchanged), QR self-contained (**gap** — see note), M6 reload unchanged, M6 default divergence left as-is. 

**QR note:** the spec mentions a QR rendering for "Add a device"; this plan ships the copyable `selfsync://` link (Task 6 `showDeviceLink`) and defers the QR *image* rendering, because a self-contained QR generator is a bounded add and the link alone satisfies device bootstrap. If the QR image is wanted, add a follow-up task for an inline SVG QR generator (no external host). Flagged rather than silently dropped.

**Placeholder scan:** none — every step has concrete code or an exact command.

**Type consistency:** `WizardState`/`WizardStep`/`canAdvance`/`nextStep`/`statusLine` signatures match between Task 2 and their consumers (Tasks 4, 6); `authToken`/`lastSyncedAt` fields (Task 3) match usage (Tasks 5, 6); `addDeviceLink`/`disconnect`/`signOut`/`setAuthToken` (Task 5) match calls (Task 6). `statusText()` returns the FSM `Phase` (existing) — consumed by `statusLine` in Task 6. ✓
