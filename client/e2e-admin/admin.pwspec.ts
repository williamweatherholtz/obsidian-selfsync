// Real-browser (Chromium) functional tests for the admin web page. Each drives the page's ACTUAL
// click-handlers against a freshly-spawned server, confirming the control's on-screen effect — the
// coverage the server-side reqwest tests can't give (they test endpoints, not the page's JS wiring).
// Several of the 9 audit-fixed defects are exercised here end-to-end (A1 sign-out, A2 MFA, A3 forced-change).
import { test, expect, Page } from "@playwright/test";
import { startServer, canRun, totp, RunningServer } from "./helpers";

test.skip(!canRun, "server binary not built — run `cargo build` in server/ first");

let server: RunningServer;
// A fresh server per test: flows mutate account state (create users, enable MFA on admin), so isolation
// keeps each test independent and order-free.
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server?.stop(); });

async function login(page: Page, base: string, user: string, pass: string) {
  await page.goto(`${base}/admin`);
  await page.fill("#u", user);
  await page.fill("#p", pass);
  await page.click("#go");
}

test("login as admin renders the dashboard with the server-admin badge", async ({ page }) => {
  await login(page, server.base, "admin", "admin");
  await expect(page.locator("#who")).toContainText("signed in as");
  await expect(page.locator("#who")).toContainText("admin");
  await expect(page.locator(".badge")).toHaveText("server-admin");
  await expect(page.locator("#users")).toBeVisible(); // the admin-only Accounts panel rendered
});

test("A3: a must-change account gets the forced-change screen and can then sign in", async ({ page }) => {
  await login(page, server.base, "admin", "admin");
  await expect(page.locator("#users")).toBeVisible();
  // admin creates "dana" (flagged must-change).
  await page.fill("#nu", "dana");
  await page.fill("#np", "Temp1234");
  await page.click("#addu");
  await expect(page.locator("#msg")).toContainText("Account created");
  // sign out, then log in as dana → the forced-change screen appears (was: a silent bounce to login).
  await page.click("#out");
  await expect(page.locator("#go")).toBeVisible();
  await login(page, server.base, "dana", "Temp1234");
  await expect(page.locator("#cpc")).toBeVisible(); // "Set a new password"
  await page.fill("#cpc", "Temp1234");
  await page.fill("#cpn", "Newpass12");
  await page.fill("#cpn2", "Newpass12");
  await page.click("#cpgo");
  await expect(page.locator("#who")).toContainText("dana"); // fully signed in on the new password
});

test("A1: sign out revokes the server session (POST /api/logout) and returns to login", async ({ page }) => {
  await login(page, server.base, "admin", "admin");
  await expect(page.locator("#who")).toContainText("admin");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/logout") && r.request().method() === "POST"),
    page.click("#out"),
  ]);
  expect(resp.status()).toBe(200);                 // the token was actually revoked server-side
  await expect(page.locator("#go")).toBeVisible();  // back at the login form
});

test("A2: enabling MFA reflects the ENABLED state (not a stale 'disabled' panel) and shows recovery codes", async ({ page }) => {
  await login(page, server.base, "admin", "admin");
  await page.click("#mfaen");
  const secret = (await page.locator("#mfaenroll .token").first().innerText()).trim();
  await page.fill("#mfaconf", totp(secret));
  await page.click("#mfaconfgo");
  // The fix: the panel re-reads status → ENABLED + the disable control, AND keeps the one-time codes.
  await expect(page.locator("#mfa")).toContainText("ENABLED");
  await expect(page.locator("#mfadis")).toBeVisible();
  await expect(page.locator("#mfa")).toContainText("recovery codes");
  expect(await page.locator("#mfa .token").count()).toBeGreaterThan(0);
});

test("registration toggle round-trips and persists across a reload", async ({ page }) => {
  await login(page, server.base, "admin", "admin");
  await expect(page.locator("#reg")).toContainText("CLOSED"); // default
  await page.click("#regtoggle");
  await expect(page.locator("#reg")).toContainText("OPEN");
  await expect(page.locator("#msg")).toContainText("opened");
  await page.reload();
  await expect(page.locator("#reg")).toContainText("OPEN"); // persisted server-side, re-read on load
});
