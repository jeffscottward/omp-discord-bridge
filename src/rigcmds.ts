/**
 * Owner 2026-10-15: extra rig slash commands (/services /logs /disk /restart /panes /net /stream /remind
 * /updates /mac). All read-only except /restart (asks first) and /remind.
 * Output is plain text built from local commands; process command lines are never shown.
 * Services, ping targets and the second machine come from the bot config.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "./config.ts";
import { collectGpu, bar } from "./rigstats.ts";

const run = promisify(execFile);
const HOME = homedir();
const sh = async (cmd: string, args: string[], timeout = 20_000) => {
  const r = await run(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string; message: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr || e.message }));
  return `${r.stdout ?? ""}`.trim() || `${r.stderr ?? ""}`.trim();
};
/** Like sh, but keeps the exit status, so commands that change state can report failures honestly. */
const exec = async (cmd: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string }> =>
  run(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }).then(
    (r) => ({ ok: true, out: `${r.stdout}`.trim() }),
    (e: { stdout?: string; stderr?: string; message: string }) => ({ ok: false, out: `${e.stderr || e.stdout || e.message}`.trim() }),
  );
const clip = (s: string, n = 1700) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
const block = (s: string) => `\`\`\`\n${clip(s.replace(/```/g, "ˋˋˋ"))}\n\`\`\``;

/** Services the owner watches: label → user unit (config "services"). */
export const SERVICES: Record<string, string> = CONFIG.services ?? {
  bot: "omp-discord-bot.service",
  tts: "omp-tts.service",
  whisper: "omp-whisper.service",
};
/** /restart targets (config "restartable"); only labels that are also in SERVICES. Discord allows 25 choices. */
export const RESTARTABLE: readonly string[] = (CONFIG.restartable ?? ["bot", "tts", "whisper"]).filter((l) => l in SERVICES).slice(0, 25);
/** Label of the Sunshine streaming service in SERVICES (used by /stream). */
const SUNSHINE = Object.keys(SERVICES).find((l) => /sunshine/i.test(l) || /sunshine/i.test(SERVICES[l]!));

export async function services(): Promise<string> {
  const lines = ["🖥️ **Services**", "———————————"];
  for (const [label, unit] of Object.entries(SERVICES)) {
    const state = await sh("systemctl", ["--user", "is-active", unit]);
    const since = await sh("systemctl", ["--user", "show", unit, "-p", "ActiveEnterTimestamp", "--value"]);
    const t = Date.parse(since) ? ` · since <t:${Math.floor(Date.parse(since) / 1000)}:R>` : "";
    lines.push(`${state === "active" ? "🟢" : state === "activating" ? "🟡" : "🔴"} **${label}** ${state}${state === "active" ? t : ""}`);
  }
  const failed = (await sh("systemctl", ["--user", "list-units", "--state=failed", "--no-legend", "--plain"])).split("\n").filter(Boolean);
  lines.push("", failed.length ? `⚠️ ${failed.length} failed unit(s): ${failed.map((l) => l.split(" ")[0]).join(", ")}` : "✅ No failed user units");
  const timers = (await sh("systemctl", ["--user", "list-timers", "--no-legend", "--plain"])).split("\n").filter(Boolean).length;
  lines.push(`⏲️ ${timers} active timer(s)`);
  return lines.join("\n");
}

export async function logs(label: string, redact: (s: string) => string): Promise<string> {
  const unit = SERVICES[label];
  if (!unit) return `❌ Unknown service: ${label}`;
  const out = await sh("journalctl", ["--user", "-u", unit, "-n", "20", "-o", "cat", "--no-pager"]);
  return `📜 **${label}** · last 20 lines\n${block(redact(out.split("\n").map((l) => l.slice(0, 160)).join("\n")) || "(no lines)")}`;
}

