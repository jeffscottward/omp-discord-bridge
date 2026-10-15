// Capability sandbox for Discord-started OMP runs (user decision 2026-10-12).
// The run is "native" for ordinary work, but it has no capability for the serious actions; those
// go through the approval broker (src/approvals.ts) and the user's login password.
// - Network: own network namespace. Outbound TCP to any port on public hosts goes through the
//   egress proxy (src/egress.ts). Loopback, LAN, tailnet and configured deny-listed hosts are refused,
//   so there is no route to host services. Optional fixed tunnel: the configured SMTP host's port 587
//   for mail (127.0.0.1:2587; gate/bin/neomutt points there).
// - No SSH keys, no ssh/gpg agent, no 1Password (no op session or app socket), no keyring, no
//   browser profiles, no bot token; .env/key/credential files are masked. No D-Bus, no Herdr socket,
//   no host OMP daemons: every Unix socket under $HOME is masked and /run is empty.
// - no_new_privs (bwrap): sudo/setuid cannot elevate.
// - Writable: git work trees under ~/Github (except repos that user services execute and each
//   tree's .git/hooks and .git/config), a private /tmp, ~/discord-scratch, ~/.cache, the session dir.
//   Everything else is read-only, so deletions outside repos fail.
// - Host commands with fixed validators run in the bridge (src/hostexec.ts): git push/fetch/pull/
//   clone/ls-remote (GitHub credentials stay outside), gh, systemctl --user read verbs, herdr read
//   commands, op item names; omp-approve queues anything else for the password-gated broker.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const PROXY_PORT = 3128;
export const SMTP_PORT = 587;
/** In-sandbox port of the SMTP tunnel (587 is privileged; the neomutt wrapper rewrites smtp_url). */
export const SMTP_LOCAL_PORT = 2587;
export const SANDBOX_TMP = "/tmp/.omp-discord-sandbox";
/** In-sandbox paths of the bridge's per-run sockets. */
export const SANDBOX_SOCK = {
  dir: `${SANDBOX_TMP}/sock`,
  egress: `${SANDBOX_TMP}/sock/egress.sock`,
  smtp: `${SANDBOX_TMP}/sock/smtp.sock`,
  hostexec: `${SANDBOX_TMP}/sock/hostexec.sock`,
};
export const SCRATCH_NAME = "discord-scratch";

const HOME = homedir();
const REPO_DIR = resolve(import.meta.dir, "..");

/** Directories hidden (empty tmpfs) in every run: credentials, sessions, sockets, browser profiles. */
export const HIDE_DIRS = [
  ".ssh",
  ".gnupg",
  ".config/op",
  ".config/1Password",
  ".1password",
  ".config/omp-discord",
  ".config/herdr",
  ".config/teleport",
  ".local/share/keyrings",
  ".password-store",
  ".config/google-chrome",
  ".config/google-chrome-beta",
  ".config/google-chrome-unstable",
  ".config/google-chrome-for-testing",
  ".config/chromium",
  ".config/chromium-headless",
  ".config/BraveSoftware",
  ".config/vivaldi",
  ".config/microsoft-edge",
  ".config/microsoft-edge-dev",
  ".mozilla",
  ".docker",
  ".aws",
  ".kube",
  ".omp/run",
  ".omp/ssh-control",
  ".omp/browser-profiles",
  ".omp/browser-relay",
  ".omp/remote-host",
  ".omp/agent/sessions",
  ".omp/agent/terminal-sessions",
  ".omp/agent/custom-session-files",
  ".local/share/omp-discord-bot",
];
/** Re-exposed read-only inside the hidden ~/.ssh (no keys): host keys and the client config. */
export const SSH_KEEP = [".ssh/config", ".ssh/known_hosts"];
/** Single files never readable by a run (in addition to the secret-file scan). */
export const HIDE_FILES = [".netrc", ".git-credentials", ".npmrc", ".pypirc", ".config/gh/hosts.yml"];
/**
 * Writable inside the read-only ~/.omp: the auth database, so OAuth refresh leases and rotated
 * refresh tokens persist (OMP's lease system serializes refreshes; user decision).
 */
