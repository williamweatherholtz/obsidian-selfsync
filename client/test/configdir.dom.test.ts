// @vitest-environment happy-dom
// Real-DOM tests for ConfigDirectionModal (src/configdir.ts) — the first-contact config-sync
// direction prompt. onChoose must fire only on a real pick; a read-only vault must never offer
// upload; a dismissal must route to onCancel (leaving onChoose untouched so the caller can revert).
import { describe, it, expect, vi } from "vitest";
import { ConfigDirectionModal } from "../src/configdir";
import { makeApp, buttonByText } from "./ui-dom-harness";

describe("ConfigDirectionModal", () => {
  it("readOnly=false offers both directions; picking download calls onChoose('download')", () => {
    const onChoose = vi.fn(); const onCancel = vi.fn();
    const m = new ConfigDirectionModal(makeApp(), ".obsidian", false, onChoose, onCancel);
    m.onOpen();
    expect(buttonByText(m.contentEl, "Use the synced version")).toBeTruthy();
    expect(buttonByText(m.contentEl, "Use this device's")).toBeTruthy();
    buttonByText(m.contentEl, "Use the synced version").click();
    expect(onChoose).toHaveBeenCalledWith("download");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("picking upload calls onChoose('upload')", () => {
    const onChoose = vi.fn();
    const m = new ConfigDirectionModal(makeApp(), ".obsidian", false, onChoose);
    m.onOpen();
    buttonByText(m.contentEl, "Use this device's").click();
    expect(onChoose).toHaveBeenCalledWith("upload");
  });

  it("readOnly=true offers ONLY download and shows the read-only note", () => {
    const onChoose = vi.fn();
    const m = new ConfigDirectionModal(makeApp(), ".obsidian", true, onChoose);
    m.onOpen();
    expect(buttonByText(m.contentEl, "Use the synced version")).toBeTruthy();
    expect(buttonByText(m.contentEl, "Use this device's")).toBeFalsy();
    expect(m.contentEl.textContent).toContain("read-only shared vault");
  });

  it("dismissing without picking calls onCancel and never onChoose", () => {
    const onChoose = vi.fn(); const onCancel = vi.fn();
    const m = new ConfigDirectionModal(makeApp(), ".obsidian", false, onChoose, onCancel);
    m.onOpen();
    // Simulate the user dismissing the dialog (Esc / click-away): onClose fires with no pick made.
    m.onClose();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
