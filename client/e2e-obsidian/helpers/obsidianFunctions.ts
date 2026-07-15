// Functions evaluated INSIDE the Obsidian renderer (via page.evaluate) — they run against the real
// window.app, so they exercise Obsidian's genuine plugin registry, not a stub. Ported from
// origin/test_real_obsidian. Kept in their own module (no imports) so page.evaluate can serialize them.
import type { App } from "obsidian";

declare global {
  // eslint-disable-next-line no-var
  var app: App & {
    plugins: {
      enabledPlugins: Set<string>;
      enablePlugin: (name: string) => Promise<void>;
      plugins: Record<string, unknown>;
    };
  };
}

export const enablePlugin = async (pluginName: string): Promise<void> => {
  await window.app.plugins.enablePlugin(pluginName);
};

export const isPluginEnabled = (pluginName: string): boolean =>
  window.app.plugins.enabledPlugins.has(pluginName);

// True once the plugin's instance is actually constructed/registered (loaded), not merely enabled.
export const isPluginLoaded = (pluginName: string): boolean =>
  Boolean(window.app.plugins.plugins[pluginName]);
