// In-sandbox client for the bridge's host-exec broker (src/hostexec.ts). Invoked by the wrappers
// in gate/bin as `cli.ts <name> <args…>`:
// - git: push/fetch/pull/clone/ls-remote go to the broker; everything else runs the real git here.
// - gh, systemctl, herdr, op: always brokered (validated read/allowed commands only).
// - omp-approve [--wait] [--reason TEXT] [--] <command…>: queue a command for the owner's
//   password-gated approval (orders, money, sudo, secret values, deletions outside repos, …).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

const SOCKET = process.env.OMP_GATE_SOCKET ?? "/tmp/.omp-discord-sandbox/sock/hostexec.sock";
const GIT_BROKER = ["push", "fetch", "pull", "clone", "ls-remote"];
const WAIT_MAX_MS = 29 * 60_000;

function request(req: unknown): Promise<Record<string, unknown>> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
  const c = connect(SOCKET);
  let buf = "";
  c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
  c.on("data", (d) => (buf += d.toString()));
  c.on("end", () => {
    try {
      resolve(JSON.parse(buf));
    } catch {
      resolve({ error: "bad response from bridge" });
    }
  });
  c.on("error", (e) => resolve({ error: `bridge broker unavailable (${e.message})` }));
  return promise;
}

/** Run the real binary (this wrapper directory removed from PATH). */
function execReal(name: string, args: string[]): number {
  const self = realpathSync(join(dirname(realpathSync(process.argv[1]!)), "bin"));
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((d) => {
      try {
        return realpathSync(d) !== self;
      } catch {
        return true;
      }
    })
    .join(":");
  const r = spawnSync(name, args, { stdio: "inherit", env: { ...process.env, PATH: path } });
  return r.status ?? 1;
}

async function brokerExec(argv: string[]): Promise<number> {
  const r = await request({ type: "exec", argv, cwd: process.cwd() });
  if (typeof r.error === "string") {
    process.stderr.write(`${argv[0]}: ${r.error}\n`);
    return 1;
  }
  process.stdout.write(String(r.stdout ?? ""));
  process.stderr.write(String(r.stderr ?? ""));
  return Number(r.code ?? 1);
}

/** First git subcommand after global options. */
export function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

async function approve(args: string[]): Promise<number> {
  let wait = false;
  let reason = "";
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--wait") wait = true;
    else if (args[i] === "--reason") reason = args[++i] ?? "";
    else if (args[i] === "--") {
      i++;
      break;
    } else break;
  }
  const command = args.slice(i).join(" ").trim();
  if (!command) {
    console.error("usage: omp-approve [--wait] [--reason TEXT] [--] '<exact command>'");
    return 2;
  }
  const r = await request({ type: "approve", command, cwd: process.cwd(), reason });
  if (typeof r.error === "string") {
    console.error(`omp-approve: ${r.error}`);
    return 1;
  }
  const id = String(r.id);
  console.log(
    process.env.OMP_DISCORD_SANDBOX === "off"
      ? `Queued for the owner's approval as ${id}. The bridge posts the exact command in this Discord thread with an Approve button; it runs on the host only after the owner taps it. Nothing has run yet.`
      : `Queued for the owner's approval as ${id}. The bridge posts the exact command in this Discord thread and opens an "Approve ${id}" tab on the host; it runs only after the owner's login password. Nothing has run yet.`,
  );
  if (!wait) {
    console.log(`Check later with: omp-approve --status ${id}   (or wait: omp-approve --wait-id ${id})`);
    return 0;
  }
  return waitFor(id);
}

async function waitFor(id: string): Promise<number> {
  const until = Date.now() + WAIT_MAX_MS;
  while (Date.now() < until) {
    const r = await request({ type: "receipt", id });
    if (typeof r.error === "string") {
      console.error(`omp-approve: ${r.error}`);
      return 1;
    }
    const rc = r.receipt as { status: string; exitCode?: number | null; output?: string; detail: string } | null;
    if (rc) {
      console.log(`Approval ${id}: ${rc.status} — ${rc.detail}`);
      if (rc.output) console.log(rc.output);
      return rc.status === "ran" ? Number(rc.exitCode ?? 1) : 1;
    }
    await Bun.sleep(3000);
  }
  console.log(`Approval ${id} is still pending; the result will be posted in Discord and given to you with the next message.`);
  return 1;
}

async function main(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  if (!name) return 2;
  if (name === "omp-approve") {
    if (args[0] === "--status" && args[1]) {
      const r = await request({ type: "receipt", id: args[1] });
      console.log(JSON.stringify(r, null, 2));
      return r.error ? 1 : 0;
    }
    if (args[0] === "--wait-id" && args[1]) return waitFor(args[1]);
    return approve(args);
  }
  if (name === "git" && !GIT_BROKER.includes(gitSubcommand(args) ?? "")) return execReal("git", args);
  return brokerExec([name, ...args]);
}

if (import.meta.main) process.exit(await main());
