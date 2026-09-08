// Functions that run INSIDE Obsidian's renderer via page.evaluate(), against the real `app` object.
//
// SERIALIZATION RULE — read before editing: page.evaluate ships a function's SOURCE TEXT to the
// renderer and calls it there. Anything a function references from this module's outer scope does
// not travel with it and throws a ReferenceError in the renderer. So every exported function below is
// self-contained: it reaches the plugin registry through `globalThis` and imports nothing at runtime
// (the `import type` is erased by the compiler).
//
// Original SelfSync work, written against Obsidian's documented runtime shape
// (app.plugins.enablePlugin / enabledPlugins / plugins); it shares no code with any other project.
import type { App } from "obsidian";

/** The slice of Obsidian's undocumented-but-stable plugin registry these helpers rely on. */
export interface PluginRegistry {
  /** Ids of plugins the user has switched on. */
  enabledPlugins: Set<string>;
  /** Switch a community plugin on; resolves once Obsidian has constructed and loaded it. */
  enablePlugin(id: string): Promise<void>;
  /** Live plugin instances keyed by id — present only once a plugin has actually loaded. */
  plugins: Record<string, unknown>;
}

// Kept as a type-only shape so callers can type the renderer-side `app` without a global declaration.
export type RendererApp = App & { plugins: PluginRegistry };

/** Enable a plugin by id. Runs in the renderer. */
export async function enablePlugin(id: string): Promise<void> {
  const registry = (globalThis as unknown as { app: RendererApp }).app.plugins;
  await registry.enablePlugin(id);
}

/** Whether the user has the plugin switched ON (it may not have finished loading yet). Renderer-side. */
export function isPluginEnabled(id: string): boolean {
  const registry = (globalThis as unknown as { app: RendererApp }).app.plugins;
  return registry.enabledPlugins.has(id);
}

/** Whether the plugin's instance actually EXISTS — constructed and registered, not merely enabled. Renderer-side. */
export function isPluginLoaded(id: string): boolean {
  const registry = (globalThis as unknown as { app: RendererApp }).app.plugins;
  return Object.prototype.hasOwnProperty.call(registry.plugins, id) && registry.plugins[id] != null;
}
