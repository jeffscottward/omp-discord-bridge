// Approval manager (bridge side). For every `omp-approve` request it posts the exact command in the
// run's Discord thread, opens a dedicated "Approve <id>" Herdr tab on this machine running
// gate/approve.ts (AGENTS.md: created with OMP_AUTO_START=0 and --no-focus, plain shell verified
// with `herdr pane process-info`, never captured), then posts the receipt. `!deny <id>` and expiry
// cancel. Results are also handed to the next prompt of the same session.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { SendableChannels } from "discord.js";
import { APPROVAL_WORKSPACE, HOST_LABEL, QUEUE_DIR, trusted } from "./config.ts";
import { runFromButton } from "../gate/run.ts";
import type { LinkButton } from "./heeler.ts";
import {
  cancelEntry,
  ensureQueue,
  hashEntry,
  ID_RE,
  listPending,
  listPosted,
  readEntry,
  readReceipt,
  writePosted,
  type Entry,
  type Posted,
  type Receipt,
} from "../gate/queue.ts";

const REPO_DIR = resolve(import.meta.dir, "..");
const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash"]);

export interface ApprovalDeps {
  /** Resolve a channel id to a sendable channel, only if it is one of the owner's private channels. */
  privateChannel: (id: string) => Promise<SendableChannels | null>;
  send: (ch: SendableChannels, text: string, links?: LinkButton[]) => Promise<void>;
  /** Trusted mode: post the request with an Approve button (custom id `approve:<id>`). */
  sendApproval?: (ch: SendableChannels, text: string, id: string) => Promise<void>;
  log: (...a: unknown[]) => void;
  queueDir?: string;
  herdr?: (args: string[]) => { code: number; out: string };
}

const fence = (s: string) => s.replace(/```/g, "ˋˋˋ");
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function defaultHerdr(args: string[]): { code: number; out: string } {
  const r = spawnSync("herdr", args, { encoding: "utf8", timeout: 15_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
}

export function requestText(e: Entry): string {
  const mins = Math.round((e.expiresAt - Date.now()) / 60_000);
  return [
    `🔐 **Approval needed** \`${e.id}\` — this run asked for an action it has no capability for. Nothing has run.`,
    "```",
    fence(e.command),
    "```",
    `In: \`${e.cwd}\`${e.reason ? `\nReason given: ${e.reason}` : ""}`,
    `Open HEELER → terminal list → 'Approve ${e.id}' tab on ${HOST_LABEL}, check the command, enter your login password.`,
    `\`!deny ${e.id}\` here cancels. Expires in ${mins} min.`,
  ].join("\n");
}

export const APPROVE_PREFIX = "approve:";

export function trustedRequestText(e: Entry): string {
  const mins = Math.round((e.expiresAt - Date.now()) / 60_000);
  return [
    `🔐 **Approval needed** \`${e.id}\` — nothing has run yet.`,
    "```",
    fence(e.command),
    "```",
    `In: \`${e.cwd}\`${e.reason ? `\nReason given: ${e.reason}` : ""}`,
    `Tap **Approve** to run it now (no password), or \`!deny ${e.id}\`. Expires in ${mins} min.`,
  ].join("\n");
}

export function receiptText(r: Receipt): string {
  if (r.status === "ran") {
    const out = r.output?.trim() ? `\n\`\`\`\n${fence(r.output.trim())}\n\`\`\`` : "";
    const how = r.detail.includes("Discord button") ? "ran" : "ran after password verification";
    return `${r.exitCode === 0 ? "✅" : "⚠️"} Approval \`${r.id}\` ${how}: ${r.detail}.${out}`;
  }
  return `🚫 Approval \`${r.id}\` ${r.status}: ${r.detail}. Nothing ran.`;
}

export class Approvals {
  readonly dir: string;
  private readonly herdr: (args: string[]) => { code: number; out: string };
  private readonly known = new Map<string, Posted>();
  private readonly results = new Map<string, string[]>();
  private readonly inflight = new Set<string>();

  constructor(private readonly deps: ApprovalDeps) {
    this.dir = deps.queueDir ?? QUEUE_DIR;
    this.herdr = deps.herdr ?? defaultHerdr;
    ensureQueue(this.dir);
    for (const p of listPosted(this.dir)) if (!p.resultPosted) this.known.set(p.id, p);
  }

  /** Called for each new queue entry (from the run's host-exec socket). */
  onRequest(e: Entry): void {
    void this.post(e).catch((err) => this.deps.log(`approval ${e.id}: post failed: ${(err as Error).message}`));
  }

  /** Results for the next prompt of this session (consumed). */
  takeResults(sessionKey: string): string[] {
    const r = this.results.get(sessionKey) ?? [];
    this.results.delete(sessionKey);
    return r;
  }