export const OMP_RW = [".omp/agent/agent.db", ".omp/agent/agent.db-wal", ".omp/agent/agent.db-shm"];
/**
 * Writable dirs inside the read-only ~/.omp: OMP's content-addressed blob store, where session
 * persistence writes externalized images and large tool outputs (temp file + rename). Without it
 * every image-bearing run fails with EROFS and its transcript is lost. It is shared with host
 * sessions so mirrored panes resolve each other's blobs. Config, AGENTS.md, extensions, natives,
 * models/skill caches and logs stay read-only (code or prompt-feeding state the host reuses).
 */
export const OMP_RW_DIRS = [".omp/agent/blobs"];

const SECRET_NAME = [
  /^\.env$/, /^\.env\..+/, /\.env$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /^id_(rsa|ed25519|ecdsa)/,
  /^credentials.*\.json$/, /^token.*\.json$/, /secret/i, /^\.netrc$/, /^\.npmrc$/, /^\.pypirc$/, /^bot\.env$/,
  /^credentials\.enc$/, /^service[-_]account.*\.json$/,
];
const SECRET_EXEMPT = /\.(example|sample|template|dist|pub|md|ts|js|mjs|py|rs|go)$/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.some((r) => r.test(name)) && !SECRET_EXEMPT.test(name);
}

const SKIP_DIRS: Record<string, true> = {
  node_modules: true, ".venv": true, venv: true, __pycache__: true, ".cache": true, target: true,
  dist: true, build: true, ".next": true, ".turbo": true, ".pnpm-store": true,
};

export interface Discovery {
  /** Git work trees (dir containing .git) under ~/Github. */
  trees: string[];
  secretFiles: string[];
  sockets: string[];
}

/**
 * discover() in a child process. The walk takes ~1.5 s of blocking file-system calls; on the main
 * thread that froze the voice audio (owner report 2026-10-14: hold music stalled for 1.4-1.8 s).
 */
export async function discoverAsync(home = HOME): Promise<Discovery> {
  const code = `import { discover } from ${JSON.stringify(import.meta.path)}; process.stdout.write(JSON.stringify(discover(${JSON.stringify(home)})));`;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("discover child failed");
  const d: unknown = JSON.parse(out);
  if (!d || typeof d !== "object" || !("trees" in d) || !("secretFiles" in d) || !("sockets" in d)) throw new Error("discover child: bad output");
  return d as Discovery;
}

/** One walk of ~/Github (trees, secret files, sockets) plus ~/.config and the rest of $HOME (secrets, sockets). */
export function discover(home = HOME): Discovery {
  const out: Discovery = { trees: [], secretFiles: [], sockets: [] };
  const hidden = new Set(HIDE_DIRS.map((d) => join(home, d)));
  const walk = (dir: string, depth: number, max: number, findTrees: boolean, findSecrets: boolean) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (findTrees && ents.some((e) => e.name === ".git")) out.trees.push(dir);
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isSocket()) out.sockets.push(p);
      else if (e.isFile() && findSecrets && isSecretName(e.name)) out.secretFiles.push(p);
      else if (e.isDirectory() && depth < max && !SKIP_DIRS[e.name] && e.name !== ".git" && !hidden.has(p)) {
        walk(p, depth + 1, max, findTrees, findSecrets);
      }
    }
  };
  walk(join(home, "Github"), 0, 7, true, true);
  walk(join(home, ".config"), 0, 4, false, true);
  walk(join(home, ".mutt"), 0, 2, false, false);
  // Top-level home and other dot-dirs: sockets only (depth-limited), plus ~/.local/share.
  for (const d of [".local/share", ".local/state", ".omp", ".bun", ".steam", ".var"]) walk(join(home, d), 0, 4, false, false);
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) if (e.isSocket()) out.sockets.push(join(home, e.name));
  } catch {}
  return out;
}

