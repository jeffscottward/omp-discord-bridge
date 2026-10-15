// Herdr tab ↔ Discord channel mirroring (read-only toward Herdr and the panes).
// - sync(): `herdr agent list` / `herdr tab list` on this machine ("rig") and, if configured, a second
//   machine ("mac", over SSH). Each OMP pane gets a channel named after its tab in 🖥️ Rig / 💻 Mac. When the pane is gone, the channel
//   moves to 📦 Archive. The mapping is stable by pane id (then tab id) and stored in agents.json.
// - tail(): reads each pane's session JSONL from a saved byte offset (read-only) and posts every
//   new final assistant reply (text only) to its channel through the privacy filter.
// - decide(): Discord → session. Nothing is ever typed into a pane. If no omp process holds the
//   pane's session, the turn continues that session file (sandboxed `omp -p --resume`).
//   Otherwise it runs in a linked side session with a read-only excerpt as context. A scratch
//   test showed that a second writer's turn forks off the holder's branch and is lost.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client, type Guild, type SendableChannels, type TextChannel } from "discord.js";
import { CONFIG, FIRSTMATE_SESSION, GUILD_ID, STATE_DIR } from "./config.ts";

/** "rig": this machine. "mac": an optional second machine reached over SSH (config "mirror.macSshHost"). */
export type Machine = "rig" | "mac";
const MAC_SSH = CONFIG.mirror?.macSshHost ?? null;
export const HOSTS: { machine: Machine; ssh: string | null; herdr: string }[] = [
  { machine: "rig", ssh: null, herdr: "herdr" },
  ...(MAC_SSH ? [{ machine: "mac" as const, ssh: MAC_SSH, herdr: "~/.local/bin/herdr" }] : []),
];
/** Discord category ids (🖥️ Rig, 💻 Mac, 📦 Archive) from the bot config ("mirror.categories"). */
export const CATEGORY_IDS = {
  rig: CONFIG.mirror?.categories?.rig ?? "",
  mac: CONFIG.mirror?.categories?.mac ?? "",
  archive: CONFIG.mirror?.categories?.archive ?? "",
};
/** Mirroring needs at least the rig and archive categories. */
export const MIRROR_ENABLED = Boolean(CATEGORY_IDS.rig && CATEGORY_IDS.archive);

const MAP_FILE = join(STATE_DIR, "agents.json");
const MAX_TAIL_BYTES = 1024 * 1024;
const SSH_OPTS = [
  "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5",
  "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/omp-mirror-ssh-%r@%h", "-o", "ControlPersist=10m",
];

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[mirror]", ...a);

export type MirrorEntry = {
  machine: Machine;
  paneId: string;
  tabId?: string;
  workspace: string;
  tab: string;
  name: string;
  channelId: string;
  archived: boolean;
  cwd?: string;
  sessionFile?: string | null;
  /** Byte offset already mirrored in sessionFile. */
  offset?: number;
};

export type LivePane = { machine: Machine; paneId: string; tabId: string; workspace: string; tab: string; name: string; cwd: string; sessionFile: string | null };

/** Run a read-only shell snippet locally or on the host over SSH. */
export function sh(ssh: string | null, script: string, timeoutMs = 15_000): Promise<{ code: number; out: Buffer }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; out: Buffer }>();
  const p = ssh ? spawn("ssh", [...SSH_OPTS, ssh, script]) : spawn("bash", ["-c", script]);
  const chunks: Buffer[] = [];
  p.stdout.on("data", (d: Buffer) => chunks.push(d));
  p.stderr.on("data", () => {});
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  p.on("close", (code) => {
    clearTimeout(t);
    resolve({ code: code ?? 1, out: Buffer.concat(chunks) });
  });
  p.on("error", () => resolve({ code: 1, out: Buffer.alloc(0) }));
  p.stdin.end();
  return promise;
}

/** Discord channel name from the Herdr tab title. */
export function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 90) || "agent";
}

type HerdrItem = Record<string, unknown>;
function herdrList(raw: string, key: string): HerdrItem[] {
  try {
    const parsed = JSON.parse(raw) as { result?: Record<string, unknown> };
    const list = parsed.result?.[key];
    return Array.isArray(list) ? (list as HerdrItem[]) : [];
  } catch {
    return [];
  }
}

