// Heartbeat for the ⚙️ Working… message (owner 2026-10-15): every 10 s the bridge checks the run itself
// (is the process tree alive, does it use CPU, does the session log grow, which tool is running) and
// edits the Working message with the result, so the owner can tell a slow run from a stuck one.
// Only tool names and their short intent text are shown (never commands, arguments or output).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORKING_EMOJI } from "./config.ts";
import { redact } from "./redact.ts";

export const HEARTBEAT_MS = 10_000;
/** No log write, no pending tool and almost no CPU for this long: report "may be stuck". */
export const STUCK_MS = 5 * 60_000;
const CLK_TCK = 100; // Linux USER_HZ

export interface TreeSample {
  alive: boolean;
  procs: number;
  /** utime+stime of every process in the tree, in clock ticks. */
  ticks: number;
}

/** Sum CPU time over the process and all its descendants (walks /proc by parent pid). */
export function sampleTree(rootPid: number, procDir = "/proc"): TreeSample {
  const kids = new Map<number, number[]>();
  const ticks = new Map<number, number>();
  let names: string[] = [];
  try {
    names = readdirSync(procDir);
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(procDir, n, "stat"), "utf8");
    } catch {
      continue; // exited between readdir and read
    }
    // Fields after "(comm)": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime …
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pid = Number(n);
    const ppid = Number(f[1]);
    ticks.set(pid, Number(f[11]) + Number(f[12]));
    (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
  }
  if (!ticks.has(rootPid)) return { alive: false, procs: 0, ticks: 0 };
  let procs = 0;
  let sum = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    procs++;
    sum += ticks.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return { alive: true, procs, ticks: sum };
}

interface Pending {
  name: string;
  intent: string;
  since: number;
}

/** Reads only the bytes a session JSONL gained since the last tick. */
export class SessionTail {
  private offset = 0;
  private partial = "";
  toolCalls = 0;
  lastEntryAt = 0;
  /** What the last complete entry was: the model then works ("model") or a tool runs ("tool"). */
  lastKind: "model" | "tool" | "none" = "none";
  readonly pending = new Map<string, Pending>();

  constructor(
    readonly file: string,
    startOffset = 0,
  ) {
    this.offset = startOffset;
  }

