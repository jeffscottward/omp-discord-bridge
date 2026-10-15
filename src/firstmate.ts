// "Send to FIRSTMATE" (owner-only button on paste blocks). User decision 2026-10-12: deliver the
// block to the interactive FIRSTMATE pane, the one exception to "never type into panes", and only
// when it is safe:
//   1. FIRSTMATE's omp is not working: `herdr agent get` reports idle/done AND the session JSONL's
//      last turn entry is a completed assistant turn (stopReason "stop");
//   2. its input box is empty: `herdr agent read --source visible --lines 6` (bottom of the screen
//      only: status bar + editor), checked in memory, never logged or posted. Anything that does
//      not match the known empty-editor layout is refused.
// Both are checked when the button is pressed and again immediately before `herdr agent prompt`.
// Only the configured FIRSTMATE pane (tab label FIRSTMATE, omp agent) is ever a target.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG, FIRSTMATE_SESSION, STATE_DIR } from "./config.ts";

/** Herdr pane id from the bot config ("firstmate.pane"); empty: the button never delivers. */
export const FIRSTMATE_PANE = process.env.OMP_BOT_FIRSTMATE_PANE ?? CONFIG.firstmate?.pane ?? "";
export const FIRSTMATE_TAB_LABEL = FIRSTMATE_SESSION.tabLabel;
export const SEND_BUTTON_ID = "fm-send";
export const BUSY_TEXT = "FIRSTMATE is busy or you are typing — try again";
export const SENT_LABEL = "[Sent from Discord by the owner via button]";
const DELIVERY_LOG = join(STATE_DIR, "firstmate-deliveries.jsonl");
const SESSIONS_ROOT = join(homedir(), ".omp", "agent", "sessions");
const MAX_BLOCK = 60_000;
const TAIL_BYTES = 256 * 1024;
const REPEAT_MS = 30_000;

export type Check = { ok: true } | { ok: false; reason: string };
type Herdr = (args: string[]) => { code: number; out: string };

/** `herdr agent get <pane>` → the pane's session file, if it is an idle omp agent on that pane. */
export function agentState(raw: string, pane: string): { ok: true; sessionFile: string; tabId: string } | { ok: false; reason: string } {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(raw).result.agent;
  } catch {
    return { ok: false, reason: "FIRSTMATE pane not found" };
  }
  if (a?.pane_id !== pane || a.agent !== "omp") return { ok: false, reason: "FIRSTMATE pane is not an omp agent" };
  if (a.agent_status !== "idle" && a.agent_status !== "done") return { ok: false, reason: `agent ${String(a.agent_status)}` };
  const s = a.agent_session as { kind?: string; value?: unknown } | undefined;
  if (s?.kind !== "path" || typeof s.value !== "string" || !s.value.endsWith(".jsonl") || !s.value.startsWith(`${SESSIONS_ROOT}/`))
    return { ok: false, reason: "no session file" };
  return { ok: true, sessionFile: s.value, tabId: String(a.tab_id ?? "") };
}

/** `herdr tab get <tab>` → true when it is the FIRSTMATE tab. */
export function isFirstmateTab(raw: string): boolean {
  try {
    return JSON.parse(raw).result.tab.label === FIRSTMATE_TAB_LABEL;
  } catch {
    return false;
  }
}

/** Entries OMP appends after a finished turn that do not start a new one. */
const AFTER_TURN: Record<string, true> = {
  model_usage: true,
  title_change: true,
  thinking_level_change: true,
  model_change: true,
  service_tier_change: true,
  "custom:todo_hud_state": true,
  credential_pin: true,
  mode_change: true,
  "custom_message:advisor": true,
};

/** Session tail: the last turn entry must be a completed assistant turn. */
export function sessionIdle(tail: string): Check {
  if (!tail.endsWith("\n")) return { ok: false, reason: "session is being written" };
  const lines = tail.split("\n").filter((l) => l.trim());
  // The first line of a tail read may be cut; it is only parsed if nothing after it decides.
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: { type?: string; customType?: string; message?: { role?: string; stopReason?: string } };
    try {
      e = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, reason: "session unreadable" };
    }
    const kind = e.customType ? `${e.type}:${e.customType}` : String(e.type);
    if (AFTER_TURN[kind]) continue;
    if (e.type === "message" && e.message?.role === "assistant" && e.message.stopReason === "stop") return { ok: true };
    return { ok: false, reason: "turn in progress" };
  }
  return { ok: false, reason: "no completed turn" };
}

const STATUS_BAR_RE = /^\ue0b6.*\ue0b0/;
/** Right-aligned hint OMP shows in an empty editor while background agents run. */
const EMPTY_HINT_RE = /^\s{10,}(?:←\s*)*to see \d+ running agents?\s*$/;