  private async post(e: Entry): Promise<void> {
    if (this.known.has(e.id) || this.inflight.has(e.id)) return;
    this.inflight.add(e.id);
    try {
      const ch = await this.deps.privateChannel(e.channelId);
      if (!ch) {
        cancelEntry(this.dir, e.id, "rejected", "the request did not come from one of the owner's private channels");
        this.deps.log(`approval ${e.id}: rejected (channel ${e.channelId} not private)`);
        return;
      }
      const posted: Posted = { id: e.id, hash: hashEntry(e) };
      this.known.set(e.id, posted);
      writePosted(this.dir, posted);
      if (trusted() && this.deps.sendApproval) {
        await this.deps.sendApproval(ch, trustedRequestText(e), e.id);
        this.deps.log(`approval ${e.id}: posted with Discord button (trusted mode)`);
        return;
      }
      // Heeler links reach Agent panes only, so the button opens the rig's Console (see src/heeler.ts).
      await this.deps.send(ch, requestText(e));
      const tab = this.openTab(e, posted.hash);
      Object.assign(posted, tab);
      writePosted(this.dir, posted);
      if (!tab.tabId) await this.deps.send(ch, `⚠️ Could not open the approval tab for \`${e.id}\` (${tab.error}). It stays pending until it expires or \`!deny ${e.id}\`.`);
      this.deps.log(`approval ${e.id}: posted; tab ${tab.tabId ?? "none"}`);
    } finally {
      this.inflight.delete(e.id);
    }
  }

  /** Create the dedicated tab, verify a plain shell, start the approval script. */
  openTab(e: Entry, hash: string): { tabId?: string; paneId?: string; error?: string } {
    const ws = this.herdr(["workspace", "list"]);
    let workspace: string | undefined;
    try {
      const list = JSON.parse(ws.out).result.workspaces as { workspace_id: string; label: string }[];
      workspace = (list.find((w) => w.label === APPROVAL_WORKSPACE) ?? list[0])?.workspace_id;
    } catch {}
    if (!workspace) return { error: "no Herdr workspace" };
    const created = this.herdr(["tab", "create", "--workspace", workspace, "--cwd", e.cwd, "--label", `Approve ${e.id}`, "--env", "OMP_AUTO_START=0", "--no-focus"]);
    let tabId: string | undefined;
    let paneId: string | undefined;
    try {
      const r = JSON.parse(created.out).result;
      tabId = r.tab.tab_id;
      paneId = r.root_pane.pane_id;
    } catch {}
    if (!tabId || !paneId) return { error: "herdr tab create failed" };
    // Only start the script once the new pane runs a plain shell (not an auto-started agent).
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      Bun.sleepSync(250);
      try {
        const info = JSON.parse(this.herdr(["pane", "process-info", "--pane", paneId]).out).result.process_info;
        const fg = info.foreground_processes as { name: string; argv: string[] }[];
        ready = fg.length === 1 && SHELLS.has(fg[0]!.name) && info.shell_pid === info.foreground_process_group_id;
      } catch {}
    }
    if (!ready) {
      this.herdr(["tab", "close", tabId]);
      return { error: "the new pane did not show a plain shell" };
    }
    const cmd = `exec ${sq(process.execPath)} ${sq(`${REPO_DIR}/gate/approve.ts`)} ${sq(this.dir)} ${e.id} ${hash}`;
    if (this.herdr(["pane", "run", paneId, cmd]).code !== 0) {
      this.herdr(["tab", "close", tabId]);
      return { error: "herdr pane run failed" };
    }
    return { tabId, paneId };
  }

  private closeTab(p: Posted): void {
    if (p.tabId) this.herdr(["tab", "close", p.tabId]);
  }

  /** Trusted mode: the owner tapped Approve. */
  approveButton(id: string, by: string): "started" | "gone" | "changed" | "expired" | "unknown" | "off" {
    if (!trusted()) return "off";
    if (!ID_RE.test(id)) return "unknown";
    const p = this.known.get(id);
    if (!p) return "unknown";
    const r = runFromButton(this.dir, id, p.hash, by);
    if (r.state === "expired") cancelEntry(this.dir, id, "expired", "not approved within 30 minutes");
    void r.done?.catch((err) => this.deps.log(`approval ${id}: run failed: ${(err as Error).message}`));
    return r.state;
  }

  /** `!deny <id>` / CLI cancel. */
  deny(id: string, by: string): "cancelled" | "running" | "unknown" {
    if (!ID_RE.test(id)) return "unknown";
    if (!readEntry(this.dir, "pending", id)) return readEntry(this.dir, "claimed", id) ? "running" : "unknown";
    if (!cancelEntry(this.dir, id, "cancelled", `cancelled by ${by}`)) return "running";
    const p = this.known.get(id);
    if (p) this.closeTab(p);
    return "cancelled";
  }

  /** Poll: post new entries (e.g. after a restart), receipts and expiries. */
  async tick(): Promise<void> {
    for (const id of listPending(this.dir)) {
      const e = readEntry(this.dir, "pending", id);
      if (!e) continue;
      if (Date.now() > e.expiresAt) cancelEntry(this.dir, id, "expired", "not approved within 30 minutes");
      else if (!this.known.has(id)) await this.post(e);
    }
    for (const p of [...this.known.values()]) {
      const r = readReceipt(this.dir, p.id);
      if (!r) continue;
      const e = readEntry(this.dir, "claimed", p.id) ?? readEntry(this.dir, "closed", p.id);
      if (r.status !== "ran") this.closeTab(p);
      const ch = e ? await this.deps.privateChannel(e.channelId) : null;
      if (ch) await this.deps.send(ch, receiptText(r));
      if (e) {
        const list = this.results.get(e.sessionKey) ?? [];
        list.push(`${p.id}: \`${e.command.slice(0, 300)}\` → ${r.status} (${r.detail})${r.output ? `\n${r.output.slice(0, 1500)}` : ""}`);
        this.results.set(e.sessionKey, list);
      }
      p.resultPosted = true;
      writePosted(this.dir, p);
      this.known.delete(p.id);
      this.deps.log(`approval ${p.id}: ${r.status} (${r.detail})`);
    }
  }
}
