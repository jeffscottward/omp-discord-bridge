/**
 * Owner 2026-10-15: the queue board says when a bot restart is waiting for the queue to clear.
 * A restart is scheduled while an omp-discord-restart-* user unit (scripts/restart-when-idle.sh) is active. The number of new commits comes from git (boot commit → HEAD).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_DIR = resolve(import.meta.dir, "..");
const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO_DIR, encoding: "utf8", timeout: 2000 }).stdout?.trim() ?? "";
const BOOT_REV = git("rev-parse", "HEAD");

export interface PendingRestart {
  updates: number;
}

let cache: { at: number; value: PendingRestart | null } = { at: 0, value: null };

/** A restart waiter is active (it holds the lock). Cached for 5 s; boards re-render often. */
export function pendingRestart(now = Date.now()): PendingRestart | null {
  if (now - cache.at < 5000) return cache.value;
  // Never probe with flock: taking the lock even briefly could make a starting waiter exit and drop the
  // restart. An active omp-discord-restart-* unit is the waiter.
  const units = spawnSync("systemctl", ["--user", "list-units", "omp-discord-restart-*", "--state=active", "--no-legend", "--plain"], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
  const held = units.trim().length > 0;
  const updates = held && BOOT_REV ? Number(git("rev-list", "--count", `${BOOT_REV}..HEAD`)) || 0 : 0;
  cache = { at: now, value: held ? { updates } : null };
  return cache.value;
}

export function pendingLine(p: PendingRestart | null): string | null {
  if (!p) return null;
  // 0 = the restart reloads the commit already running (no new code).
  const what = p.updates === 1 ? "1 update ready" : p.updates > 1 ? `${p.updates} updates ready` : "no new code (reload only)";
  return `🔄 **Restart pending:** ${what}. The bot restarts when this queue is empty.`;
}

/** Keep whole lines so a cut never breaks a jump link's markdown. */
export function fitLines(lines: string[], max = 1900): string {
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > max) {
      out.push("…");
      break;
    }
    out.push(l);
    len += l.length + 1;
  }
  return out.join("\n");
}

/** Owner 2026-10-15: after the restart, the board that said "Restart pending" is edited to say restarted. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pendingFile = (stateDir: string) => `${stateDir}/pending-boards.json`;
export function recordPendingBoard(stateDir: string, channelId: string, messageId: string): void {
  let m: Record<string, string> = {};
  try {
    if (existsSync(pendingFile(stateDir))) m = JSON.parse(readFileSync(pendingFile(stateDir), "utf8"));
  } catch {}
  if (m[channelId] === messageId) return;
  m[channelId] = messageId;
  writeFileSync(pendingFile(stateDir), JSON.stringify(m));
}
export function takePendingBoards(stateDir: string): Record<string, string> {
  try {
    const m = JSON.parse(readFileSync(pendingFile(stateDir), "utf8")) as Record<string, string>;
    rmSync(pendingFile(stateDir), { force: true });
    return m;
  } catch {
    return {};
  }
}
export const restartedLine = (rev: string) => `✅ **Restarted:** the bot is running \`${rev}\` with all updates.`;
export const markRestarted = (text: string, rev: string) => text.replace(/^🔄 \*\*Restart pending:\*\*.*$/m, restartedLine(rev));
