// Test-only stub for the "obsidian" module (aliased in vitest.config.ts). Two modes, chosen at load
// by whether a DOM is present:
//  - node env (no `document`): a no-op chainable surface — enough to instantiate the plugin and
//    exercise orchestration wiring (plugin-wiring.test.ts etc.). Unchanged behavior.
//  - happy-dom env (`document` present): a REAL-DOM implementation of the Setting/SettingGroup/Modal
//    surface, so the settings tab and modals actually render and their controls dispatch real events —
//    what the *.dom.test.ts suites assert against.
// Production builds never use this (esbuild keeps "obsidian" external).

const HAS_DOM = typeof document !== "undefined";

// Add Obsidian's HTMLElement augmentations (createEl/createSpan/empty/setText/…) to a real element.
function augment(el: any): any {
  if (!el || el.__aug) return el;
  el.__aug = true;
  const mk = (tag: string, opts?: { text?: string; cls?: string }) => {
    const child = augment(document.createElement(tag));
    if (opts?.text) child.textContent = opts.text;
    if (opts?.cls) child.classList.add(...String(opts.cls).split(/\s+/).filter(Boolean));
    el.appendChild(child);
    return child;
  };
  el.createEl = (tag: string, opts?: any) => mk(tag, opts);
  el.createDiv = (opts?: any) => mk("div", opts);
  el.createSpan = (opts?: any) => mk("span", opts);
  el.empty = () => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  el.setText = (t: string) => { el.textContent = t; return el; };
  el.appendText = (t: string) => { el.appendChild(document.createTextNode(t)); return el; };
  el.setAttr = (k: string, v: any) => { el.setAttribute(k, String(v)); return el; };
  el.addClass = (...c: string[]) => { el.classList.add(...c); return el; };
  el.removeClass = (...c: string[]) => { el.classList.remove(...c); return el; };
  el.toggleClass = (c: string, on?: boolean) => { el.classList.toggle(c, on); return el; };
  el.onClickEvent = (cb: any) => { el.addEventListener("click", cb); return el; };
  return el;
}

// A fresh element: a real (augmented) div under happy-dom, else the no-op chainable object.
export function fakeEl(): any {
  if (HAS_DOM) return augment(document.createElement("div"));
  const e: any = { style: {}, isConnected: true };
  e.empty = () => e; e.createSpan = () => fakeEl(); e.createEl = () => fakeEl(); e.createDiv = () => fakeEl();
  e.setAttribute = () => e; e.setAttr = () => e; e.setText = () => e; e.appendText = () => e;
  e.addClass = () => e; e.removeClass = () => e; e.toggleClass = () => e; e.onClickEvent = () => e;
  e.addEventListener = () => {}; e.remove = () => {};
  return e;
}

// ---- Setting sub-components (real form controls under happy-dom) --------------------------------

class ToggleComponent {
  toggleEl: any = fakeEl();
  constructor(parent: any) {
    if (HAS_DOM) { this.toggleEl = augment(document.createElement("input")); this.toggleEl.type = "checkbox"; this.toggleEl.classList.add("checkbox-container"); parent.appendChild(this.toggleEl); }
  }
  setValue(v: boolean) { if (HAS_DOM) this.toggleEl.checked = v; return this; }
  getValue() { return HAS_DOM ? !!this.toggleEl.checked : false; }
  setDisabled(_d: boolean) { return this; }
  setTooltip() { return this; }
  onChange(cb: (v: boolean) => any) { if (HAS_DOM) this.toggleEl.addEventListener("change", () => cb(this.toggleEl.checked)); return this; }
}
class ButtonComponent {
  buttonEl: any = fakeEl();
  constructor(parent: any) { if (HAS_DOM) { this.buttonEl = augment(document.createElement("button")); parent.appendChild(this.buttonEl); } }
  setButtonText(t: string) { if (HAS_DOM) this.buttonEl.textContent = t; return this; }
  setCta() { if (HAS_DOM) this.buttonEl.classList.add("mod-cta"); return this; }
  setWarning() { if (HAS_DOM) this.buttonEl.classList.add("mod-warning"); return this; }
  setIcon() { return this; }
  setDisabled(_d: boolean) { return this; }
  setTooltip() { return this; }
  onClick(cb: () => any) { if (HAS_DOM) this.buttonEl.addEventListener("click", cb); return this; }
}
class TextComponent {
  inputEl: any = fakeEl();
  constructor(parent: any) { if (HAS_DOM) { this.inputEl = augment(document.createElement("input")); this.inputEl.type = "text"; parent.appendChild(this.inputEl); } }
  setValue(v: string) { if (HAS_DOM) this.inputEl.value = v; return this; }
  getValue() { return HAS_DOM ? this.inputEl.value : ""; }
  setPlaceholder(p: string) { if (HAS_DOM) this.inputEl.placeholder = p; return this; }
  setDisabled(_d: boolean) { return this; }
  onChange(cb: (v: string) => any) { if (HAS_DOM) this.inputEl.addEventListener("input", () => cb(this.inputEl.value)); return this; }
}
class DropdownComponent {
  selectEl: any = fakeEl();
  constructor(parent: any) { if (HAS_DOM) { this.selectEl = augment(document.createElement("select")); parent.appendChild(this.selectEl); } }
  addOption(value: string, display: string) { if (HAS_DOM) { const o = document.createElement("option"); o.value = value; o.textContent = display; this.selectEl.appendChild(o); } return this; }
  setValue(v: string) { if (HAS_DOM) this.selectEl.value = v; return this; }
  getValue() { return HAS_DOM ? this.selectEl.value : ""; }
  onChange(cb: (v: string) => any) { if (HAS_DOM) this.selectEl.addEventListener("change", () => cb(this.selectEl.value)); return this; }
}

