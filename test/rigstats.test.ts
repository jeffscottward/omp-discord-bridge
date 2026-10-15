import { describe, expect, test } from "bun:test";
import { bar, cpuBusyPct, formatGpu, formatMem, parseGpuLine, parseMeminfo, procCpuShare, progName, topByName } from "../src/rigstats";

describe("rigstats parsers", () => {
  test("cpuBusyPct: busy share between two /proc/stat lines", () => {
    // user nice system idle iowait irq softirq
    const a = "cpu  100 0 100 800 0 0 0";
    const b = "cpu  150 0 150 900 0 0 0"; // +100 busy, +100 idle
    expect(cpuBusyPct(a, b)).toBe(50);
    expect(cpuBusyPct(a, a)).toBe(0);
  });

  test("parseMeminfo: used = total - available", () => {
    const m = parseMeminfo("MemTotal:  16777216 kB\nMemFree: 1048576 kB\nMemAvailable:  8388608 kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n");
    expect(m.totalMiB).toBe(16384);
    expect(m.usedMiB).toBe(8192);
    expect(m.swapUsedMiB).toBe(1024);
  });

  test("parseGpuLine: nvidia-smi csv, nounits; [N/A] fan becomes null", () => {
    const g = parseGpuLine("NVIDIA GeForce RTX 3080 Ti, 12, 5225, 12288, 62, 113.97, 350.00, [N/A]");
    expect(g).toMatchObject({ utilPct: 12, memUsedMiB: 5225, memTotalMiB: 12288, tempC: 62, powerLimitW: 350, fanPct: null });
  });

  test("progName keeps only the program name (no arguments or paths)", () => {
    expect(progName("/opt/google/chrome/chrome --type=gpu-process --enable-crash-reporter=abc")).toBe("chrome");
  });

  test("topByName merges same-name processes and keeps the largest", () => {
    const t = topByName([{ name: "chrome", value: 2 }, { name: "omp", value: 3 }, { name: "chrome", value: 2 }, { name: "x", value: 1 }], 2);
    expect(t).toEqual([{ name: "chrome", value: 4 }, { name: "omp", value: 3 }]);
  });

  test("procCpuShare: process ticks over machine ticks in the same window; new processes skipped", () => {
    const a = new Map<string, [string, number]>([["1", ["omp", 100]], ["2", ["idle", 50]]]);
    const b = new Map<string, [string, number]>([["1", ["omp", 150]], ["2", ["idle", 50]], ["3", ["new", 999]]]);
    expect(procCpuShare(a, b, 1000)).toEqual([{ name: "omp", value: 5 }]);
  });
});

describe("rigstats formatters", () => {
  test("bar clamps and rounds", () => {
    expect(bar(0)).toBe("▱".repeat(10));
    expect(bar(100)).toBe("▰".repeat(10));
    expect(bar(150)).toBe("▰".repeat(10));
    expect(bar(NaN)).toBe("▱".repeat(10));
  });

  test("formatGpu warns about VRAM no process owns", () => {
    const base = { name: "GPU", utilPct: 0, memUsedMiB: 11000, memTotalMiB: 12288, tempC: 50, powerW: 30, powerLimitW: 350, fanPct: 30 };
    expect(formatGpu({ ...base, procs: [{ name: "sunshine", value: 300 }] })).toContain("not listed under any process");
    expect(formatGpu({ ...base, memUsedMiB: 1000, procs: [{ name: "sunshine", value: 300 }] })).not.toContain("not listed");
  });

  test("formatMem marks high use", () => {
    const m = { totalMiB: 1000, usedMiB: 950, availableMiB: 50, cacheMiB: 0, swapTotalMiB: 0, swapUsedMiB: 0, top: [] };
    expect(formatMem(m)).toContain("🔴");
    expect(formatMem(m)).not.toContain("Swap");
  });
});
