/**
 * Owner 2026-10-15: /cpu, /gpu, /memory and /stats report the rig's current usage in Discord.
 * Collectors read /proc, /sys and nvidia-smi; formatters are pure so they can be tested.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cpus, hostname, loadavg, uptime } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Proc {
  name: string;
  value: number; // CPU % or MiB, depending on the list
}
export interface CpuStats {
  model: string;
  cores: number;
  usagePct: number;
  load: [number, number, number];
  tempC: number | null;
  top: Proc[];
}
export interface MemStats {
  totalMiB: number;
  usedMiB: number;
  availableMiB: number;
  cacheMiB: number;
  swapTotalMiB: number;
  swapUsedMiB: number;
  top: Proc[];
}
export interface GpuStats {
  name: string;
  utilPct: number;
  memUsedMiB: number;
  memTotalMiB: number;
  tempC: number;
  powerW: number;
  powerLimitW: number;
  fanPct: number | null;
  procs: Proc[];
}

// ---------- parsers (pure) ----------

/** Busy fraction between two /proc/stat "cpu" lines. */
export function cpuBusyPct(a: string, b: string): number {
  const nums = (l: string) => l.trim().split(/\s+/).slice(1).map(Number);
  const [x, y] = [nums(a), nums(b)];
  const idle = (v: number[]) => (v[3] ?? 0) + (v[4] ?? 0); // idle + iowait
  const total = (v: number[]) => v.reduce((s, n) => s + n, 0);
  const dt = total(y) - total(x);
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (100 * (dt - (idle(y) - idle(x)))) / dt));
}

export function parseMeminfo(text: string): Omit<MemStats, "top"> {
  const kb = (k: string) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const mib = (n: number) => Math.round(n / 1024);
  const total = kb("MemTotal");
  const avail = kb("MemAvailable");
  return {
    totalMiB: mib(total),
    availableMiB: mib(avail),
    usedMiB: mib(total - avail),
    cacheMiB: mib(kb("Cached") + kb("Buffers") + kb("SReclaimable")),
    swapTotalMiB: mib(kb("SwapTotal")),
    swapUsedMiB: mib(kb("SwapTotal") - kb("SwapFree")),
  };
}

/** One line of `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits`. */
export function parseGpuLine(line: string): Omit<GpuStats, "procs"> {
  const f = line.split(",").map((s) => s.trim());
  const n = (s: string | undefined) => (s && /^[\d.]+$/.test(s) ? Number(s) : NaN);
  return {
    name: f[0] ?? "GPU",
    utilPct: n(f[1]),
    memUsedMiB: n(f[2]),
    memTotalMiB: n(f[3]),
    tempC: n(f[4]),
    powerW: n(f[5]),
    powerLimitW: n(f[6]),
    fanPct: Number.isNaN(n(f[7])) ? null : n(f[7]),
  };
}

/** Short program name only: never show full command lines (they can hold IDs and paths). */
export function progName(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return basename(first).slice(0, 24) || "?";
}

/** Merge processes with the same program name (Chrome has many) and keep the largest `n`. */
export function topByName(list: Proc[], n = 3): Proc[] {
  const m = new Map<string, number>();
  for (const p of list) m.set(p.name, (m.get(p.name) ?? 0) + p.value);
  return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, n);
}

// ---------- formatters (pure) ----------

export function bar(pct: number, width = 10): string {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const full = Math.round((p / 100) * width);
  return "▰".repeat(full) + "▱".repeat(width - full);
}
const dot = (pct: number, warn = 70, hot = 90) => (pct >= hot ? "🔴" : pct >= warn ? "🟡" : "🟢");
const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
const pct = (n: number) => `${Math.round(n)}%`;

export function formatCpu(c: CpuStats): string {
  const lines = [
    `🧠 **CPU** · ${c.model} (${c.cores} threads)`,
    `${dot(c.usagePct)} ${bar(c.usagePct)} **${pct(c.usagePct)}**`,
    `📈 Load (1/5/15 min): ${c.load.map((l) => l.toFixed(2)).join(" / ")}`,
  ];
  if (c.tempC !== null) lines.push(`🌡️ ${Math.round(c.tempC)} °C`);
  if (c.top.length) lines.push(`🔝 ${c.top.map((p) => `${p.name} ${pct(p.value)}`).join(" · ")}`);
  return lines.join("\n");
}

export function formatMem(m: MemStats): string {
  const used = (100 * m.usedMiB) / Math.max(1, m.totalMiB);
  const lines = [
    `💾 **Memory** · ${gib(m.totalMiB)}`,
    `${dot(used, 75, 90)} ${bar(used)} **${gib(m.usedMiB)} used** (${pct(used)}) · ${gib(m.availableMiB)} available`,
  ];
  if (m.swapTotalMiB > 0) lines.push(`🔁 Swap: ${gib(m.swapUsedMiB)} / ${gib(m.swapTotalMiB)}`);
  if (m.top.length) lines.push(`🔝 ${m.top.map((p) => `${p.name} ${gib(p.value)}`).join(" · ")}`);
  return lines.join("\n");
}

