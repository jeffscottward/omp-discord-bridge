// Host-exec broker: one Unix socket per Discord run, bound read-only into the sandbox at
// /tmp/.omp-discord-sandbox/sock/hostexec.sock. The in-sandbox wrappers (gate/bin) send one JSON
// request per connection; the bridge validates it here and runs only fixed, non-serious host
// commands that need capabilities the sandbox deliberately lacks:
// - git push/fetch/pull/clone/ls-remote (GitHub credentials stay in the keyring, outside the run);
//   https only, hooks off, repo-local config limited to an allow-list.
// - gh (except auth/extension/alias/config/codespace), systemctl --user read verbs, herdr read
//   commands, op item names (never values).
// Anything else the user must approve goes through `omp-approve` → the password-gated queue.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { createEntry, readEntry, readReceipt, type Entry } from "../gate/queue.ts";
import { SCRATCH_NAME } from "./sandbox.ts";

export interface RunContext {
  /** Trusted mode: the run is a host process, so /tmp is the real /tmp. */
  trusted?: boolean;
  runId: string;
  sessionKey: string;
  /** Discord channel/thread for approval posts. */
  channelId: string;
  home: string;
  /** Host dir behind ~/discord-scratch. */
  scratchDir: string;
  /** Git trees writable inside the run. */
  writableTrees: string[];
  /** All git trees under ~/Github (incl. read-only ones). */
  trees: string[];
  queueDir: string;
  onApprovalRequest: (e: Entry) => void;
}

export type Request =
  | { type: "exec"; argv: string[]; cwd: string }
  | { type: "approve"; command: string; cwd: string; reason?: string }
  | { type: "receipt"; id: string };

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUT = 1024 * 1024;
const GIT_BROKER = ["push", "fetch", "pull", "clone", "ls-remote"];
const GIT_CONFIG_OK =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|symlinks|eol|safecrlf|quotepath)|remote\.[^.]+(\.[^.]+)*\.(url|pushurl|fetch|push|mirror|tagopt|prune|prunetags|promisor|partialclonefilter)|branch\.[^.]+(\.[^.]+)*\.(remote|merge|rebase|pushremote|description)|user\.(name|email)|pull\.(rebase|ff)|push\.(default|autosetupremote|followtags)|fetch\.prune|init\.defaultbranch|extensions\.(worktreeconfig|objectformat|partialclone)|gc\.[a-z]+|maintenance\.[a-z.]+|lfs\.[a-z.]+|submodule\.[^.]+(\.[^.]+)*\.(url|active|path))$/i;
/** Forced on every brokered git (and gh's git): hooks and fsmonitor off, https transport only. */
export const GIT_ENV: Record<string, string> = {
  GIT_ALLOW_PROTOCOL: "https",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "protocol.ext.allow",
  GIT_CONFIG_VALUE_2: "never",
};
const GH_DENY = new Set(["auth", "extension", "extensions", "ext", "alias", "config", "codespace", "cs", "ssh-key", "gpg-key", "attestation"]);
const GH_WRITES_TREE = /^(pr (checkout|co)|repo (clone|sync|fork)|gist clone|release download|run download)$/;
const SYSTEMCTL_VERBS = new Set(["is-active", "is-enabled", "is-failed", "status", "show", "cat", "list-units", "list-timers", "list-unit-files", "list-sockets", "list-dependencies", "list-jobs"]);
const SYSTEMCTL_OPTS = /^(--user|--no-pager|--no-legend|--full|-l|--all|-a|--plain|--quiet|-q|--value|--lines=\d+|-n\d*|--output=[a-z-]+|-o[a-z-]*|--state=[a-z,-]+|--type=[a-z,]+|--property=[A-Za-z,]+|-p[A-Za-z,]*|--failed|--recursive|-r|--reverse|--no-ask-password)$/;
const ID = /^[A-Za-z0-9:@._*\[\]-]+$/;
const HERDR_READ = new Set(["agent list", "agent get", "tab list", "tab get", "pane list", "pane get", "pane current", "pane layout", "pane process-info", "pane neighbor", "pane edges", "workspace list", "workspace get", "worktree list", "session list", "api snapshot", "api schema", "notification list", "machine list"]);