/** Repos under ~/Github that user services/timers execute: read-only, since a service runs outside the sandbox. */
export function serviceRepos(trees: string[], home = HOME): string[] {
  const unitDir = join(home, ".config", "systemd", "user");
  const paths = new Set<string>([REPO_DIR]);
  let files: string[] = [];
  try {
    files = readdirSync(unitDir).filter((f) => /\.(service|timer|path|socket)$/.test(f));
  } catch {}
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(unitDir, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?:%h|~|\/home\/[^/\s]+)\/Github\/[^\s"';:]+/g)) {
      paths.add(/^(%h|~)/.test(m[0]) ? m[0].replace(/^(%h|~)/, home) : m[0].replace(/^\/home\/[^/]+/, home));
    }
  }
  const out = new Set<string>();
  const sorted = [...trees].sort((a, b) => b.length - a.length);
  for (const p of paths) {
    const tree = sorted.find((t) => p === t || p.startsWith(t + sep));
    if (tree) out.add(tree);
  }
  return [...out];
}

export interface SandboxSpec {
  home: string;
  cwd: string;
  /** Writable OMP session dir for this channel/thread. */
  sessionDir: string;
  /** Host dir holding this run's bridge sockets (egress, smtp, hostexec). */
  sockDir: string;
  /** Absolute bun binary used for the in-sandbox forwarders and wrappers. */
  bunBin: string;
  /** Repo dir (gate/, sandbox/). */
  repoDir: string;
  /** Persistent writable scratch dir (mounted at ~/discord-scratch). */
  scratchDir: string;
  /** Persistent writable cache dir (mounted at ~/.cache). */
  cacheDir: string;
  discovery: Discovery;
  /** Git trees mounted read-only (service-executed repos, the bridge itself). */
  protectedTrees: string[];
  /** A mirrored pane's session file (+ artifacts dir), bound writable at its own path. */
  paneSession?: { file: string; artifacts: string };
  /** /etc/hosts for the run (default sandbox/hosts; with an SMTP tunnel it also maps the SMTP host). */
  hostsFile?: string;
  /** Forward 127.0.0.1:SMTP_LOCAL_PORT to the SMTP tunnel socket. */
  smtpTunnel?: boolean;
}

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** bwrap arguments up to (and including) "--". Pure apart from existence checks; exported for tests. */
export function bwrapArgs(s: SandboxSpec): string[] {
  const h = (p: string) => join(s.home, p);
  const a: string[] = [
    "--unshare-all", // user, ipc, pid, net, uts, cgroup: own network namespace (egress proxy only)
    "--die-with-parent",
    "--new-session",
    "--hostname", "discord-run",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run", // D-Bus, ssh/gpg agents, 1Password, docker, Wayland, keyring sockets
    "--tmpfs", "/tmp", // private; host /tmp has SSH control sockets
    "--ro-bind", s.hostsFile ?? join(s.repoDir, "sandbox", "hosts"), "/etc/hosts",
  ];
  for (const p of ["/mnt", "/media", "/srv"]) if (exists(p)) a.push("--tmpfs", p);
  // Writable git work trees (shallow first, so nested repos can be re-bound), then read-only overrides.
  const prot = new Set(s.protectedTrees);
  const trees = [...s.discovery.trees].sort((x, y) => x.length - y.length);
  for (const t of trees) if (!prot.has(t)) a.push("--bind", t, t);
  for (const t of trees) {
    if (prot.has(t)) {
      a.push("--ro-bind", t, t);
      continue;
    }
    if (isDir(join(t, ".git"))) {
      for (const p of [".git/hooks", ".git/config"]) if (exists(join(t, p))) a.push("--ro-bind", join(t, p), join(t, p));
    }
  }
  for (const d of HIDE_DIRS) if (isDir(h(d))) a.push("--tmpfs", h(d));
  for (const f of SSH_KEEP) if (exists(h(f))) a.push("--ro-bind", h(f), h(f));
  for (const f of HIDE_FILES) if (exists(h(f))) a.push("--ro-bind", "/dev/null", h(f));
  for (const f of s.discovery.secretFiles) a.push("--ro-bind", "/dev/null", f);
  for (const f of s.discovery.sockets) a.push("--ro-bind", "/dev/null", f);
  for (const p of OMP_RW) if (exists(h(p))) a.push("--bind", h(p), h(p));
  for (const d of OMP_RW_DIRS) if (isDir(h(d))) a.push("--bind", h(d), h(d));
  if (s.paneSession) {
    a.push("--bind", s.paneSession.file, s.paneSession.file);
    if (exists(s.paneSession.artifacts)) a.push("--bind", s.paneSession.artifacts, s.paneSession.artifacts);
  }
  a.push(
    "--bind", s.scratchDir, h(SCRATCH_NAME),
    "--bind", s.cacheDir, h(".cache"),
    "--bind", s.sessionDir, s.sessionDir,
    "--ro-bind", s.sockDir, SANDBOX_SOCK.dir,
    "--ro-bind", s.bunBin, `${SANDBOX_TMP}/bun`,
    "--ro-bind", join(s.repoDir, "sandbox", "netfwd.mjs"), `${SANDBOX_TMP}/netfwd.mjs`,
    "--chdir", s.cwd,
    "--",
  );
  return a;
}

