// Test-only stub for the "obsidian" module (aliased in vitest.config.ts). Provides just the
// surface main.ts + its imported modules touch, so the plugin can be instantiated and its wiring
// exercised without the Obsidian runtime. Not used by the production build (esbuild keeps
// "obsidian" external).

// A fake DOM element that no-ops the chainable calls renderLight / settings perform.
export function fakeEl(): any {
  const e: any = { style: {}, isConnected: true };
  e.empty = () => e; e.createSpan = () => fakeEl(); e.createEl = () => fakeEl();
  e.setAttribute = () => e; e.setAttr = () => e; e.setText = () => e;
  e.addClass = () => e; e.removeClass = () => e; e.onClickEvent = () => e;
  e.addEventListener = () => {}; e.remove = () => {};
  return e;
}

export class Plugin {
  app: any; manifest: any; private _data: any = null;
  constructor(app: any, manifest: any) { this.app = app; this.manifest = manifest; }
  addSettingTab() {} addRibbonIcon() { return fakeEl(); } addStatusBarItem() { return fakeEl(); }
  addCommand() {} registerEvent() {}
  async loadData() { return this._data; } async saveData(d: any) { this._data = d; }
}
export class Notice { constructor(_m?: string) {} }
export class Modal { app: any; contentEl = fakeEl(); constructor(app: any) { this.app = app; } open() {} close() {} }
export class PluginSettingTab { app: any; plugin: any; containerEl = fakeEl(); constructor(app: any, plugin: any) { this.app = app; this.plugin = plugin; } }
export class Setting {
  constructor(_c?: any) {}
  setName() { return this; } setDesc() { return this; } setHeading() { return this; } setClass() { return this; }
  addButton() { return this; } addToggle() { return this; } addDropdown() { return this; } addText() { return this; }
}
export class TAbstractFile { path = ""; }
export class TFile extends TAbstractFile { stat = { size: 0, mtime: 0, ctime: 0 }; }
export class MarkdownView { addAction() { return fakeEl(); } }
export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: true, isLinux: false, isPhone: false };
export const normalizePath = (p: string) => p;
export const setIcon = () => {};
export const requestUrl = async () => ({ status: 200, json: {}, arrayBuffer: new ArrayBuffer(0) });
