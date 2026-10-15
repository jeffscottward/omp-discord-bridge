/**
 * Owner 2026-10-15: /usage posts the same provider usage limits as `omp usage`, for every authenticated
 * account. It runs OMP's own command (`--json --redact`), so it reads OMP's credential store the supported
 * way and shows only shortened account names. The formatter is pure so it can be tested.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bar } from "./rigstats.ts";

const run = promisify(execFile);

interface Limit {
  label?: string;
  status?: string;
  window?: { resetsAt?: number };
  amount?: { usedFraction?: number };
}
interface Report {
  provider: string;
  fetchedAt?: number;
  metadata?: { email?: string; orgName?: string; planType?: string; limitReached?: boolean };
  resetCredits?: { availableCount?: number };
  limits?: Limit[];
}
interface Capacity {
  window: string;
  meter?: string;
  accounts: number;
  remainingAccounts: number;
}
export interface UsageJson {
  generatedAt?: number;
  reports?: Report[];
  capacity?: Record<string, Capacity[]>;
  accountsWithoutUsage?: unknown[];
  disabledCredentials?: unknown[];
}

const NAMES: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  openrouter: "OpenRouter",
};
const providerName = (p: string) => NAMES[p] ?? p.replace(/(^|-)(\w)/g, (_, s: string, c: string) => `${s ? " " : ""}${c.toUpperCase()}`);
const dot = (f: number, status?: string) => (status && status !== "ok" ? "🔴" : f >= 0.9 ? "🔴" : f >= 0.7 ? "🟡" : "🟢");
const ts = (ms: number, style: "R" | "T") => `<t:${Math.floor(ms / 1000)}:${style}>`;

function age(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function formatUsage(u: UsageJson, now = Date.now()): string {
  const out: string[] = [`📊 **AI usage** · ${ts(u.generatedAt ?? now, "T")}`];
  const byProvider = new Map<string, Report[]>();
  for (const r of u.reports ?? []) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r]);
  // Claude first: it is the main subscription (code writing runs on it).
  const order = [...byProvider].sort(([a], [b]) => Number(b === "anthropic") - Number(a === "anthropic"));
  for (const [provider, reports] of order) {
    out.push("", `**${providerName(provider)}** · ${reports.length} account${reports.length === 1 ? "" : "s"}`);
    for (const r of reports) {
      const m = r.metadata ?? {};
      const who = [m.email, m.orgName].filter(Boolean).join(" · ") || "account";
      const extra: string[] = [];
      if (m.planType) extra.push(`plan ${m.planType}`);
      if (r.resetCredits?.availableCount) extra.push(`✦ ${r.resetCredits.availableCount} saved resets`);
      if (r.fetchedAt && now - r.fetchedAt > 15 * 60_000) extra.push(`data ${age(now - r.fetchedAt)} old`);
      out.push(`👤 ${who}${extra.length ? ` · ${extra.join(" · ")}` : ""}`);
      for (const l of r.limits ?? []) {
        const f = Math.max(0, Math.min(1, l.amount?.usedFraction ?? 0));
        const reset = l.window?.resetsAt && l.window.resetsAt > now ? ` · resets ${ts(l.window.resetsAt, "R")}` : "";
        out.push(`${dot(f, l.status)} ${bar(f * 100)} **${Math.round(f * 100)}%** ${l.label ?? "limit"}${reset}`);
      }
    }
    const caps = (u.capacity?.[provider] ?? []).filter((c) => c.accounts > 1);
    for (const c of caps) out.push(`📦 ${c.window}${c.meter ? ` (${c.meter})` : ""}: ${c.remainingAccounts.toFixed(2)} of ${c.accounts} accounts left`);
  }
  if (!byProvider.size) out.push("", "No usage reports. No authenticated provider returned usage.");
  const missing = u.accountsWithoutUsage?.length ?? 0;
  const disabled = u.disabledCredentials?.length ?? 0;
  if (missing) out.push("", `⚠️ ${missing} account(s) returned no usage data`);
  if (disabled) out.push(`⚠️ ${disabled} credential(s) are disabled in OMP`);
  const text = out.join("\n");
  return text.length > 1990 ? `${text.slice(0, 1975)}\n… (shortened)` : text;
}

export async function usageReport(ompBin: string): Promise<string> {
  const { stdout } = await run(ompBin, ["usage", "--json", "--redact"], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, cwd: "/tmp" });
  return formatUsage(JSON.parse(stdout) as UsageJson);
}
