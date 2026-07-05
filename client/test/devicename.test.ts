import { describe, it, expect } from "vitest";
import { cleanDeviceName, androidModelFromUA } from "../src/devicename";

describe("androidModelFromUA", () => {
  it("extracts the model from a real Android UA (the 'Pixel 9' case)", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 9 Build/AD1A.240418.003) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
    expect(androidModelFromUA(ua)).toBe("Pixel 9");
  });
  it("handles the ')'-terminated model form (no Build/ token)", () => {
    const ua = "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/120.0 Mobile";
    expect(androidModelFromUA(ua)).toBe("SM G991B");
  });
  it("returns null for a frozen 'K' model (privacy-reduced UA) → caller falls back to a platform label", () => {
    const ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
    expect(androidModelFromUA(ua)).toBeNull();
  });
  it("returns null for a LINUX DESKTOP UA — never a bogus 'linuxarch'-style name (the reported bug)", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.5.0 Chrome/120.0 Electron/28.0 Safari/537.36";
    expect(androidModelFromUA(ua)).toBeNull();
  });
  it("returns null for a macOS / Windows desktop UA", () => {
    expect(androidModelFromUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) obsidian/1.5.0")).toBeNull();
    expect(androidModelFromUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) obsidian/1.5.0")).toBeNull();
  });
  it("returns null on an empty UA", () => expect(androidModelFromUA("")).toBeNull());
});

describe("cleanDeviceName", () => {
  it("strips punctuation, collapses whitespace, and caps length", () => {
    expect(cleanDeviceName("  Pixel_9 (Pro)!! ")).toBe("Pixel 9 Pro");
    expect(cleanDeviceName("x".repeat(40)).length).toBe(24);
  });
  it("returns empty for punctuation-only input (caller then uses a default)", () => {
    expect(cleanDeviceName("---")).toBe("");
  });
});