  /** Feed raw JSONL text (exposed for tests). */
  ingest(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: { type?: string; timestamp?: string; message?: { role?: string; toolCallId?: string; content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const m = e.message;
      if (e.type !== "message" || !m) continue;
      const at = Date.parse(e.timestamp ?? "") || Date.now();
      this.lastEntryAt = Math.max(this.lastEntryAt, at);
      if (m.role === "assistant") {
        const calls = Array.isArray(m.content) ? m.content.filter((p: { type?: string }) => p?.type === "toolCall") : [];
        for (const c of calls as { id?: string; name?: string; intent?: string; arguments?: { i?: string } }[]) {
          this.toolCalls++;
          if (c.id) this.pending.set(c.id, { name: c.name ?? "tool", intent: c.intent ?? c.arguments?.i ?? "", since: at });
        }
        this.lastKind = calls.length ? "tool" : "none";
      } else if (m.role === "toolResult") {
        if (m.toolCallId) this.pending.delete(m.toolCallId);
        this.lastKind = this.pending.size ? "tool" : "model";
      } else if (m.role === "user") {
        this.lastKind = "model";
      }
    }
  }

  /** Read new bytes from disk; returns the file's mtime (0 if missing). */
  poll(): number {
    if (!existsSync(this.file)) return 0;
    const st = statSync(this.file);
    if (st.size < this.offset) this.offset = 0; // file replaced
    if (st.size > this.offset) {
      const fd = openSync(this.file, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size - this.offset, 8 * 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += n;
        this.ingest(buf.subarray(0, n).toString("utf8"));
      } finally {
        closeSync(fd);
      }
    }
    return st.mtimeMs;
  }
}

export interface HeartbeatView {
  now: number;
  startedAt: number;
  tree: TreeSample;
  /** CPU use of the whole tree since the previous sample, as % of one core. */
  cpuPct: number;
  /** Last session-log write (ms epoch), 0 if none yet. */
  lastWrite: number;
  toolCalls: number;
  pending: Pending[];
  lastKind: "model" | "tool" | "none";
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** A run that has written nothing to its session after 8 s is compacting: normal runs write within ~2 s. */
export const COMPACT_MS = 60_000;
export function compacting(v: HeartbeatView): boolean {
  return v.tree.alive && !v.lastWrite && !v.pending.length && v.now - v.startedAt >= 8_000;
}

export type Verdict = "alive" | "waiting" | "stuck" | "gone";

export function verdict(v: HeartbeatView): Verdict {
  if (!v.tree.alive) return "gone";
  const quiet = v.now - (v.lastWrite || v.startedAt);
  if (quiet < 60_000 || v.cpuPct >= 2) return "alive";
  if (quiet >= STUCK_MS && !v.pending.length) return "stuck";
  return "waiting";
}

/** The Working message text. Discord renders <t:…:T> in the owner's own time zone. */
export function formatHeartbeat(v: HeartbeatView): string {
  const vd = verdict(v);
  const head = {
    alive: "🟢 **Alive**",
    waiting: "🟡 **Quiet, still running**",
    stuck: `🔴 **No activity for ${dur(v.now - (v.lastWrite || v.startedAt))}; it may be stuck.** Tap ❌ Stop to end it.`,
    gone: "❌ **The agent process has exited.** The answer should arrive shortly.",
  }[vd];
  const lines = [`${WORKING_EMOJI} Working… ${dur(v.now - v.startedAt)}`, `${head} · checked <t:${Math.floor(v.now / 1000)}:T>`];
  const p = v.pending.at(-1);
  if (p) {
    const what = redact(p.intent.replace(/\s+/g, " ").replace(/[`*_~|]/g, "").slice(0, 80)).text;
    lines.push(`🔧 Running \`${p.name}\`${what ? `: ${what}` : ""} (${dur(v.now - p.since)})${v.pending.length > 1 ? ` +${v.pending.length - 1} more` : ""}`);
  } else if (compacting(v)) {
    // Owner 2026-10-15: measured compactions took 58–61 s (3 in one session log).
    const left = COMPACT_MS - (v.now - v.startedAt);
    lines.push(`🗜️ Compacting memory (usually ~60 s${left > 0 ? `, about ${dur(left)} left` : ", almost done"})`);
  } else if (v.lastKind === "model" || v.lastKind === "none") {
    lines.push(`🧠 Model is thinking or writing (${dur(v.now - (v.lastWrite || v.startedAt))})`);
  }
  if (v.tree.alive) {
    const log = v.lastWrite ? `log written ${dur(v.now - v.lastWrite)} ago` : "no log yet";
    lines.push(`📝 ${log} · ${v.toolCalls} tool calls · CPU ${Math.round(v.cpuPct)}% · ${v.tree.procs} procs`);
  }
  return lines.join("\n");
}

/** Newest .jsonl directly in `dir` (the session a `--continue`/new run writes). */
export function newestJsonl(dir: string): string | null {
  let best: { f: string; t: number } | null = null;
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith(".jsonl")) continue;
      const f = join(dir, n);
      const t = statSync(f).mtimeMs;
      if (!best || t > best.t) best = { f, t };
    }
  } catch {}
  return best?.f ?? null;
}

/** Per-run state: call tick() every HEARTBEAT_MS to get the next message text. */
export class RunHeartbeat {
  private tail: SessionTail | null = null;
  private prev: { at: number; ticks: number } | null = null;
  /** Session file sizes at run start, so a continued session only counts this run's entries. */
  private readonly startSizes = new Map<string, number>();

  /** Root pid of the run's process tree; set right after spawn. */
  pid = 0;

  constructor(
    readonly startedAt: number,
    readonly sessionDir: string,
    readonly resumeFile?: string,
  ) {
    let files: string[] = [];
    if (resumeFile) files = [resumeFile];
    else {
      try {
        files = readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl")).map((n) => join(sessionDir, n));
      } catch {}
    }
    for (const f of files) {
      try {
        this.startSizes.set(f, statSync(f).size);
      } catch {}
    }
  }

  tick(now = Date.now()): string {
    const file = this.resumeFile ?? newestJsonl(this.sessionDir);
    if (file && this.tail?.file !== file) this.tail = new SessionTail(file, this.startSizes.get(file) ?? 0);
    const mtime = this.tail?.poll() ?? 0;
    const tree = sampleTree(this.pid);
    const cpuPct = this.prev && now > this.prev.at ? (((tree.ticks - this.prev.ticks) / CLK_TCK) * 1000 * 100) / (now - this.prev.at) : 0;
    this.prev = { at: now, ticks: tree.ticks };
    const t = this.tail;
    // A session file modified after the run started was written by this run.
    const lastWrite = Math.max(t?.lastEntryAt ?? 0, mtime >= this.startedAt ? mtime : 0);
    return formatHeartbeat({
      now,
      startedAt: this.startedAt,
      tree,
      cpuPct: Math.max(0, cpuPct),
      lastWrite,
      toolCalls: t?.toolCalls ?? 0,
      pending: t ? [...t.pending.values()] : [],
      lastKind: t?.lastKind ?? "none",
    });
  }
}
