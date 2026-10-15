import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CACHE_DIR, CONFIG, OMP_BIN, QUEUE_DIR, RUN_TIMEOUT_MS, SCRATCH_DIR, SESSIONS_DIR, STATE_DIR, trusted } from "./config.ts";
import { startEgressProxy } from "./egress.ts";
import { startHostExec, type RunContext } from "./hostexec.ts";
import { discover, discoverAsync, OMP_RW_DIRS, runEnv, sandboxCommand, serviceRepos, SMTP_PORT, type Discovery, type SandboxSpec } from "./sandbox.ts";
import { RunHeartbeat } from "./heartbeat.ts";
import { startTcpTunnel } from "./tunnels.ts";
import type { Entry } from "../gate/queue.ts";

export interface RunResult {
  ok: boolean;
  timedOut: boolean;
  /** Stopped by the owner (❌ button). */
  cancelled?: boolean;
  code: number | null;
  stdout: string;
  stderrTail: string;
  durationMs: number;
}

/** Session keys come from Discord snowflakes ("123…" or "dm-123…"). */
export function sessionDir(key: string): string {
  if (!/^[a-z0-9-]+$/i.test(key)) throw new Error("bad session key");
  return join(SESSIONS_DIR, key);
}

export function hasSession(key: string): boolean {
  const dir = sessionDir(key);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"));
}

/** Archive the session directory so the next run starts fresh. */
export function resetSession(key: string): void {
  const dir = sessionDir(key);
  if (existsSync(dir)) renameSync(dir, `${dir}.old-${Date.now()}`);
}

/** resumeFile: continue a mirrored pane's session file (bound writable at its own path). */
export function ompArgs(key: string, prompt: string, cont: boolean, resumeFile?: string): string[] {
  const args = ["-p", "--session-dir", sessionDir(key), "--max-time", `${Math.ceil(RUN_TIMEOUT_MS / 60_000)}m`];
  if (resumeFile) args.push("--resume", resumeFile);
  else if (cont) args.push("--continue");
  args.push(prompt);
  return args;
}

const REPO_DIR = resolve(import.meta.dir, "..");
let approvalListener: (e: Entry) => void = () => {};
/** The bridge's approval manager registers here; every run's `omp-approve` request is announced. */
export function onApprovalRequest(fn: (e: Entry) => void): void {
  approvalListener = fn;
}

let discoveryCache: { at: number; d: Discovery } | null = null;
let discoveryRefresh: Promise<void> | null = null;
/** Refresh the discovery cache off the main thread (no audio stalls). */
export function refreshDiscovery(home = homedir()): Promise<void> {
  discoveryRefresh ??= discoverAsync(home)
    .then((d) => void (discoveryCache = { at: Date.now(), d }))
    .catch(() => {})
    .finally(() => void (discoveryRefresh = null));
  return discoveryRefresh;
}
function cachedDiscovery(home: string): Discovery {
  if (!discoveryCache) discoveryCache = { at: Date.now(), d: discover(home) }; // first run only, if not primed
  else if (Date.now() - discoveryCache.at > 60_000) void refreshDiscovery(home); // stale: serve old, refresh in background
  return discoveryCache.d;
}

export interface RunTarget {
  /** Discord channel/thread where approval requests from this run are posted. */
  channelId: string;
  /** Mirrored pane session file to continue. */
  resumeFile?: string;
}

/** Remove per-run socket dirs left by bridge/test processes that are gone. */
function cleanStaleRunDirs(root: string): void {
  try {
    for (const f of readdirSync(root)) {
      const pid = Number(f.split("-")[0]);
      if (Number.isFinite(pid) && !existsSync(`/proc/${pid}`)) rmSync(join(root, f), { recursive: true, force: true });
    }
  } catch {}
}

/**
 * Spawn a command inside the capability sandbox with this run's bridge sockets (egress proxy,
 * optional SMTP tunnel, host-exec broker). Sockets are closed when the process exits.
 */