/**
 * Full command for one sandboxed program: bwrap … -- sh -c '<forwarders> & exec "$@"' discord-run <cmd…>.
 * With --unshare-pid the whole sandbox dies when the command exits.
 */
export function sandboxCommand(s: SandboxSpec, cmd: string[]): { file: string; args: string[] } {
  const fwd = [`${PROXY_PORT}=${SANDBOX_SOCK.egress}`, ...(s.smtpTunnel ? [`${SMTP_LOCAL_PORT}=${SANDBOX_SOCK.smtp}`] : [])].join(" ");
  const launcher = [
    `"${SANDBOX_TMP}/bun" "${SANDBOX_TMP}/netfwd.mjs" ${fwd} &`,
    // Wait (max 5 s) until the forwarders listen, so the first request is not refused.
    "i=0; while [ ! -e /tmp/.omp-netfwd-ready ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done;",
    'exec "$@"',
  ].join(" ");
  return { file: "bwrap", args: [...bwrapArgs(s), "/bin/sh", "-c", launcher, "discord-run", ...cmd] };
}

/** Env vars dropped from the bridge's own environment (agent/bus sockets that do not exist inside). */
export const ENV_DROP = [/^SSH_AUTH_SOCK$/, /^SSH_AGENT_PID$/, /^GPG_AGENT_INFO$/, /^DBUS_SESSION_BUS_ADDRESS$/, /^HERDR_/, /^OP_/, /^DISCORD/];

/** Environment for a run: the bridge's own (native) environment plus proxy, wrappers and gate settings. */
export function runEnv(
  base: Record<string, string | undefined>,
  o: { home: string; repoDir: string; gate: Record<string, string> },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !ENV_DROP.some((r) => r.test(k))) env[k] = v;
  const proxy = `http://127.0.0.1:${PROXY_PORT}`;
  Object.assign(env, {
    HOME: o.home,
    PATH: [join(o.repoDir, "gate", "bin"), base.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
    TMPDIR: "/tmp",
    TERM: "dumb",
    OMP_DISCORD_BRIDGE: "1",
    OMP_DISCORD_SANDBOX: "capability",
    OMP_GATE_BUN: `${SANDBOX_TMP}/bun`,
    OMP_GATE_HOME: join(o.repoDir, "gate"),
    OMP_GATE_SOCKET: SANDBOX_SOCK.hostexec,
    PI_PROXY: proxy, // OMP's process-wide HTTP client (provider calls, OAuth refresh)
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1",
    BUN_INSTALL_CACHE_DIR: join(o.home, ".cache", "bun"),
    npm_config_cache: join(o.home, ".cache", "npm"),
    GIT_TERMINAL_PROMPT: "0",
    ...o.gate,
  });
  return env;
}
