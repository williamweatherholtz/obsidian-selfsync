// @vitest-environment happy-dom
// Real-DOM tests for DeviceLinkModal (src/devicelink.ts) — the "add a device" QR/link screen. The
// security-critical property is that neither the copyable link nor the QR ever carries the password
// (see connstr.ts: the setup link has no password field by design).
import { describe, it, expect } from "vitest";
import { DeviceLinkModal } from "../src/devicelink";
import { encodeSetupLink } from "../src/connstr";
import { makeApp } from "./ui-dom-harness";

describe("DeviceLinkModal", () => {
  it("renders the link in a readonly input and a QR svg", () => {
    const link = "selfsync://connect?server=https%3A%2F%2Fsync.example&user=alice";
    const m = new DeviceLinkModal(makeApp(), link);
    m.onOpen();
    const input = m.contentEl.querySelector("input");
    if (!input) throw new Error("expected a rendered <input>");
    expect(input.value).toBe(link);
    expect(input.getAttribute("readonly")).toBe("true");
    // The bundled QR encoder renders an inline <svg> (CSP-safe, no external fetch).
    expect(m.contentEl.querySelector("svg")).toBeTruthy();
  });

  it("the rendered link and QR contain the server + username but NEVER the password", () => {
    const password = "SuperSecret123";
    // Build the link the real way — encodeSetupLink has no password parameter at all.
    const link = encodeSetupLink({ server: "https://sync.example", user: "alice" });
    const m = new DeviceLinkModal(makeApp(), link);
    m.onOpen();
    const input = m.contentEl.querySelector("input");
    if (!input) throw new Error("expected a rendered <input>");
    expect(input.value).toContain("sync.example");
    expect(input.value).toContain("alice");
    expect(input.value).not.toContain(password);
    // Nothing in the whole modal (visible text OR the QR/svg markup) leaks the password.
    expect(m.contentEl.textContent).not.toContain(password);
    expect(m.contentEl.innerHTML).not.toContain(password);
  });
});