export function spawnSandboxed(key: string, cwd: string, cmd: string[], target: RunTarget): ChildProcess {
  const home = homedir();
  const runId = randomBytes(6).toString("hex");
  const runsRoot = join(STATE_DIR, "run");
  mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  cleanStaleRunDirs(runsRoot);
  const sockDir = join(runsRoot, `${process.pid}-${runId}`);
  mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  chmodSync(sockDir, 0o700);
  const scratchDir = join(SCRATCH_DIR, key);
  for (const d of [scratchDir, CACHE_DIR, sessionDir(key), join(home, "discord-scratch")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const d of OMP_RW_DIRS) mkdirSync(join(home, d), { recursive: true });
  const discovery = cachedDiscovery(home);
  const protectedTrees = serviceRepos(discovery.trees, home);
  const isUnder = (p: string, root: string) => p === root || p.startsWith(root + sep);
  const writableTrees = discovery.trees.filter((t) => !protectedTrees.some((p) => isUnder(t, p)));
  const ctx: RunContext = {
    runId,
    sessionKey: key,
    channelId: target.channelId,
    home,
    scratchDir,
    writableTrees,
    trees: discovery.trees,
    queueDir: QUEUE_DIR,
    onApprovalRequest: (e) => approvalListener(e),
  };
  if (trusted()) return spawnTrusted(key, cwd, cmd, { ...ctx, trusted: true }, sockDir, home);
  const servers = [startEgressProxy(join(sockDir, "egress.sock")), startHostExec(join(sockDir, "hostexec.sock"), ctx)];
  // Optional SMTP tunnel (config "smtp"): the run's /etc/hosts maps the SMTP host name to 127.0.0.1.
  const smtp = CONFIG.smtp && /^[A-Za-z0-9.-]+$/.test(CONFIG.smtp.host) ? CONFIG.smtp : undefined;
  let hostsFile: string | undefined;
  if (smtp) {
    servers.push(startTcpTunnel(join(sockDir, "smtp.sock"), smtp.host, smtp.port ?? SMTP_PORT));
    hostsFile = join(sockDir, "hosts");
    const base = readFileSync(join(REPO_DIR, "sandbox", "hosts"), "utf8");
    writeFileSync(hostsFile, `${base.trimEnd()}\n127.0.0.1\t${smtp.host}\n`, { mode: 0o644 });
  }
  const spec: SandboxSpec = {
    home,
    cwd,
    sessionDir: sessionDir(key),
    sockDir,
    bunBin: process.execPath,
    repoDir: REPO_DIR,
    scratchDir,
    cacheDir: CACHE_DIR,
    discovery,
    protectedTrees,
    paneSession: target.resumeFile ? { file: target.resumeFile, artifacts: target.resumeFile.replace(/\.jsonl$/, "") } : undefined,
    hostsFile,
    smtpTunnel: Boolean(smtp),
  };
  const { file, args } = sandboxCommand(spec, cmd);
  const child = spawn(file, args, {
    cwd,
    env: runEnv(process.env, { home, repoDir: REPO_DIR, gate: { OMP_GATE_SESSION: key, OMP_GATE_RUN: runId } }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.on("close", () => {
    for (const s of servers) s.close();
    rmSync(sockDir, { recursive: true, force: true });
  });
  return child;
}

/**
 * Trusted mode: the run is a normal process of the user (no bwrap, no proxy, real git/gh/ssh/sudo).
 * Only the host-exec socket stays, so `omp-approve` (the Discord Approve button) still works.
 */
function spawnTrusted(key: string, cwd: string, cmd: string[], ctx: RunContext, sockDir: string, home: string): ChildProcess {
  const sock = join(sockDir, "hostexec.sock");
  const server = startHostExec(sock, ctx);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^DISCORD/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home,
    PATH: [join(REPO_DIR, "gate", "bin-trusted"), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
    TERM: "dumb",
    OMP_DISCORD_BRIDGE: "1",
    OMP_DISCORD_SANDBOX: "off",
    OMP_GATE_BUN: process.execPath,
    OMP_GATE_HOME: join(REPO_DIR, "gate"),
    OMP_GATE_SOCKET: sock,
    OMP_GATE_SESSION: key,
    OMP_GATE_RUN: ctx.runId,
    GIT_TERMINAL_PROMPT: "0",
  });
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.on("close", () => {
    server.close();
    rmSync(sockDir, { recursive: true, force: true });
  });
  return child;
}

/**
 * Run `omp -p` for one message inside the capability sandbox. Session per Discord thread/channel
 * via --session-dir; follow-ups use --continue. Own process group so a timeout kills the whole tree.
 */
/** Running agent processes by Discord channel/thread id (one run per channel at a time), so the owner can stop one (❌ button). */
const active = new Map<string, () => void>();
const stopped = new Set<string>();
/** Heartbeat state of the running agent per channel/thread (src/heartbeat.ts; the Working message shows it). */
const heartbeats = new Map<string, RunHeartbeat>();

export function runHeartbeat(channelId: string): RunHeartbeat | undefined {
  return heartbeats.get(channelId);
}

/** Stop the run for `key` (SIGTERM, then SIGKILL). True if something was running. */
export function stopRun(channelId: string): boolean {
  const kill = active.get(channelId);
  if (!kill) return false;
  stopped.add(channelId);
  kill();
  return true;
}

export function runOmp(key: string, cwd: string, prompt: string, target: RunTarget): Promise<RunResult> {
  const cont = hasSession(key);
  const started = Date.now();
  const { promise, resolve: done } = Promise.withResolvers<RunResult>();
  // Created before spawn so it records the session file sizes this run starts from.
  const hb = new RunHeartbeat(started, sessionDir(key), target.resumeFile);
  const child = spawnSandboxed(key, cwd, [OMP_BIN, ...ompArgs(key, prompt, cont, target.resumeFile)], target);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let finished = false;
  child.stdout!.on("data", (d: Buffer) => {
    if (stdout.length < 2_000_000) stdout += d.toString();
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {}
  };
  if (child.pid) {
    hb.pid = child.pid;
    heartbeats.set(target.channelId, hb);
  }
  active.set(target.channelId, () => {
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 5_000).unref();
  });
  // Hard backstop in case --max-time does not end the process.
  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 10_000).unref();
  }, RUN_TIMEOUT_MS + 30_000);
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    active.delete(target.channelId);
    heartbeats.delete(target.channelId);
    const cancelled = stopped.delete(target.channelId);
    const durationMs = Date.now() - started;
    // --max-time ends the session itself; a run that hit the limit counts as a timeout.
    if (durationMs >= RUN_TIMEOUT_MS) timedOut = true;
    done({ ok: code === 0 && !timedOut && !cancelled, timedOut, cancelled, code, stdout: stdout.trim(), stderrTail: stderr.trim(), durationMs });
  };
  child.on("error", (e) => {
    stderr += `\nspawn error: ${e.message}`;
    finish(null);
  });
  child.on("close", (code) => finish(code));
  return promise;
}