export async function disk(): Promise<string> {
  const out = await sh("df", ["-h", "-x", "tmpfs", "-x", "devtmpfs", "-x", "efivarfs", "-x", "overlay", "--output=source,target,size,used,avail,pcent"]);
  const rows = out.split("\n").slice(1).filter((l) => !/\/(boot|snap)/.test(l));
  const lines = ["💽 **Disk**", "———————————"];
  const seen = new Set<string>(); // btrfs subvolumes and bind mounts repeat the same device
  for (const r of rows) {
    const [source, target, size, used, avail, pc] = r.trim().split(/\s+/);
    if (!source || seen.has(source.replace(/\[.*$/, ""))) continue;
    seen.add(source.replace(/\[.*$/, ""));
    const p = Number(pc?.replace("%", "")) || 0;
    lines.push(`${p >= 90 ? "🔴" : p >= 75 ? "🟡" : "🟢"} ${bar(p)} **${pc}** \`${target}\` · ${used} / ${size} · ${avail} free`);
  }
  const big = await sh("bash", ["-c", "du -xhd1 \"$HOME\" 2>/dev/null | sort -rh | sed -n 2,6p"], 30_000);
  if (big) lines.push("", "📁 **Largest in ~**", ...big.split("\n").map((l) => { const [s, p] = l.split("\t"); return `• ${s} \`${(p ?? "").replace(HOME, "~")}\``; }));
  return lines.join("\n");
}

/** Restart after the owner confirms. The bot itself goes through restart-when-idle.sh (never mid-answer). */
export async function restartService(label: string, repoDir: string): Promise<string> {
  if (!RESTARTABLE.includes(label)) return `❌ ${label} can't be restarted from Discord.`;
  if (label === "bot") {
    const r = await exec("systemd-run", ["--user", `--unit=omp-discord-restart-${Math.floor(Date.now() / 1000)}`, "--collect", `--working-directory=${repoDir}`, "scripts/restart-when-idle.sh", "HEAD", "60"]);
    if (!r.ok) return `❌ **Bot restart not scheduled:** ${r.out.split("\n")[0]?.slice(0, 200)}`;
    return "🔄 **Bot restart scheduled.** It runs when the queue is empty; watch for the ✅ notice.";
  }
  const unit = SERVICES[label]!;
  const since = (u: string) => sh("systemctl", ["--user", "show", u, "-p", "ActiveEnterTimestampMonotonic", "--value"]);
  const before = await since(unit);
  const r = await exec("systemctl", ["--user", "restart", unit], 60_000);
  if (!r.ok) return `❌ **${label} restart failed:** ${r.out.split("\n")[0]?.slice(0, 200)}`;
  await new Promise((res) => setTimeout(res, 3000));
  const [state, after] = [await sh("systemctl", ["--user", "is-active", unit]), await since(unit)];
  // Only claim a restart when the unit really started again (its start time moved).
  const restarted = after !== before && after !== "0";
  return `${state === "active" && restarted ? "✅" : "❌"} **${label}** ${restarted ? "restarted" : "did not restart"} · now ${state}`;
}

export async function panes(): Promise<string> {
  const raw = await sh(join(HOME, ".local/bin/herdr"), ["tab", "list"]);
  let tabs: { label: string; pane_count: number; workspace_id: string; focused: boolean }[] = [];
  try {
    tabs = JSON.parse(raw).result.tabs;
  } catch {
    return `❌ Herdr didn't answer: ${raw.split("\n")[0]?.slice(0, 200)}`;
  }
  const by = new Map<string, typeof tabs>();
  for (const t of tabs) by.set(t.workspace_id, [...(by.get(t.workspace_id) ?? []), t]);
  const lines = ["🪟 **Herdr tabs** (rig)", "———————————"];
  for (const [ws, list] of by) lines.push(`**${ws}** · ${list.map((t) => `${t.focused ? "👉 " : ""}${t.label} (${t.pane_count})`).join(" · ")}`);
  lines.push("", "ℹ️ Herdr's working/idle status is unreliable for OMP panes, so it isn't shown.");
  return clip(lines.join("\n"), 1900);
}

export async function net(): Promise<string> {
  const lines = ["🌐 **Network**", "———————————"];
  try {
    const st = JSON.parse(await sh("tailscale", ["status", "--json"])) as { Peer?: Record<string, { ExitNode?: boolean; HostName?: string; DNSName?: string; Online?: boolean }>; BackendState?: string };
    const exit = Object.values(st.Peer ?? {}).find((p) => p.ExitNode);
    lines.push(`🔒 Tailscale ${st.BackendState ?? "?"} · exit node ${exit ? (exit.DNSName ?? exit.HostName ?? "?").split(".")[0] : "none"}`);
  } catch {
    lines.push("🔒 Tailscale: no status");
  }
  try {
    const ip = (await (await fetch("https://am.i.mullvad.net/json", { signal: AbortSignal.timeout(6000) })).json()) as { city?: string; country?: string; mullvad_exit_ip?: boolean };
    lines.push(`🌍 Egress ${ip.city ?? "?"}, ${ip.country ?? "?"}${ip.mullvad_exit_ip ? " (Mullvad)" : ""}`);
  } catch {
    lines.push("🌍 Egress: lookup failed");
  }
  for (const [name, host] of Object.entries(CONFIG.pingHosts ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host)) continue; // never an option
    const out = await sh("ping", ["-c", "3", "-q", "-W", "2", host], 10_000);
    const avg = out.match(/= [\d.]+\/([\d.]+)\//)?.[1];
    lines.push(`📶 ${name}: ${avg ? `${Math.round(Number(avg))} ms` : "no reply"}`);
  }
  return lines.join("\n");
}

export async function stream(): Promise<string> {
  const unit = SUNSHINE ? SERVICES[SUNSHINE]! : "";
  const state = unit ? await sh("systemctl", ["--user", "is-active", unit]) : "not configured";
  const lines = ["🎮 **Stream (Sunshine)**", "———————————", `${state === "active" ? "🟢" : "🔴"} Sunshine ${state}`];
  try {
    const g = await collectGpu();
    const listed = g.procs.reduce((s, p) => s + p.value, 0);
    const un = Math.max(0, g.memUsedMiB - listed);
    lines.push(`🎞️ VRAM ${(g.memUsedMiB / 1024).toFixed(1)} / ${(g.memTotalMiB / 1024).toFixed(1)} GiB · not owned by any process: ${(un / 1024).toFixed(1)} GiB ${un > 2048 ? "⚠️ (leak sign)" : "🟢"}`);
  } catch (e) {
    lines.push(`❌ GPU: ${(e as Error).message.split("\n")[0]}`);
  }
  const mons = await sh("hyprctl", ["monitors", "-j"]);
  try {
    for (const m of JSON.parse(mons) as { name: string; dpmsStatus: boolean }[]) lines.push(`🖥️ ${m.name} ${m.dpmsStatus ? "on" : "off (DPMS)"}`);
  } catch {}
  return lines.join("\n");
}

/** omarchy-reminder ships with Omarchy in /usr/bin (found via PATH). Report failure instead of a false "set". */
export async function remind(minutes: number, text: string): Promise<string> {
  const r = await run("omarchy-reminder", [String(minutes), text], { timeout: 20_000 }).then(
    (o) => ({ ok: true, out: `${o.stdout}`.trim() }),
    (e: { stderr?: string; message: string }) => ({ ok: false, out: `${e.stderr || e.message}`.trim() }),
  );
  if (!r.ok) return `❌ **Reminder not set:** ${r.out.split("\n")[0]?.slice(0, 200)}`;
  const list = await sh("omarchy-reminder", ["show", "--json"]); // plain `show` prints nothing when not on a terminal
  const seen = list.includes(JSON.stringify(text.slice(0, 40)).slice(1, -1));
  return `⏰ **Reminder set** for <t:${Math.floor(Date.now() / 1000 + minutes * 60)}:t> (${minutes} min): ${text}${seen ? "" : "\n⚠️ It did not appear in `omarchy-reminder show`."}`;
}

export async function updates(): Promise<string> {
  const repo = (await sh("checkupdates", [], 90_000)).split("\n").filter((l) => /^\S+ \S+ -> \S+$/.test(l));
  const aur = (await sh("yay", ["-Qua"], 90_000)).split("\n").filter((l) => /->/.test(l));
  const lines = ["⬆️ **Updates** (list only, nothing installed)", "———————————", `📦 Repo: ${repo.length} · AUR: ${aur.length}`];
  const show = [...repo, ...aur].slice(0, 25).map((l) => `• ${l}`);
  if (show.length) lines.push(...show);
  if (repo.length + aur.length > 25) lines.push(`… and ${repo.length + aur.length - 25} more`);
  return clip(lines.join("\n"), 1900);
}

/** The second machine (config "mirror.macSshHost") over SSH: reachable, uptime, battery. */
export async function mac(): Promise<string> {
  const ssh = CONFIG.mirror?.macSshHost;
  if (!ssh) return "ℹ️ No second machine configured (mirror.macSshHost).";
  const out = await sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", ssh, "echo ok; uptime -p; cat /sys/class/power_supply/*/capacity 2>/dev/null | head -1; cat /sys/class/power_supply/*/status 2>/dev/null | head -1"], 15_000);
  const [ok, up, cap, status] = out.split("\n");
  if (ok?.trim() !== "ok") return `🔴 **${ssh} unreachable** · ${out.split("\n")[0]?.slice(0, 160)}`;
  return `🖥️ **${ssh}** 🟢 reachable\n⏱️ ${up}\n🔋 ${cap ?? "?"}% · ${status ?? "?"}`;
}
