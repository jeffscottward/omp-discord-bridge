// Scratch test of pane mode: a session that no omp process holds is continued by the bridge's
// sandboxed `omp -p --resume` (only that file is mounted). The new turn must land on the active
// branch: a fresh process reloading the file sees it.
// Usage: bun scripts/pane-resume-test.ts
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_CHANNEL_ID, OMP_BIN, requireConfig } from "../src/config.ts";
import { runOmp } from "../src/omp.ts";

const DIR = "/tmp/omp-pane-resume-test";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
requireConfig();
const CWD = join(homedir(), "Github");

function collect(child: ChildProcess): Promise<{ code: number | null; out: string }> {
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
  child.on("close", (code) => resolve({ code, out: out.trim() }));
  return promise;
}
const omp = (args: string[]) => collect(spawn(OMP_BIN, args, { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] }));

console.log("### 1. 'pane' session created by a normal omp run, which then exits (nothing holds it)");
console.log(await omp(["-p", "--session-dir", DIR, "Reply with exactly: P1"]));
const file = join(DIR, readdirSync(DIR).find((f) => f.endsWith(".jsonl"))!);

console.log("### 2. bridge continues it in the sandbox (pane mode)");
const r = await runOmp("pane-resume-test", CWD, "Reply with exactly: D1", { channelId: DEV_CHANNEL_ID, resumeFile: file });
console.log({ ok: r.ok, code: r.code, out: r.stdout.slice(-200) });

console.log("### 3. fresh process reloads the file");
console.log(await omp(["-p", "--session-dir", DIR, "--resume", file, "List in order every user message you can see in this conversation, one per line, nothing else."]));
process.exit(0);
