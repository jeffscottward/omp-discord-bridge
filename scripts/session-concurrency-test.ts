// Scratch test: can a second process append a turn to an OMP session that a live (interactive)
// omp process holds, without corrupting it? Uses only a throwaway session.
// A = long-lived `omp --mode rpc` holding the session (stands in for a Herdr pane).
// B = the bridge's sandboxed `omp -p --resume <file>` appending one turn while A is alive.
// Then A takes another turn, and a fresh process C reloads the file.
// Usage: bun scripts/session-concurrency-test.ts
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_CHANNEL_ID, OMP_BIN, requireConfig } from "../src/config.ts";
import { sessionDir, spawnSandboxed } from "../src/omp.ts";

const KEY = "scratch-concurrency";
const DIR = sessionDir(KEY);
rmSync(DIR, { recursive: true, force: true });
requireConfig();
const CWD = join(homedir(), "Github");

function collect(child: ChildProcess): Promise<{ code: number | null; out: string }> {
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", () => {});
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
  child.on("close", (code) => resolve({ code, out: out.trim() }));
  return promise;
}

// --- A: holder
const a = spawn(OMP_BIN, ["--mode", "rpc", "--session-dir", DIR], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const waiters = new Map<string, (v: unknown) => void>();
a.stdout.on("data", (d) => {
  buf += d;
  let i: number;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const f = JSON.parse(line);
      if (f.type === "prompt_result" && waiters.has(f.id)) waiters.get(f.id)!(f);
    } catch {}
  }
});
a.stderr.on("data", () => {});
function promptA(id: string, message: string): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  waiters.set(id, resolve);
  a.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  return promise;
}

const step = (s: string) => console.log(`\n### ${s}`);
step("A (holder) turn 1");
console.log(JSON.stringify(await promptA("a1", "Reply with exactly: A1")));
const file = join(DIR, readdirSync(DIR).find((f) => f.endsWith(".jsonl"))!);
console.log("session file:", file);

step("B (sandboxed omp -p --resume) appends while A is alive");
const b = await collect(
  spawnSandboxed(KEY, CWD, [OMP_BIN, "-p", "--session-dir", DIR, "--resume", file, "Reply with exactly: B1"], { channelId: DEV_CHANNEL_ID }),
);
console.log(`B exit ${b.code}: ${b.out.slice(-300)}`);

step("A (holder) turn 2 after B");
console.log(JSON.stringify(await promptA("a2", "Reply with exactly: A2, then list in order every user message you can see in this conversation.")));
a.stdin.end();
await collect(a);

step("file analysis");
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
let bad = 0;
type Entry = { id?: string; parentId?: string | null; type?: string; message?: { role?: string; content?: unknown } };
const entries: Entry[] = [];
for (const l of lines) {
  try {
    entries.push(JSON.parse(l));
  } catch {
    bad++;
  }
}
const ids = new Set(entries.map((e) => e.id).filter(Boolean));
const dangling = entries.filter((e) => e.parentId && !ids.has(e.parentId)).length;
const children = new Map<string, number>();
for (const e of entries) if (e.parentId) children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
const branches = [...children.values()].filter((n) => n > 1).length;
const userText = (e: Entry) => {
  const c = e.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join(" ") : "";
};
const users = entries.filter((e) => e.type === "message" && e.message?.role === "user").map((e) => userText(e).slice(0, 40));
console.log({ lines: lines.length, badJsonLines: bad, danglingParents: dangling, branchPoints: branches, userMessagesInFileOrder: users });

step("C (fresh process) reloads the file");
const c = await collect(
  spawn(OMP_BIN, ["-p", "--session-dir", DIR, "--resume", file, "List in order every user message you can see in this conversation, one per line, nothing else."], { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] }),
);
console.log(`C exit ${c.code}:\n${c.out.slice(-600)}`);
process.exit(0);