const isInside = (p: string, root: string) => p === root || p.startsWith(root + sep);

/** Map an in-sandbox path to the host path (null: private to the sandbox, e.g. /tmp). */
export function hostPath(ctx: Pick<RunContext, "home" | "scratchDir" | "trusted">, p: string, trustedMode = ctx.trusted === true): string | null {
  const abs = resolve(p);
  // Trusted runs are host processes: /tmp is the real /tmp, not a private sandbox tmpfs.
  if (trustedMode) return abs;
  const scratch = join(ctx.home, SCRATCH_NAME);
  if (isInside(abs, scratch)) return join(ctx.scratchDir, abs.slice(scratch.length));
  if (isInside(abs, "/tmp")) return null;
  return abs;
}

/** Host path is writable by this run (a writable git tree or its scratch dir). */
export function isWritable(ctx: Pick<RunContext, "writableTrees" | "scratchDir">, p: string): boolean {
  return isInside(p, ctx.scratchDir) || ctx.writableTrees.some((t) => isInside(p, t));
}

/** Repo-local git config keys outside the allow-list (they could run code when git runs outside the sandbox). */
export function badGitConfig(cwd: string): string[] {
  const r = spawnSync("git", ["config", "--local", "--list", "--name-only"], { cwd, encoding: "utf8", timeout: 10_000 });
  const keys = (r.stdout ?? "").split("\n").filter(Boolean);
  const wt = spawnSync("git", ["config", "--worktree", "--list", "--name-only"], { cwd, encoding: "utf8", timeout: 10_000 });
  if (wt.status === 0) keys.push(...(wt.stdout ?? "").split("\n").filter(Boolean));
  return keys.filter((k) => !GIT_CONFIG_OK.test(k));
}

export type Plan = { ok: true; file: string; args: string[]; cwd: string; env?: Record<string, string>; timeoutMs: number } | { ok: false; error: string };