/**
 * Bottom lines of the pane (`--source visible`): OMP's status bar, then the editor whose first
 * line starts with "╰─". Empty means nothing after "╰─" (or only the known right-aligned hint)
 * and nothing below it. Any other layout (popup, selector, multi-line draft) is refused.
 */
export function editorEmpty(screen: string): Check {
  const lines = screen.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !lines[i]!.startsWith("╰─")) i--;
  if (i < 1 || !STATUS_BAR_RE.test(lines[i - 1]!)) return { ok: false, reason: "input box not recognized" };
  const rest = lines[i]!.slice(2);
  if (rest.trim() && !EMPTY_HINT_RE.test(rest)) return { ok: false, reason: "input box not empty" };
  if (lines.slice(i + 1).some((l) => l.trim())) return { ok: false, reason: "input box not empty" };
  return { ok: true };
}

function readTail(file: string): string | null {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function defaultHerdr(args: string[]): { code: number; out: string } {
  const r = spawnSync("herdr", args, { encoding: "utf8", timeout: 10_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
}

export interface SenderDeps {
  herdr?: Herdr;
  readTail?: (file: string) => string | null;
  log?: (...a: unknown[]) => void;
  pane?: string;
  logFile?: string;
  now?: () => number;
}

export class FirstmateSender {
  private readonly herdr: Herdr;
  private readonly tail: (file: string) => string | null;
  private readonly log: (...a: unknown[]) => void;
  readonly pane: string;
  private readonly logFile: string;
  private readonly now: () => number;
  private readonly lastSent = new Map<string, number>();

  constructor(deps: SenderDeps = {}) {
    this.herdr = deps.herdr ?? defaultHerdr;
    this.tail = deps.readTail ?? readTail;
    this.log = deps.log ?? (() => {});
    this.pane = deps.pane ?? FIRSTMATE_PANE;
    this.logFile = deps.logFile ?? DELIVERY_LOG;
    this.now = deps.now ?? Date.now;
  }

  /** Both guards: not working (herdr + session JSONL) and an empty input box. */
  check(): Check {
    if (!this.pane) return { ok: false, reason: "no FIRSTMATE pane configured (firstmate.pane in config.json)" };
    const st = agentState(this.herdr(["agent", "get", this.pane]).out, this.pane);
    if (!st.ok) return st;
    if (!isFirstmateTab(this.herdr(["tab", "get", st.tabId]).out)) return { ok: false, reason: "pane is not in the FIRSTMATE tab" };
    const tail = this.tail(st.sessionFile);
    if (tail === null) return { ok: false, reason: "session unreadable" };
    const idle = sessionIdle(tail);
    if (!idle.ok) return idle;
    const screen = this.herdr(["agent", "read", this.pane, "--source", "visible", "--lines", "6"]);
    if (screen.code !== 0) return { ok: false, reason: "input box unreadable" };
    return editorEmpty(screen.out);
  }

  /** Re-check immediately before sending, then submit the labelled block. Logs id/time, never content. */
  deliver(block: string, messageId: string): { ok: true; id: string } | { ok: false; reason: string } {
    const id = `fm-${this.now().toString(36)}`;
    const record = (status: string, reason?: string) => {
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        appendFileSync(this.logFile, `${JSON.stringify({ id, at: new Date(this.now()).toISOString(), messageId, status, reason, chars: block.length })}\n`, { mode: 0o600 });
      } catch {}
      this.log(`firstmate-send ${id} msg=${messageId} ${status}${reason ? ` (${reason})` : ""}`);
    };
    if (!block.trim() || block.length > MAX_BLOCK) {
      record("refused", "empty or too long");
      return { ok: false, reason: "empty or too long" };
    }
    const prev = this.lastSent.get(messageId);
    if (prev && this.now() - prev < REPEAT_MS) {
      record("refused", "just sent");
      return { ok: false, reason: "this block was sent a moment ago" };
    }
    const c = this.check();
    if (!c.ok) {
      record("refused", c.reason);
      return c;
    }
    const r = this.herdr(["agent", "prompt", this.pane, `${SENT_LABEL}\n\n${block}`]);
    if (r.code !== 0) {
      record("failed", "herdr agent prompt failed");
      return { ok: false, reason: "herdr agent prompt failed" };
    }
    this.lastSent.set(messageId, this.now());
    record("delivered");
    return { ok: true, id };
  }
}

/** Owner-only: the button must be pressed by the owner, on one of the bridge's own messages, in the owner's server or DM. */
export function buttonAllowed(p: { userId: string; ownerId: string; guildId: string | null; ownGuildId: string; isDM: boolean; messageAuthorId: string; botId: string | undefined }): boolean {
  if (p.userId !== p.ownerId) return false;
  if (!p.botId || p.messageAuthorId !== p.botId) return false;
  return p.isDM ? p.guildId === null : p.guildId === p.ownGuildId;
}