/** Parse `herdr agent list` + `herdr tab list` (pure; exported for tests). null = host unreadable. */
export function parseHerdr(machine: Machine, agentsRaw: string, tabsRaw: string, workspacesRaw = ""): LivePane[] | null {
  if (!agentsRaw.includes('"agents"')) return null;
  const tabLabel = new Map(herdrList(tabsRaw, "tabs").map((t) => [String(t.tab_id), String(t.label ?? t.tab_id)]));
  // Owner 2026-10-14: channel names are namespaced by workspace ("games-demo"). Owner 2026-10-14 later: machine prefix too ("rig-github-firstmate").
  const wsLabel = new Map(herdrList(workspacesRaw, "workspaces").map((w) => [String(w.workspace_id), String(w.label ?? "")]));
  const omp = herdrList(agentsRaw, "agents").filter((a) => a.agent === "omp");
  const perTab = new Map<string, number>();
  for (const a of omp) perTab.set(String(a.tab_id), (perTab.get(String(a.tab_id)) ?? 0) + 1);
  return omp.map((a) => {
    const paneId = String(a.pane_id);
    const tabId = String(a.tab_id);
    const tab = tabLabel.get(tabId) ?? tabId;
    const session = a.agent_session as { kind?: string; value?: string } | undefined;
    const suffix = (perTab.get(tabId) ?? 0) > 1 ? `-${paneId.split(":").pop()}` : "";
    return {
      machine,
      paneId,
      tabId,
      workspace: String(a.workspace_id ?? ""),
      tab,
      name: slug(`${machine}-${wsLabel.get(String(a.workspace_id ?? "")) ? `${wsLabel.get(String(a.workspace_id ?? ""))}-` : ""}${tab}${suffix}`),
      cwd: String(a.cwd ?? ""),
      sessionFile: session?.kind === "path" && typeof session.value === "string" && session.value.endsWith(".jsonl") ? session.value : null,
    };
  });
}

/**
 * True when an omp process runs in the pane: in its foreground group or anywhere below the pane's
 * shell. `ps` lines are "pid ppid comm args…" (pure; exported for tests).
 */
export function paneHasLiveOmp(processInfoRaw: string, ps: string): boolean {
  let info: { shell_pid?: number; foreground_processes?: { name?: string; argv?: string[] }[] } | undefined;
  try {
    info = (JSON.parse(processInfoRaw) as { result?: { process_info?: typeof info } }).result?.process_info;
  } catch {
    return true; // unknown → treat as held (never touch)
  }
  if (!info) return true;
  const isOmp = (name: string, args: string) => name === "omp" || /(^|\/)omp(\s|$)/.test(args);
  if (info.foreground_processes?.some((p) => isOmp(p.name ?? "", (p.argv ?? []).join(" ")))) return true;
  if (!info.shell_pid) return true;
  const rows: { pid: number; ppid: number; name: string; args: string }[] = [];
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!, args: m[4] ?? "" });
  }
  const byParent = new Map<number, typeof rows>();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
  const stack = [info.shell_pid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of byParent.get(pid) ?? []) {
      if (isOmp(c.name, c.args)) return true;
      stack.push(c.pid);
    }
  }
  return false;
}

/** Text of an assistant entry, text blocks only. */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Final assistant replies (stopReason "stop", text only) in the complete lines of a JSONL chunk.
 * `consumed` is the byte length of the complete lines (a partial last line is left for later).
 */
export function finalReplies(chunk: Buffer): { texts: string[]; consumed: number } {
  const end = chunk.lastIndexOf(0x0a);
  if (end === -1) return { texts: [], consumed: 0 };
  const texts: string[] = [];
  for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } };
      if (e.type === "message" && e.message?.role === "assistant" && e.message.stopReason === "stop") {
        const t = assistantText(e.message.content);
        if (t) texts.push(t);
      }
    } catch {}
  }
  return { texts, consumed: end + 1 };
}

/** Recent user/assistant text of a session file tail, as a read-only context excerpt (pure). */
export function transcriptExcerpt(tail: Buffer, maxChars = 6000): string {
  const out: string[] = [];
  for (const line of tail.toString("utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } };
      if (e.type !== "message") continue;
      if (e.message?.role === "user") {
        const t = assistantText(e.message.content);
        if (t) out.push(`USER: ${t.slice(0, 1500)}`);
      } else if (e.message?.role === "assistant" && e.message.stopReason === "stop") {
        const t = assistantText(e.message.content);
        if (t) out.push(`ASSISTANT: ${t.slice(0, 2500)}`);
      }
    } catch {}
  }
  let text = "";
  for (const part of out.reverse()) {
    if (text.length + part.length > maxChars) break;
    text = `${part}\n\n${text}`;
  }
  return text.trim();
}

/** How a Discord message in a mirrored channel runs. */
export type Decision =
  | { mode: "pane"; entry: MirrorEntry; sessionFile: string; cwd: string; key: string }
  | { mode: "side"; entry: MirrorEntry; key: string; cwd: string; reason: string; context: string };