/** Validate one exec request and turn it into a host command. Pure apart from fs/git config reads. */
export function planExec(ctx: RunContext, argv: string[], sandboxCwd: string): Plan {
  const [name, ...args] = argv;
  if (!name || args.some((a) => typeof a !== "string" || a.includes("\0"))) return { ok: false, error: "bad request" };
  const cwd = hostPath(ctx, sandboxCwd);
  if (!cwd || !existsSync(cwd)) return { ok: false, error: `working directory ${sandboxCwd} is private to the sandbox (/tmp); use ~/discord-scratch or a repo under ~/Github` };
  if (name === "git") return planGit(ctx, args, cwd);
  if (name === "gh") {
    const pos = args.filter((a) => !a.startsWith("-"));
    if (!pos[0] || GH_DENY.has(pos[0])) return { ok: false, error: `gh ${pos[0] ?? ""} is not available in Discord runs` };
    if (args.some((a) => /^--?(show-)?token\b/.test(a))) return { ok: false, error: "token output is not available" };
    if (GH_WRITES_TREE.test(`${pos[0]} ${pos[1] ?? ""}`) && !isWritable(ctx, cwd)) return { ok: false, error: `${cwd} is read-only for Discord runs` };
    if (spawnSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" }).status === 0) {
      const bad = badGitConfig(cwd);
      if (bad.length) return { ok: false, error: `repo config keys not allowed outside the sandbox: ${bad.join(", ")}` };
    }
    return { ok: true, file: "gh", args, cwd, env: { ...GIT_ENV, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, timeoutMs: 10 * 60_000 };
  }
  if (name === "systemctl") {
    if (!args.includes("--user")) return { ok: false, error: "only systemctl --user read commands are available (system units: use omp-approve)" };
    const pos = args.filter((a) => !a.startsWith("-"));
    if (!pos[0] || !SYSTEMCTL_VERBS.has(pos[0])) return { ok: false, error: `systemctl ${pos[0] ?? ""} changes state; request it with omp-approve` };
    const badOpt = args.find((a) => a.startsWith("-") && !SYSTEMCTL_OPTS.test(a));
    if (badOpt) return { ok: false, error: `option ${badOpt} not allowed` };
    if (pos.slice(1).some((u) => !ID.test(u))) return { ok: false, error: "bad unit name" };
    return { ok: true, file: "systemctl", args: [...args, "--no-pager"], cwd, timeoutMs: 30_000 };
  }
  if (name === "herdr") {
    if (args.length === 1 && ["--version", "-V", "--help", "status"].includes(args[0]!)) return { ok: true, file: "herdr", args, cwd, timeoutMs: 15_000 };
    const pos = args.filter((a) => !a.startsWith("-"));
    if (!HERDR_READ.has(`${pos[0]} ${pos[1]}`)) return { ok: false, error: "only Herdr read commands are available (never typing into panes)" };
    if (args.some((a) => !ID.test(a) && !/^--[a-z-]+(=[A-Za-z0-9:@._-]+)?$/.test(a))) return { ok: false, error: "bad herdr argument" };
    return { ok: true, file: "herdr", args, cwd, timeoutMs: 15_000 };
  }
  if (name === "op") {
    const pos = args.filter((a) => !a.startsWith("-"));
    const opts = args.filter((a) => a.startsWith("-"));
    const sub = `${pos[0] ?? ""} ${pos[1] ?? ""}`.trim();
    const okOpt = (allowed: RegExp) => opts.every((o) => allowed.test(o));
    if (args.length === 1 && ["--version", "-v", "whoami"].includes(args[0]!)) return { ok: true, file: "op", args, cwd, timeoutMs: 60_000 };
    if ((sub === "vault list" || sub === "item list") && okOpt(/^--(format(=json)?|vault(=.+)?|categories(=.+)?|tags(=.+)?)$/))
      return { ok: true, file: "op", args, cwd, timeoutMs: 60_000 };
    // Names and field labels only: human output never shows concealed values without --reveal.
    if (sub.startsWith("item get") && pos.length === 3 && okOpt(/^--vault(=.+)?$/)) return { ok: true, file: "op", args, cwd, timeoutMs: 60_000 };
    return { ok: false, error: "1Password values are never available in Discord runs; only `op item list` and `op item get <name>` (labels). Request a value with omp-approve." };
  }
  return { ok: false, error: `${name} is not brokered` };
}

function planGit(ctx: RunContext, args: string[], cwd0: string): Plan {
  let cwd = cwd0;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") {
      const p = hostPath(ctx, resolve(cwd, args[++i] ?? ""));
      if (!p) return { ok: false, error: "-C path is private to the sandbox" };
      cwd = p;
    } else if (a === "--no-pager" || a === "-P") continue;
    else if (a.startsWith("-")) return { ok: false, error: `git option ${a} not allowed for brokered commands` };
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || !GIT_BROKER.includes(sub)) return { ok: false, error: `git ${sub ?? ""} runs locally, not through the broker` };
  const badOpt = rest.find((a) => /^(--(receive-pack|upload-pack|exec|config|template|separate-git-dir|server-option|reference)|-c$|-c.)/.test(a));
  if (badOpt) return { ok: false, error: `git ${sub} option ${badOpt} not allowed` };
  if (rest.some((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) && !/^https:\/\//i.test(a))) return { ok: false, error: "only https remotes" };
  if (rest.some((a) => /^[\w.-]+@[\w.-]+:/.test(a) || /^ext::/.test(a))) return { ok: false, error: "only https remotes" };
  if (sub === "clone") {
    const pos = rest.filter((a) => !a.startsWith("-"));
    const url = pos[0];
    if (!url || !/^https:\/\//i.test(url)) return { ok: false, error: "clone needs an https URL" };
    const dest = resolve(cwd, pos[1] ?? basename(url.replace(/\/+$/, "")).replace(/\.git$/, ""));
    if (!isWritable(ctx, dest)) return { ok: false, error: `${dest} is read-only for Discord runs (clone into ~/discord-scratch or a repo you can write)` };
    return { ok: true, file: "git", args: ["clone", ...rest], cwd, env: GIT_ENV, timeoutMs: 15 * 60_000 };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0) return { ok: false, error: `${cwd} is not a git work tree` };
  const root = top.stdout.trim();
  if ((sub === "pull" || sub === "fetch") && !isWritable(ctx, root)) return { ok: false, error: `${root} is read-only for Discord runs` };
  if (sub === "push" && !isInside(root, join(ctx.home, "Github")) && !isInside(root, ctx.scratchDir)) return { ok: false, error: "push only from repos under ~/Github or ~/discord-scratch" };
  const bad = badGitConfig(cwd);
  if (bad.length) return { ok: false, error: `repo config keys not allowed outside the sandbox: ${bad.join(", ")}` };
  return { ok: true, file: "git", args: [sub, ...rest], cwd, env: GIT_ENV, timeoutMs: 15 * 60_000 };
}

export function runPlan(p: Extract<Plan, { ok: true }>): Promise<ExecResult> {
  const { promise, resolve: done } = Promise.withResolvers<ExecResult>();
  const child = spawn(p.file, p.args, { cwd: p.cwd, env: { ...process.env, ...p.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    if (stdout.length < MAX_OUT) stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    if (stderr.length < MAX_OUT) stderr += d.toString();
  });
  const t = setTimeout(() => child.kill("SIGKILL"), p.timeoutMs);
  child.on("error", (e) => done({ code: 127, stdout, stderr: `${stderr}${e.message}\n` }));
  child.on("close", (code) => {
    clearTimeout(t);
    done({ code: code ?? 1, stdout, stderr });
  });
  return promise;
}

export async function handleRequest(ctx: RunContext, req: Request): Promise<Record<string, unknown>> {
  if (req.type === "exec") {
    if (!Array.isArray(req.argv) || typeof req.cwd !== "string" || !isAbsolute(req.cwd)) return { code: 2, stdout: "", stderr: "bad request\n" };
    const plan = planExec(ctx, req.argv, req.cwd);
    if (!plan.ok) return { code: 126, stdout: "", stderr: `${req.argv[0]}: ${plan.error}\n` };
    return { ...(await runPlan(plan)) };
  }
  if (req.type === "approve") {
    if (typeof req.command !== "string" || typeof req.cwd !== "string") return { error: "bad request" };
    const cwd = hostPath(ctx, req.cwd);
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return { error: `cwd ${req.cwd} does not exist on the host (not /tmp: it is private to the run)` };
    try {
      const e = createEntry(ctx.queueDir, {
        command: req.command,
        cwd,
        reason: String(req.reason ?? "").slice(0, 500),
        channelId: ctx.channelId,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
      });
      ctx.onApprovalRequest(e);
      return { id: e.id, expiresAt: e.expiresAt };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  if (req.type === "receipt") {
    const e = readEntry(ctx.queueDir, "pending", req.id) ?? readEntry(ctx.queueDir, "claimed", req.id) ?? readEntry(ctx.queueDir, "closed", req.id);
    if (!e || e.sessionKey !== ctx.sessionKey) return { error: "unknown id" };
    return { receipt: readReceipt(ctx.queueDir, req.id), pending: Boolean(readEntry(ctx.queueDir, "pending", req.id)) };
  }
  return { error: "unknown request" };
}

/** Per-run broker socket (mode 600). */
export function startHostExec(socketPath: string, ctx: RunContext): Server {
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.length > 64 * 1024) return void c.destroy();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let req: Request;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        return void c.end(`${JSON.stringify({ error: "bad json" })}\n`);
      }
      handleRequest(ctx, req)
        .then((r) => c.end(`${JSON.stringify(r)}\n`))
        .catch((e) => c.end(`${JSON.stringify({ error: (e as Error).message })}\n`));
    });
    c.on("error", () => c.destroy());
  });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return server;
}