export function formatGpu(g: GpuStats): string {
  const vram = (100 * g.memUsedMiB) / Math.max(1, g.memTotalMiB);
  const lines = [
    `🎮 **GPU** · ${g.name}`,
    `${dot(g.utilPct)} ${bar(g.utilPct)} **${pct(g.utilPct)}** load`,
    `${dot(vram, 75, 90)} ${bar(vram)} **${gib(g.memUsedMiB)} / ${gib(g.memTotalMiB)}** VRAM (${pct(vram)})`,
    `🌡️ ${Math.round(g.tempC)} °C · ⚡ ${Math.round(g.powerW)} / ${Math.round(g.powerLimitW)} W${g.fanPct !== null ? ` · 🌀 fan ${pct(g.fanPct)}` : ""}`,
  ];
  const listed = g.procs.reduce((s, p) => s + p.value, 0);
  if (g.procs.length) lines.push(`🔝 ${g.procs.map((p) => `${p.name} ${p.value} MiB`).join(" · ")}`);
  // Sunshine leak record (2026-09-29): VRAM that no process owns is the warning sign.
  const unlisted = g.memUsedMiB - listed;
  if (Number.isFinite(unlisted) && unlisted > 2048) lines.push(`⚠️ ${gib(unlisted)} VRAM is not listed under any process`);
  return lines.join("\n");
}

export function header(host: string, upSec: number, now = new Date()): string {
  const d = Math.floor(upSec / 86400);
  const h = Math.floor((upSec % 86400) / 3600);
  const m = Math.floor((upSec % 3600) / 60);
  const up = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return `🖥️ **${host}** · up ${up} · <t:${Math.floor(now.getTime() / 1000)}:T>`;
}

// ---------- collectors ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cpuLine = () => readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";

function cpuTemp(): number | null {
  try {
    for (const d of readdirSync("/sys/class/hwmon")) {
      const dir = join("/sys/class/hwmon", d);
      if (readFileSync(join(dir, "name"), "utf8").trim() !== "k10temp") continue;
      return Number(readFileSync(join(dir, "temp1_input"), "utf8")) / 1000; // Tctl
    }
  } catch {}
  return null;
}

/** pid → [program name, utime+stime ticks] from /proc/<pid>/stat. */
function procTicks(): Map<string, [string, number]> {
  const out = new Map<string, [string, number]>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const s = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = s.lastIndexOf(")");
      const f = s.slice(close + 2).split(" "); // f[0] = state, f[11] = utime, f[12] = stime
      out.set(pid, [s.slice(s.indexOf("(") + 1, close), Number(f[11]) + Number(f[12])]);
    } catch {} // the process ended while we read
  }
  return out;
}

/** Per-process share of the whole machine over the same window as the total (so the numbers add up). */
export function procCpuShare(a: Map<string, [string, number]>, b: Map<string, [string, number]>, totalTicks: number): Proc[] {
  if (totalTicks <= 0) return [];
  const out: Proc[] = [];
  for (const [pid, [name, t1]] of b) {
    const t0 = a.get(pid)?.[1];
    if (t0 === undefined || t1 <= t0) continue;
    out.push({ name: progName(name), value: (100 * (t1 - t0)) / totalTicks });
  }
  return out;
}

async function psRss(): Promise<Proc[]> {
  const field = "rss";
  const { stdout } = await run("ps", ["-eo", `${field},comm`, "--no-headers", `--sort=-${field}`], { timeout: 3000 });
  return stdout
    .trim()
    .split("\n")
    .slice(0, 60)
    .map((l) => {
      const m = l.trim().match(/^([\d.]+)\s+(.+)$/);
      return m ? { name: progName(m[2]!), value: Number(m[1]) / 1024 } : null;
    })
    .filter((p): p is Proc => p !== null);
}

export async function collectCpu(sampleMs = 500): Promise<CpuStats> {
  const a = cpuLine();
  const pa = procTicks();
  await sleep(sampleMs);
  const b = cpuLine();
  const pb = procTicks();
  const threads = cpus().length;
  const ticks = (l: string) => l.trim().split(/\s+/).slice(1).reduce((s, n) => s + Number(n), 0);
  const top = topByName(procCpuShare(pa, pb, ticks(b) - ticks(a)));
  const la = loadavg();
  return {
    model: (cpus()[0]?.model ?? "CPU").replace(/\s+\d+-Core Processor$/, "").trim(),
    cores: threads,
    usagePct: cpuBusyPct(a, b),
    load: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
    tempC: cpuTemp(),
    top: top.filter((p) => p.value >= 0.5),
  };
}

export async function collectMem(): Promise<MemStats> {
  const base = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  const top = topByName(await psRss().catch(() => [])).map((p) => ({ ...p, value: Math.round(p.value) }));
  return { ...base, top };
}

export async function collectGpu(): Promise<GpuStats> {
  const q = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed";
  const { stdout } = await run("nvidia-smi", [`--query-gpu=${q}`, "--format=csv,noheader,nounits"], { timeout: 5000 });
  const base = parseGpuLine(stdout.trim().split("\n")[0] ?? "");
  const apps = await run("nvidia-smi", ["--query-compute-apps=process_name,used_memory", "--format=csv,noheader,nounits"], { timeout: 5000 })
    .then((r) => r.stdout)
    .catch(() => "");
  const procs: Proc[] = apps
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf(",");
      return { name: progName(l.slice(0, i)), value: Number(l.slice(i + 1).trim()) };
    })
    .filter((p) => Number.isFinite(p.value));
  return { ...base, procs: topByName(procs) };
}

export type StatKind = "cpu" | "gpu" | "memory" | "stats";

export async function rigReport(kind: StatKind): Promise<string> {
  const parts: string[] = [header(hostname(), uptime())];
  const safe = async (label: string, f: () => Promise<string>) => f().catch((e) => `❌ **${label}:** ${(e as Error).message.split("\n")[0]}`);
  if (kind === "cpu" || kind === "stats") parts.push(await safe("CPU", async () => formatCpu(await collectCpu())));
  if (kind === "gpu" || kind === "stats") parts.push(await safe("GPU", async () => formatGpu(await collectGpu())));
  if (kind === "memory" || kind === "stats") parts.push(await safe("Memory", async () => formatMem(await collectMem())));
  return parts.join("\n\n");
}