const GITHUB = join(homedir(), "Github");

/** Side session for a mirrored channel: FIRSTMATE keeps its dedicated session; threads get their own. */
export function sideSessionKey(e: MirrorEntry, threadId: string | null): string {
  if (threadId) return threadId;
  return e.machine === "rig" && e.tab === FIRSTMATE_SESSION.tabLabel ? FIRSTMATE_SESSION.key : `side-${e.channelId}`;
}

export class Mirror {
  entries: MirrorEntry[] = [];
  hostOk = new Map<Machine, boolean>();
  /** Channel ids with a pane-mode run in progress (tail skips them). */
  busy = new Set<string>();
  #syncing = false;
  #tailing = false;

  constructor(
    private client: Client | null,
    private file = MAP_FILE,
  ) {
    if (!existsSync(file)) return;
    try {
      this.entries = (JSON.parse(readFileSync(file, "utf8")) as MirrorEntry[]).map(
        ({ machine, paneId, tabId, workspace, tab, name, channelId, archived, cwd, sessionFile, offset }) =>
          ({ machine, paneId, tabId, workspace, tab, name, channelId, archived, cwd, sessionFile, offset }),
      );
    } catch {
      this.entries = [];
    }
  }

  save(): void {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  byChannel(channelId: string): MirrorEntry | undefined {
    return this.entries.find((e) => e.channelId === channelId);
  }

  /** Reconcile live panes (one host) into entries; pure apart from entry mutation. Returns work to do. */
  plan(machine: Machine, live: LivePane[]): { create: LivePane[]; update: { e: MirrorEntry; p: LivePane }[]; archive: MirrorEntry[] } {
    const liveIds = new Set(live.map((p) => p.paneId));
    const create: LivePane[] = [];
    const update: { e: MirrorEntry; p: LivePane }[] = [];
    const claimed = new Set<MirrorEntry>();
    const free = (x: MirrorEntry) => x.machine === machine && !claimed.has(x);
    // Stable mapping: pane id first (all panes), then tab id (Herdr restart changes pane ids), then name.
    const exact = new Map(live.map((p) => [p, this.entries.find((x) => free(x) && x.paneId === p.paneId)]));
    for (const e of exact.values()) if (e) claimed.add(e);
    for (const p of live) {
      const e =
        exact.get(p) ??
        this.entries.find((x) => free(x) && x.tabId === p.tabId && !liveIds.has(x.paneId)) ??
        this.entries.find((x) => free(x) && x.name === p.name && !liveIds.has(x.paneId));
      if (e) {
        claimed.add(e);
        update.push({ e, p });
      } else create.push(p);
    }
    const archive = this.entries.filter((x) => x.machine === machine && !x.archived && !claimed.has(x));
    return { create, update, archive };
  }

  #topic(p: LivePane): string {
    return `Mirrors Herdr ${p.machine}:${p.paneId} (tab ${p.tab}). Terminal replies are posted here. Messages here never type into the pane: they continue its session only when no omp process holds it, otherwise a linked side session runs.`;
  }

  /**
   * Owner decision 2026-10-14: a mirrored channel was deleted in Discord. Close its Herdr tab only
   * when the tab's agent is idle; if it is working or waiting for input (or its state is unknown),
   * leave the tab open (the next sync recreates the channel). Returns what happened.
   */
  async closeDeleted(channelId: string): Promise<{ tab: string; result: "closed" | "busy" | "unknown" | "failed" } | null> {
    const e = this.entries.find((x) => x.channelId === channelId && !x.archived);
    if (!e) return null;
    const host = HOSTS.find((h) => h.machine === e.machine);
    if (!host || !e.tabId) return { tab: e.tab, result: "unknown" };
    const r = await sh(host.ssh, `${host.herdr} pane list`);
    let status: string | null = null;
    let tabPanes: { id: string; status: string }[] = [];
    try {
      const panes: { pane_id: string; tab_id: string; agent_status?: string }[] = JSON.parse(r.out.toString("utf8")).result.panes;
      status = panes.find((x) => x.pane_id === e.paneId)?.agent_status ?? null;
      tabPanes = panes.filter((x) => x.tab_id === e.tabId).map((x) => ({ id: x.pane_id, status: x.agent_status ?? "unknown" }));
    } catch {}
    if (status === null) return { tab: e.tab, result: "unknown" };
    // Any agent in the tab working or waiting for input blocks the close.
    if (tabPanes.some((x) => x.status === "working" || x.status === "blocked")) return { tab: e.tab, result: "busy" };
    const c = await sh(host.ssh, `${host.herdr} tab close ${JSON.stringify(e.tabId)}`);
    if (c.code !== 0) return { tab: e.tab, result: "failed" };
    this.entries = this.entries.filter((x) => x !== e);
    this.save();
    log(`closed ${e.machine} tab ${e.tabId} (${e.tab}) after its channel was deleted`);
    return { tab: e.tab, result: "closed" };
  }

