// Real-browser (Chromium) functional tests for the admin web page. Each drives the page's ACTUAL
// click-handlers against a freshly-spawned server, confirming the control's on-screen effect — the
// coverage the server-side reqwest tests can't give (they test endpoints, not the page's JS wiring).
// Goal: EVERY interactive control + indicator on the page is exercised, plus the 9 audit-fixed defects.
import { test, expect, Page } from "@playwright/test";
import { startServer, canRun, totp, RunningServer } from "./helpers";

test.skip(!canRun, "server binary not built — run `cargo build` in server/ first");

let server: RunningServer;
// A fresh server per test: flows mutate account/vault state, so isolation keeps each test order-free.
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function login(page: Page, base: string, user: string, pass: string) {
  await page.goto(`${base}/admin`);
  await page.fill("#u", user);
  await page.fill("#p", pass);
  await page.click("#go");
}
async function loginAdmin(page: Page) {
  await login(page, server.base, "admin", "admin");
  await expect(page.locator("#who")).toContainText("admin");
}
// Admin-create a ready-to-use account: create (must-change), then this account can still be a share
// grantee / admin-toggle target without finishing its own forced change (those act on the account).
async function createAccount(page: Page, name: string, pw = "Temp1234") {
  await page.fill("#nu", name);
  await page.fill("#np", pw);
  await page.click("#addu");
  await expect(page.locator("#msg")).toContainText("Account created");
}

// ---- Login + session ----------------------------------------------------------------------------

test.describe("login + session", () => {
  test("wrong password shows a de-oracled failure and stays on the login form", async ({ page }) => {
    await page.goto(`${server.base}/admin`);
    await page.fill("#u", "admin");
    await page.fill("#p", "wrong");
    await page.click("#go");
    await expect(page.locator("#msg")).toContainText("Sign in failed");
    await expect(page.locator("#go")).toBeVisible();
  });

  test("admin login renders the dashboard + server-admin badge + all admin panels", async ({ page }) => {
    await loginAdmin(page);
    await expect(page.locator(".badge")).toHaveText("server-admin");
    for (const id of ["#mfa", "#vaults", "#users", "#reg", "#invites"]) {
      await expect(page.locator(id)).toBeVisible();
    }
  });

  test("A1: sign out revokes the session (POST /api/logout) and returns to login", async ({ page }) => {
    await loginAdmin(page);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/logout") && r.request().method() === "POST"),
      page.click("#out"),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator("#go")).toBeVisible();
  });

  test("the pre-auth consent banner is shown before credentials (AC.3.1.9 indicator)", async ({ page }) => {
    const withBanner = await startServer({ banner: "AUTHORIZED USE ONLY — monitored." });
    try {
      await page.goto(`${withBanner.base}/admin`);
      await expect(page.locator("#app")).toContainText("AUTHORIZED USE ONLY");
      await expect(page.locator("#go")).toBeVisible(); // banner sits above the still-present login form
    } finally { await withBanner.stop(); }
  });
});

// ---- Forced password change (A3) ---------------------------------------------------------------

test.describe("forced password change (A3)", () => {
  test("a must-change account gets the change screen and then signs in", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "dana");
    await page.click("#out");
    await expect(page.locator("#go")).toBeVisible();
    await login(page, server.base, "dana", "Temp1234");
    await expect(page.locator("#cpc")).toBeVisible();
    await page.fill("#cpc", "Temp1234");
    await page.fill("#cpn", "Newpass12");
    await page.fill("#cpn2", "Newpass12");
    await page.click("#cpgo");
    await expect(page.locator("#who")).toContainText("dana");
  });

  test("mismatched new passwords are rejected client-side (no dead-end)", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "dana");
    await page.click("#out");
    await login(page, server.base, "dana", "Temp1234");
    await page.fill("#cpc", "Temp1234");
    await page.fill("#cpn", "Newpass12");
    await page.fill("#cpn2", "Different99");
    await page.click("#cpgo");
    await expect(page.locator("#msg")).toContainText("don't match");
    await expect(page.locator("#cpc")).toBeVisible(); // still on the change screen
  });
});

// ---- MFA (A2 + enable/disable/login-second-factor) ---------------------------------------------

test.describe("MFA (two-factor)", () => {
  async function enableMfa(page: Page): Promise<string> {
    await page.click("#mfaen");
    const secret = (await page.locator("#mfaenroll .token").first().innerText()).trim();
    await page.fill("#mfaconf", totp(secret));
    await page.click("#mfaconfgo");
    await expect(page.locator("#mfa")).toContainText("ENABLED");
    return secret;
  }

  test("A2: enabling MFA reflects ENABLED (not the stale disabled panel) + shows recovery codes", async ({ page }) => {
    await loginAdmin(page);
    await enableMfa(page);
    await expect(page.locator("#mfadis")).toBeVisible();
    await expect(page.locator("#mfa")).toContainText("recovery codes");
    expect(await page.locator("#mfa .token").count()).toBeGreaterThan(0);
  });

  test("a wrong confirm code is rejected and MFA stays disabled", async ({ page }) => {
    await loginAdmin(page);
    await page.click("#mfaen");
    await expect(page.locator("#mfaenroll .token")).toBeVisible();
    await page.fill("#mfaconf", "000000");
    await page.click("#mfaconfgo");
    await expect(page.locator("#msg")).toContainText("Confirm failed");
    await expect(page.locator("#mfaen")).toBeVisible(); // still offering to enable
  });

  test("enabled MFA is required at the next login (second-factor field), and the code lets you in", async ({ page }) => {
    await loginAdmin(page);
    const secret = await enableMfa(page);
    await page.click("#out");
    await login(page, server.base, "admin", "admin"); // password alone
    await expect(page.locator("#mfarow")).toBeVisible(); // second-factor field revealed
    await expect(page.locator("#msg")).toContainText("authenticator code");
    await page.fill("#mfa", totp(secret));
    await page.click("#go");
    await expect(page.locator("#who")).toContainText("admin");
  });

  test("MFA can be disabled with a current code, returning the panel to 'Enable'", async ({ page }) => {
    await loginAdmin(page);
    const secret = await enableMfa(page);
    await page.fill("#mfaoff", totp(secret));
    await page.click("#mfadis");
    await expect(page.locator("#msg")).toContainText("MFA disabled");
    await expect(page.locator("#mfaen")).toBeVisible();
  });
});

