import { describe, expect, test } from "bun:test";
import { formatRgb, parseRgbOutput } from "../src/rgb";

describe("rgb", () => {
  test("parses final state and failed steps", () => {
    const out = "omarchy-rgb-switch: OpenRGB target 0: Aura [motherboard] -> #000000\nomarchy-rgb-switch: Kraken LCD brightness off command failed\nlights=off\n";
    expect(parseRgbOutput(out)).toEqual({ state: "off", failures: ["Kraken LCD brightness off command failed"] });
  });
  test("no final state is an error", () => {
    expect(formatRgb(parseRgbOutput("garbage"), 3)).toContain("❌");
  });
  test("formats on/off with time and failures", () => {
    expect(formatRgb({ state: "on", failures: [] }, 12)).toBe("💡 **Rig lights ON** (white) · 12s");
    const t = formatRgb({ state: "off", failures: ["a failed", "b failed"] }, 5);
    expect(t).toContain("🌑 **Rig lights OFF**");
    expect(t).toContain("⚠️ 2 step(s) failed");
  });
});
