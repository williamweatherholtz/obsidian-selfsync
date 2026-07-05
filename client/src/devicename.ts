// Pure device-name helpers, extracted from the plugin so the fiddly parsing (the source of the
// "linuxarch instead of Pixel 9" bug) is unit-testable without the Obsidian runtime. The
// Platform.* fallbacks stay in main.ts; this owns the string work.

// Sanitize a raw device/model string: keep alphanumerics + spaces, collapse whitespace, cap length.
export function cleanDeviceName(s: string): string {
  return s.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
}

// Extract the Android device model from a user-agent string, or null when it isn't an Android UA
// or the model is unusable. Android exposes the model (e.g. "Pixel 9"); recent Chrome may FREEZE
// it to "K" for privacy → treated as unusable so the caller falls back to a platform label. A
// desktop UA (no "Android" token) returns null, so it never yields a bogus name like "linuxarch".
export function androidModelFromUA(ua: string): string | null {
  const m = ua.match(/Android[^;]*;\s*([^;)]+?)\s*(?:Build\/|\))/i);
  if (!m || !m[1]) return null;
  const model = cleanDeviceName(m[1]);
  if (model.length <= 2 || model.toUpperCase() === "K") return null;
  return model;
}
