// Pending-approval queue for the password-gated broker. Owned by the bridge (outside every run):
// runs can only *request* through the per-run host-exec socket, never write here (the bot state dir
// is hidden in the sandbox).
//
// Layout under <dir>: pending/<id>.json (waiting), claimed/<id>.json (approved, running or ran),
// closed/<id>.json (denied/cancelled/expired/rejected), receipts/<id>.json, posted/<id>.json (bot).
// Integrity: the bot posts the command and passes sha256(entry) to the approval tab on its command
// line. The tab refuses if the entry no longer hashes the same (changed since posting). Claiming is
// an atomic rename pending → claimed, so an entry runs at most once, and a cancel (rename
// pending → closed) and an approval cannot both win. Entries expire 30 minutes after creation.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APPROVAL_TTL_MS = 30 * 60_000;
export const ID_RE = /^[a-z2-9]{8}$/;

export interface Entry {
  v: 1;
  id: string;
  createdAt: number;
  expiresAt: number;
  /** Exact command, run with `bash -c` in cwd after approval. */
  command: string;
  cwd: string;
  /** The agent's stated reason (display only). */
  reason: string;
  /** Discord channel/thread to post in and the session key whose next prompt gets the result. */
  channelId: string;
  sessionKey: string;
  runId: string;
}

export type ReceiptStatus = "ran" | "denied" | "cancelled" | "expired" | "rejected" | "error";
export interface Receipt {
  id: string;
  status: ReceiptStatus;
  exitCode?: number | null;
  /** Truncated, privacy-filtered output (never secret values). */
  output?: string;
  detail: string;
  at: number;
}

const DIRS = ["pending", "claimed", "closed", "receipts", "posted"] as const;

export function ensureQueue(dir: string): void {
  for (const d of ["", ...DIRS]) {
    mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
    chmodSync(join(dir, d), 0o700);
  }
}

export function newId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
}

/** sha256 over every field that decides what runs, where and until when. */
export function hashEntry(e: Entry): string {
  return createHash("sha256")
    .update(JSON.stringify([e.v, e.id, e.createdAt, e.expiresAt, e.command, e.cwd, e.channelId, e.sessionKey, e.runId]))
    .digest("hex");
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function createEntry(
  dir: string,
  req: Pick<Entry, "command" | "cwd" | "reason" | "channelId" | "sessionKey" | "runId">,
  now = Date.now(),
): Entry {
  ensureQueue(dir);
  if (!req.command.trim()) throw new Error("empty command");
  if (req.command.length > 8000) throw new Error("command too long");
  let id = newId();
  while (DIRS.some((d) => existsSync(join(dir, d, `${id}.json`)))) id = newId();
  const e: Entry = { v: 1, id, createdAt: now, expiresAt: now + APPROVAL_TTL_MS, ...req };
  writeAtomic(join(dir, "pending", `${id}.json`), e);
  return e;
}

export function readEntry(dir: string, state: "pending" | "claimed" | "closed", id: string): Entry | null {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, state, `${id}.json`), "utf8")) as Entry;
  } catch {
    return null;
  }
}

export function listPending(dir: string): string[] {
  try {
    return readdirSync(join(dir, "pending"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => ID_RE.test(id));
  } catch {
    return [];
  }
}

/** Atomically move a pending entry; false when it is no longer pending (already claimed/closed). */
export function movePending(dir: string, id: string, to: "claimed" | "closed"): boolean {
  if (!ID_RE.test(id)) return false;
  try {
    renameSync(join(dir, "pending", `${id}.json`), join(dir, to, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export function writeReceipt(dir: string, r: Receipt): void {
  ensureQueue(dir);
  const file = join(dir, "receipts", `${r.id}.json`);
  if (existsSync(file)) return; // first receipt wins
  writeAtomic(file, r);
}

export function readReceipt(dir: string, id: string): Receipt | null {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, "receipts", `${id}.json`), "utf8")) as Receipt;
  } catch {
    return null;
  }
}

/** Bot-side record of a posted entry (survives bot restarts). */
export interface Posted {
  id: string;
  hash: string;
  tabId?: string;
  paneId?: string;
  resultPosted?: boolean;
}

export function writePosted(dir: string, p: Posted): void {
  writeAtomic(join(dir, "posted", `${p.id}.json`), p);
}

export function readPosted(dir: string, id: string): Posted | null {
  try {
    return JSON.parse(readFileSync(join(dir, "posted", `${id}.json`), "utf8")) as Posted;
  } catch {
    return null;
  }
}

export function listPosted(dir: string): Posted[] {
  try {
    return readdirSync(join(dir, "posted"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readPosted(dir, f.slice(0, -5)))
      .filter((p): p is Posted => p !== null);
  } catch {
    return [];
  }
}

/**
 * Cancel a pending entry (owner `!deny <id>`, the CLI, or expiry). Returns false when the entry was
 * already claimed by the approval tab (then it has started and cannot be cancelled).
 */
export function cancelEntry(dir: string, id: string, status: "cancelled" | "expired" | "rejected" | "denied", detail: string): boolean {
  if (!movePending(dir, id, "closed")) return false;
  writeReceipt(dir, { id, status, detail, at: Date.now() });
  return true;
}