// ---- My vaults & sharing ------------------------------------------------------------------------

test.describe("my vaults & sharing", () => {
  test("share create then revoke round-trips in the grants table", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "carol");            // so carol is a known grantee (fuzzy-check passes)
    await page.reload();                           // re-fetch the known-usernames list so carol is in it
    await expect(page.locator("#vaults")).toBeVisible();
    await page.fill('[data-g="default"]', "carol");
    await page.selectOption('[data-perm="default"]', "readWrite");
    await page.click('[data-share="default"]');
    await expect(page.locator("#vaults")).toContainText("carol");
    await expect(page.locator('[data-revoke="default|carol"]')).toBeVisible();
    await page.click('[data-revoke="default|carol"]');
    await expect(page.locator("#msg")).toContainText("Share revoked");
    await expect(page.locator('[data-revoke="default|carol"]')).toHaveCount(0);
  });

  test("sharing to an unknown username is blocked client-side with a suggestion", async ({ page }) => {
    await loginAdmin(page);
    await page.fill('[data-g="default"]', "nosuchuser");
    await page.click('[data-share="default"]');
    await expect(page.locator("#msg")).toContainText("No account");
  });

  test("A5: a healthy (ready) vault shows an OK chip and NO Repair button", async ({ page }) => {
    await loginAdmin(page);
    await expect(page.locator("#vaults")).toContainText("OK");
    await expect(page.locator('[data-reindex="default"]')).toHaveCount(0); // ready ⇒ no repair offered
  });

  test("own-vault delete needs a typed confirmation and then the vault is gone", async ({ page }) => {
    await loginAdmin(page);
    // confirm() then prompt(vault-name): accept both, typing the name for the prompt.
    page.on("dialog", async (d) => { await d.accept(d.type() === "prompt" ? "default" : ""); });
    await page.click('[data-delvault="default"]');
    await expect(page.locator("#msg")).toContainText("Vault deleted");
    await expect(page.locator("#vaults")).toContainText("You own no vaults yet");
  });
});

// ---- Accounts (admin) ---------------------------------------------------------------------------

test.describe("accounts (admin)", () => {
  test("create then delete an account round-trips in the list", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "erin");
    await expect(page.locator("#users")).toContainText("erin");
    page.on("dialog", (d) => d.accept()); // the delete confirm
    await page.click('[data-del="erin"]');
    await expect(page.locator("#msg")).toContainText("Account deleted");
    await expect(page.locator('[data-del="erin"]')).toHaveCount(0);
  });

  test("make-admin / revoke-admin toggles the admin badge", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "frank");
    await page.click('[data-admin="frank"]');
    await expect(page.locator("#msg")).toContainText("Admin granted");
    await expect(page.locator("#users")).toContainText("admin"); // frank now badged
    await page.click('[data-admin="frank"]'); // now "Revoke admin"
    await expect(page.locator("#msg")).toContainText("Admin revoked");
  });

  test("operator password reset prompts and reports success", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "gwen");
    page.on("dialog", (d) => d.accept("Reset123")); // the new-password prompt
    await page.click('[data-resetpw="gwen"]');
    await expect(page.locator("#msg")).toContainText("Password reset for gwen");
  });

  test("expanding an account's vaults lazy-loads its sub-row", async ({ page }) => {
    await loginAdmin(page);
    await createAccount(page, "heidi");
    await page.click('[data-vaults="heidi"]');
    const sub = page.locator('.uvrow[data-uvfor="heidi"]');
    await expect(sub).toBeVisible();
    await expect(sub).toContainText("No vaults"); // a fresh account owns none
    await page.click('[data-vaults="heidi"]'); // collapse
    await expect(sub).toBeHidden();
  });
});

// ---- Registration + invites --------------------------------------------------------------------

test.describe("registration + invites", () => {
  test("registration toggle round-trips and persists across a reload", async ({ page }) => {
    await loginAdmin(page);
    await expect(page.locator("#reg")).toContainText("CLOSED");
    await page.click("#regtoggle");
    await expect(page.locator("#reg")).toContainText("OPEN");
    await expect(page.locator("#msg")).toContainText("opened");
    await page.reload();
    await expect(page.locator("#reg")).toContainText("OPEN");
  });

  test("create an invite (token shown once + listed), then revoke it", async ({ page }) => {
    await loginAdmin(page);
    await page.fill("#il", "for dana");
    await page.click("#addi");
    await expect(page.locator("#newtok .token")).toBeVisible(); // one-time token displayed
    await expect(page.locator("#invites")).toContainText("for dana");
    await page.click("[data-inv]");
    await expect(page.locator("#msg")).toContainText("Invite revoked");
    await expect(page.locator("#invites")).toContainText("No outstanding invites");
  });
});
