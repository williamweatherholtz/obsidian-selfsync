// @vitest-environment happy-dom
// Real-DOM test for the Push/Pull PREVIEW modal — proves it shows WHAT changes + the endpoints, lazy-loads
// a diff, and its Confirm/Cancel actually resolve. Directly targets the owner's ask: "what are we pushing
// to / from, and what is it overwriting."
import { describe, it, expect, vi } from "vitest";
import { PushPreviewModal } from "../src/pushpreviewmodal";
import { PluginPushPreview } from "../src/pushpreview";
import { fakePlugin, buttonByText, flush } from "./ui-dom-harness";

function preview(over: Partial<PluginPushPreview> = {}): PluginPushPreview {
  return {
    direction: "push",
    name: "Dataview",
    fromLabel: "this device (Laptop)",
    toLabel: "the server + your other devices",
    changes: [
      { path: ".obsidian/plugins/dataview/data.json", op: "overwrite" },
      { path: ".obsidian/plugins/dataview/newfile.json", op: "create" },
      { path: ".obsidian/plugins/dataview/gone.css", op: "delete" },
      { path: ".obsidian/plugins/dataview/styles.css", op: "unchanged" },
    ],
    loadDiff: vi.fn(async () => [{ type: "del" as const, text: '"k": 1' }, { type: "add" as const, text: '"k": 2' }]),
    ...over,
  };
}

describe("PushPreviewModal", () => {
  it("states the endpoints (to/from) and a change summary that excludes unchanged", () => {
    const p = fakePlugin();
    const m = new PushPreviewModal(p.app, preview(), () => {});
    m.onOpen();
    const text = m.contentEl.textContent ?? "";
    expect(text).toContain("Overwrite the server + your other devices with this device (Laptop).");
    expect(text).toContain("3 files change"); // overwrite+create+delete, NOT the unchanged one
    expect(text).toMatch(/1 overwritten/);
    expect(text).toMatch(/1 added/);
    expect(text).toMatch(/1 removed/);
    expect(text).toContain("1 unchanged");
  });

  it("lists changed files by short path but hides the unchanged one", () => {
    const m = new PushPreviewModal(fakePlugin().app, preview(), () => {});
    m.onOpen();
    const t = m.contentEl.textContent ?? "";
    expect(t).toContain("data.json");
    expect(t).toContain("newfile.json");
    expect(t).toContain("gone.css");
    expect(t).not.toContain("styles.css"); // unchanged files aren't listed
  });

  it("Show diff lazy-loads the per-file diff and renders +/- lines", async () => {
    const pv = preview();
    const m = new PushPreviewModal(fakePlugin().app, pv, () => {});
    m.onOpen();
    const showDiff = Array.from(m.contentEl.querySelectorAll("a")).find((a) => a.textContent === "Show diff") as HTMLElement;
    expect(showDiff).toBeTruthy();
    showDiff.click();
    await flush();
    expect(pv.loadDiff).toHaveBeenCalled();
    const t = m.contentEl.textContent ?? "";
    expect(t).toContain('- "k": 1');
    expect(t).toContain('+ "k": 2');
  });

  it("Confirm resolves true, Cancel/dismiss resolves false", async () => {
    const ok = vi.fn();
    const m = new PushPreviewModal(fakePlugin().app, preview(), ok);
    m.onOpen();
    buttonByText(m.contentEl, "Push").click();
    expect(ok).toHaveBeenCalledWith(true);

    const no = vi.fn();
    const m2 = new PushPreviewModal(fakePlugin().app, preview(), no);
    m2.onOpen();
    buttonByText(m2.contentEl, "Cancel").click();
    m2.onClose(); // dismissal path
    expect(no).toHaveBeenCalledWith(false);
  });

  it("an already-in-sync folder says so and offers nothing to confirm", () => {
    const insync = preview({ changes: [{ path: ".obsidian/plugins/dataview/data.json", op: "unchanged" }] });
    const m = new PushPreviewModal(fakePlugin().app, insync, () => {});
    m.onOpen();
    expect(m.contentEl.textContent ?? "").toContain("Already in sync");
  });
});