  async sync(): Promise<void> {
    if (this.#syncing || !this.client || !MIRROR_ENABLED) return;
    this.#syncing = true;
    try {
      const guild = await this.client.guilds.fetch(GUILD_ID);
      await guild.channels.fetch();
      for (const host of HOSTS) {
        const r = await sh(host.ssh, `${host.herdr} agent list; printf '\\n@@\\n'; ${host.herdr} tab list; printf '\\n@@\\n'; ${host.herdr} workspace list`);
        const [agentsRaw = "", tabsRaw = "", wsRaw = ""] = r.out.toString("utf8").split("\n@@\n");
        const live = r.code === 0 ? parseHerdr(host.machine, agentsRaw, tabsRaw, wsRaw) : null;
        this.hostOk.set(host.machine, live !== null);
        if (!live) continue; // host offline: leave its channels alone
        await this.#apply(guild, host.machine, live);
      }
      this.save();
    } catch (e) {
      log(`sync failed: ${(e as Error).message}`);
    } finally {
      this.#syncing = false;
    }
  }

  async #apply(guild: Guild, machine: Machine, live: LivePane[]): Promise<void> {
    const { create, update, archive } = this.plan(machine, live);
    const parentId = CATEGORY_IDS[machine] || CATEGORY_IDS.rig;
    for (const p of create) {
      log(`create channel ${p.name} for ${machine}:${p.paneId}`);
      const ch = await guild.channels.create({ name: p.name, type: ChannelType.GuildText, parent: parentId, topic: this.#topic(p) });
      this.entries.push({ ...p, channelId: ch.id, archived: false, offset: undefined });
    }
    for (const { e, p } of update) {
      const ch = guild.channels.cache.get(e.channelId) as TextChannel | undefined;
      if (!ch) {
        log(`recreate channel ${p.name}`);
        const fresh = await guild.channels.create({ name: p.name, type: ChannelType.GuildText, parent: parentId, topic: this.#topic(p) });
        e.channelId = fresh.id;
      } else {
        // A rename blocked by Discord's limit (2 per 10 min) must not stall every later sync.
        if (ch.name !== p.name) {
          log(`rename ${ch.name} -> ${p.name}`);
          void ch.setName(p.name).catch((err: Error) => log(`rename failed: ${err.message}`));
        }
        if (ch.parentId !== parentId) await ch.setParent(parentId, { lockPermissions: false }).catch(() => {});
        if (ch.topic !== this.#topic(p)) await ch.setTopic(this.#topic(p)).catch(() => {});
      }
      if (e.sessionFile !== p.sessionFile) e.offset = undefined; // new session: mirror from now on
      Object.assign(e, { paneId: p.paneId, tabId: p.tabId, workspace: p.workspace, tab: p.tab, name: p.name, cwd: p.cwd, sessionFile: p.sessionFile, archived: false });
    }
    for (const e of archive) {
      const ch = guild.channels.cache.get(e.channelId) as TextChannel | undefined;
      log(`archive ${e.name}`);
      if (ch && ch.parentId !== CATEGORY_IDS.archive) await ch.setParent(CATEGORY_IDS.archive, { lockPermissions: false }).catch(() => {});
      e.archived = true;
    }
  }

  /** Read [offset, offset+MAX) of a session file on its host; size is the current file size. */
  async #read(e: MirrorEntry, offset: number): Promise<{ size: number; chunk: Buffer } | null> {
    if (!e.sessionFile) return null;
    if (e.machine === "rig") {
      // OMP creates the file lazily: a missing file reads as empty, so mirroring starts at byte 0.
      if (!existsSync(e.sessionFile)) return { size: 0, chunk: Buffer.alloc(0) };
      try {
        const size = statSync(e.sessionFile).size;
        if (size <= offset) return { size, chunk: Buffer.alloc(0) };
        const len = Math.min(size - offset, MAX_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        const fd = openSync(e.sessionFile, "r");
        try {
          readSync(fd, buf, 0, len, offset);
        } finally {
          closeSync(fd);
        }
        return { size, chunk: buf };
      } catch {
        return null;
      }
    }
    const host = HOSTS.find((h) => h.machine === e.machine);
    if (!host) return null; // second machine no longer configured
    const q = `'${e.sessionFile.replace(/'/g, "'\\''")}'`;
    const r = await sh(
      host.ssh,
      `if [ -e ${q} ]; then stat -c %s ${q} && tail -c +${offset + 1} ${q} | head -c ${MAX_TAIL_BYTES}; else echo 0; fi`,
    );
    if (r.code !== 0) return null;
    const nl = r.out.indexOf(0x0a);
    if (nl === -1) return null;
    return { size: Number(r.out.subarray(0, nl).toString()), chunk: r.out.subarray(nl + 1) };
  }

  /** Post new final replies from every mirrored pane session. */
  async tail(post: (channelId: string, text: string) => Promise<void>): Promise<void> {
    if (this.#tailing) return;
    this.#tailing = true;
    let dirty = false;
    try {
      for (const e of this.entries) {
        if (e.archived || !e.sessionFile || this.busy.has(e.channelId)) continue;
        if (e.machine !== "rig" && this.hostOk.get(e.machine) === false) continue;
        const start = e.offset;
        const r = await this.#read(e, start ?? 0);
        if (!r) continue;
        if (start === undefined || r.size < start) {
          e.offset = r.size; // first sight or truncated: start mirroring from here
          dirty = true;
          continue;
        }
        if (!r.chunk.length) continue;
        const { texts, consumed } = finalReplies(r.chunk);
        if (!consumed) continue;
        e.offset = start + consumed;
        dirty = true;
        for (const t of texts) await post(e.channelId, `🖥️ **${e.tab}** · terminal reply\n${t}`).catch((err: Error) => log(`post failed: ${err.message}`));
      }
    } finally {
      if (dirty) this.save();
      this.#tailing = false;
    }
  }

  /** After a pane-mode run: skip what the run itself appended (it was posted from stdout). */
  async markConsumed(e: MirrorEntry): Promise<void> {
    const r = await this.#read(e, Number.MAX_SAFE_INTEGER);
    if (r) {
      e.offset = r.size;
      this.save();
    }
  }

  async #liveOmp(e: MirrorEntry): Promise<boolean> {
    const host = HOSTS.find((h) => h.machine === e.machine);
    if (!host) return true; // unknown host: treat as held (never touch)
    const pane = e.paneId.replace(/[^A-Za-z0-9:_-]/g, "");
    const r = await sh(host.ssh, `${host.herdr} pane process-info --pane '${pane}'; printf '\\n@@\\n'; ps -eo pid=,ppid=,comm=,args=`);
    if (r.code !== 0) return true;
    const [info = "", ps = ""] = r.out.toString("utf8").split("\n@@\n");
    return paneHasLiveOmp(info, ps);
  }

  async #excerpt(e: MirrorEntry): Promise<string> {
    if (!e.sessionFile) return "";
    const probe = await this.#read(e, Number.MAX_SAFE_INTEGER);
    if (!probe) return "";
    const from = Math.max(0, probe.size - 256 * 1024);
    const r = await this.#read(e, from);
    return r ? transcriptExcerpt(r.chunk) : "";
  }

  /**
   * Decide where a Discord message in a mirrored channel runs. threadId: messages in a thread
   * under the channel always get their own side session.
   */
  async decide(channelId: string, threadId: string | null): Promise<Decision | null> {
    const e = this.byChannel(channelId);
    if (!e) return null;
    const sideKey = sideSessionKey(e, threadId);
    const cwdOk = e.machine === "rig" && e.cwd && (e.cwd === GITHUB || e.cwd.startsWith(`${GITHUB}/`)) && existsSync(e.cwd);
    const cwd = cwdOk ? e.cwd! : GITHUB;
    const side = async (reason: string): Promise<Decision> => ({ mode: "side", entry: e, key: sideKey, cwd, reason, context: await this.#excerpt(e) });
    if (threadId) return side("thread under the channel");
    if (e.archived) return side("the pane is closed");
    if (e.machine !== "rig") return side("Mac panes are continued in a rig side session");
    if (!e.sessionFile || !existsSync(e.sessionFile)) return side("the pane has no session file");
    if (await this.#liveOmp(e)) return side("an omp process holds the pane's session");
    return { mode: "pane", entry: e, sessionFile: e.sessionFile, cwd, key: `pane-${e.channelId}` };
  }

  /** Post target lookup for tail(). */
  async channel(channelId: string): Promise<SendableChannels | null> {
    const ch = await this.client?.channels.fetch(channelId).catch(() => null);
    return ch?.isSendable() ? ch : null;
  }
}
