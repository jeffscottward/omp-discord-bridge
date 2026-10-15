// Known-secret redaction for everything the bridge posts (answers, approval requests and receipts).
// The bridge (outside every run) reads secret-looking values from .env-style files under ~/Github
// and ~/.config and replaces exact occurrences with [REDACTED-SECRET]. Values stay in memory only.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discover, discoverAsync } from "./sandbox.ts";

const SECRET_KEY = /TOKEN|SECRET|PASS|KEY|AUTH|COOKIE|SESSION|CREDENTIAL|PRIVATE|WEBHOOK|DSN|TOPIC|ACCOUNT/i;
const REFRESH_MS = 10 * 60_000;

/** Secret-looking values (length ≥ 8) from KEY=VALUE lines. Pure; exported for tests. */
export function secretValues(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !SECRET_KEY.test(m[1]!)) continue;
    const v = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (v.length >= 8 && !/^(true|false|null|none|\d+)$/i.test(v)) out.push(v);
  }
  return out;
}

let cache: { at: number; values: string[] } | null = null;
/** Tests only: use a fixed secret list instead of walking ~ (slow and host-dependent). */
export function seedSecretValuesForTests(values: string[] = []): void {
  cache = { at: Date.now() + 365 * 86_400_000, values };
}

/** Values from secret files on this host (cached for 10 minutes). */
export function knownSecretValues(home = homedir()): string[] {
  if (cache && Date.now() - cache.at < REFRESH_MS) return cache.values;
  if (cache) {
    void refreshSecretValues(home); // stale: serve old values, refresh off the main thread
    return cache.values;
  }
  return loadValues(home, discover(home).secretFiles);
}

let refreshing: Promise<void> | null = null;
/** Re-read secret values with the walk in a child process (no event-loop stall). */
export function refreshSecretValues(home = homedir()): Promise<void> {
  refreshing ??= discoverAsync(home)
    .then((d) => void loadValues(home, d.secretFiles))
    .catch(() => {})
    .finally(() => void (refreshing = null));
  return refreshing;
}

function loadValues(home: string, secretFiles: string[]): string[] {
  const files = secretFiles.filter((f) => /(^|\/)(\.env[^/]*|[^/]*\.env|bot\.env|credentials)$/.test(f));
  files.push(join(home, ".config", "omp-discord", "bot.env"), join(home, ".mutt", "credentials"));
  const values = new Set<string>();
  for (const f of files) {
    try {
      for (const v of secretValues(readFileSync(f, "utf8"))) values.add(v);
    } catch {}
  }
  cache = { at: Date.now(), values: [...values].sort((a, b) => b.length - a.length) };
  return cache.values;
}

/** Replace exact occurrences of known secret values. */
export function redactKnownSecrets(text: string, values: string[] = knownSecretValues()): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const v of values) {
    if (!out.includes(v)) continue;
    hits += out.split(v).length - 1;
    out = out.split(v).join("[REDACTED-SECRET]");
  }
  return { text: out, hits };
}
