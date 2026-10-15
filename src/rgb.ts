/**
 * Owner 2026-10-15: /rgb toggles all rig lights; /rgb state:on|off sets them. It runs the existing
 * ~/.local/bin/omarchy-rgb-switch (OpenRGB + liquidctl lighting only; no fans, pumps or BIOS settings).
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
export const RGB_SWITCH = process.env.OMP_BOT_RGB_SWITCH ?? join(homedir(), ".local", "bin", "omarchy-rgb-switch");
export type RgbMode = "on" | "off" | "toggle";

/** Script output → final state and the device steps that reported a failure. */
export function parseRgbOutput(out: string): { state: "on" | "off" | null; failures: string[] } {
  const state = out.match(/^lights=(on|off)$/m)?.[1] as "on" | "off" | undefined;
  const failures = out
    .split("\n")
    // Only the script's own step lines: OpenRGB prints an HTML I2C warning that is not a failed step.
    .filter((l) => l.startsWith("omarchy-rgb-switch:") && /failed/i.test(l))
    .map((l) => l.replace(/^omarchy-rgb-switch:\s*/, "").trim());
  return { state: state ?? null, failures };
}

export function formatRgb(r: { state: "on" | "off" | null; failures: string[] }, secs: number): string {
  if (!r.state) return "❌ **RGB:** the switch script did not report a final state.";
  const head = r.state === "on" ? `💡 **Rig lights ON** (white) · ${secs}s` : `🌑 **Rig lights OFF** · ${secs}s`;
  if (!r.failures.length) return head;
  return [head, `⚠️ ${r.failures.length} step(s) failed:`, ...r.failures.slice(0, 6).map((f) => `• ${f}`)].join("\n");
}

let busy = false;
export async function setRgb(mode: RgbMode): Promise<string> {
  if (busy) return "⏳ **RGB:** a light change is already running. Try again in a moment.";
  busy = true;
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await run(RGB_SWITCH, [mode], { timeout: 420_000, maxBuffer: 1024 * 1024 });
    return formatRgb(parseRgbOutput(`${stdout}\n${stderr}`), Math.round((Date.now() - t0) / 1000));
  } finally {
    busy = false;
  }
}