export class Setting {
  settingEl: any; nameEl: any; descEl: any; controlEl: any;
  constructor(containerEl?: any) {
    if (HAS_DOM && containerEl?.createEl) {
      this.settingEl = containerEl.createEl("div", { cls: "setting-item" });
      const info = this.settingEl.createEl("div", { cls: "setting-item-info" });
      this.nameEl = info.createEl("div", { cls: "setting-item-name" });
      this.descEl = info.createEl("div", { cls: "setting-item-description" });
      this.controlEl = this.settingEl.createEl("div", { cls: "setting-item-control" });
    } else {
      this.settingEl = this.nameEl = this.descEl = this.controlEl = fakeEl();
    }
  }
  setName(t: string) { this.nameEl.setText?.(t); return this; }
  setDesc(t: string) { this.descEl.setText?.(t); return this; }
  setHeading() { this.settingEl.addClass?.("setting-item-heading"); return this; }
  setClass(c: string) { this.settingEl.addClass?.(c); return this; }
  addToggle(cb: (t: ToggleComponent) => any) { cb(new ToggleComponent(this.controlEl)); return this; }
  addButton(cb: (b: ButtonComponent) => any) { cb(new ButtonComponent(this.controlEl)); return this; }
  addText(cb: (t: TextComponent) => any) { cb(new TextComponent(this.controlEl)); return this; }
  addDropdown(cb: (d: DropdownComponent) => any) { cb(new DropdownComponent(this.controlEl)); return this; }
}

export class SettingGroup {
  containerEl: any; headingEl: any; listEl: any;
  constructor(containerEl?: any) {
    if (HAS_DOM && containerEl?.createEl) {
      this.containerEl = containerEl.createEl("div", { cls: "setting-group" });
      this.headingEl = this.containerEl.createEl("div", { cls: "setting-group-heading" });
      this.listEl = this.containerEl.createEl("div", { cls: "setting-group-list" });
    } else {
      this.containerEl = this.headingEl = this.listEl = fakeEl();
    }
  }
  setHeading(t: string) { this.headingEl.setText?.(t); return this; }
  addClass(...c: string[]) { this.containerEl.addClass?.(...c); return this; }
  addSetting(cb: (s: Setting) => void) { cb(new Setting(this.listEl)); return this; }
  addSearch() { return this; }
  addExtraButton() { return this; }
}

export class Plugin {
  app: any; manifest: any; _data: any = null;
  constructor(app: any, manifest: any) { this.app = app; this.manifest = manifest; }
  addSettingTab() {} addRibbonIcon() { return fakeEl(); } addStatusBarItem() { return fakeEl(); }
  addCommand() {} registerEvent() {}
  async loadData() { return this._data; } async saveData(d: any) { this._data = d; }
}
export class Notice { constructor(_m?: string) {} }
export class Modal {
  app: any; titleEl = fakeEl(); contentEl = fakeEl(); closed = false;
  constructor(app: any) { this.app = app; }
  open() {} close() { this.closed = true; }
  onOpen() {} onClose() {}
}
export class PluginSettingTab {
  app: any; plugin: any; containerEl = fakeEl();
  constructor(app: any, plugin: any) { this.app = app; this.plugin = plugin; }
  display() {} hide() {}
}
export class TAbstractFile { path = ""; }
export class TFile extends TAbstractFile { stat = { size: 0, mtime: 0, ctime: 0 }; }
export class MarkdownView { addAction() { return fakeEl(); } }
export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: true, isLinux: false, isPhone: false };
export const normalizePath = (p: string) => p;
export const setIcon = () => {};
export const requestUrl = async () => ({ status: 200, json: {}, arrayBuffer: new ArrayBuffer(0) });
