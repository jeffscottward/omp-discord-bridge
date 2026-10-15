// Integration test: real probes inside the Discord capability sandbox (bwrap + bridge sockets).
// Every bypass attempt must fail for lack of capability (no route, no key, no privilege, read-only
// file system); the allowed native paths must work. The network probes are plain TCP connects to
// documentation/private addresses that cannot be routed.
//
// Opt-in: it needs bwrap, ~/Github, internet access (example.com) and a real host setup, so it runs
// only with OMP_SANDBOX_INT=1 (and never in trusted mode, where runs are not sandboxed).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSandboxed } from "../src/omp.ts";
import { DEV_CHANNEL_ID, trusted } from "../src/config.ts";

const HAS_BWRAP = existsSync("/usr/bin/bwrap");
const HAS_HERDR = existsSync(join(homedir(), ".local/bin/herdr"));
const ENABLED = process.env.OMP_SANDBOX_INT === "1";
const HOME = homedir();
const REPO_DIR = resolve(import.meta.dir, "..");
const OUTSIDE = join(HOME, `.omp-gate-int-probe-${process.pid}`);

function runInSandbox(script: string): Promise<{ code: number; out: string }> {
  const child = spawnSandboxed("int-test", join(HOME, "Github"), ["/bin/sh", "-c", script], { channelId: DEV_CHANNEL_ID });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const { promise, resolve } = Promise.withResolvers<{ code: number; out: string }>();
  child.on("close", (code) => resolve({ code: code ?? 1, out }));
  return promise;
}

const PY_CONNECT = (host: string, port: number) =>
  `timeout 15 /usr/bin/python3 -c 'import socket; socket.create_connection(("${host}", ${port}), timeout=5)'`;

// Each probe prints "<name>=<rc>" (rc 0 = the action succeeded).
const MUST_FAIL: [string, string][] = [
  ["tcp_documentation_ip", PY_CONNECT("203.0.113.7", 22)],
  ["tcp_cgnat_tailnet", PY_CONNECT("100.64.0.1", 22)],
  ["tcp_lan", PY_CONNECT("192.168.0.1", 80)],
  ["tcp_single_label", PY_CONNECT("gateway", 4004)],
  ["ssh_documentation_ip", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 root@198.51.100.20 true"],
  ["ssh_via_proxy", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=3128' root@198.51.100.20 true"],
  ["ssh_key_visible", "ls ~/.ssh | grep -qv -e '^config$' -e '^known_hosts$'"],
  ["sudo_real", "/usr/bin/sudo -n true"],
  ["sudo_wrapper", "sudo -n true"],
  ["any_env_value", "cat ~/Github/*/.env ~/Github/*/*/.env 2>/dev/null | grep -q ="],
  ["op_read_wrapper", "op read op://Private/x/password"],
  ["op_read_real", "timeout 10 /usr/bin/op read op://Private/x/password"],
  ["op_config_visible", "test -e ~/.config/op/config"],
  ["gh_token_wrapper", "gh auth token"],
  ["bot_token_visible", "test -s ~/.config/omp-discord/bot.env"],
  ["bot_config_visible", "test -s ~/.config/omp-discord/config.json"],
  ["rm_outside_repo", `rm -f ${OUTSIDE}`],
  ["write_bashrc", "touch ~/.bashrc"],
  ["write_user_unit", "touch ~/.config/systemd/user/evil.service"],
  ["write_bridge_repo", `touch ${REPO_DIR}/x-probe`],
  ["write_github_root", "touch ~/Github/x-probe"],
  ["systemd_run", "timeout 10 systemd-run --user true"],
  ["systemctl_start_wrapper", "systemctl --user start omp-discord-bot.service"],
  ["systemctl_real", "timeout 10 /usr/bin/systemctl --user is-active omp-discord-bot"],
  ["dbus_session", "test -S /run/user/$(id -u)/bus"],
  ["herdr_type_wrapper", "herdr pane send-text w1:p1 'echo hi'"],
  ["host_loopback", "curl -s -f -m 5 -o /dev/null http://127.0.0.1:47821/health"],
  ["host_omp_daemon", "curl -s -m 5 -o /dev/null http://127.0.0.1:4000/"],
  ["cgnat_via_proxy", "curl -s -f -m 5 -o /dev/null http://100.64.0.1/"],
];
const MUST_PASS: [string, string][] = [
  ["public_https", "curl -s -f -m 20 -o /dev/null https://example.com"],
  ["read_github", "ls ~/Github >/dev/null"],
  ["scratch_writable", "touch ~/discord-scratch/probe && rm -f ~/discord-scratch/probe"],
  ["tmp_writable", "touch /tmp/probe && rm /tmp/probe"],
  ["systemctl_is_active", "systemctl --user is-active default.target"],
  ...(HAS_HERDR ? ([["herdr_agent_list", "herdr agent list | grep -q agents"]] as [string, string][]) : []),
];

// spawnSandboxed runs unsandboxed while the trusted-mode flag exists, so the probes would not test the sandbox.
describe.skipIf(!ENABLED || !HAS_BWRAP || trusted())("Discord capability sandbox (real bwrap run; set OMP_SANDBOX_INT=1)", () => {
  test(
    "bypass attempts fail for lack of capability; native reads work",
    async () => {
      writeFileSync(OUTSIDE, "probe");
      const all = [...MUST_FAIL, ...MUST_PASS];
      const script = all.map(([n, c]) => `(${c}) >/dev/null 2>&1; echo "${n}=$?"`).join("\n");
      const { out } = await runInSandbox(script);
      const rc = Object.fromEntries([...out.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
      if (process.env.SANDBOX_PROBE_REPORT) console.log(JSON.stringify(rc));
      for (const [n] of all) expect([n, rc[n] !== undefined]).toEqual([n, true]);
      expect(MUST_FAIL.map(([n]) => n).filter((n) => rc[n] === 0)).toEqual([]);
      expect(MUST_PASS.map(([n]) => n).filter((n) => rc[n] !== 0)).toEqual([]);
      expect(existsSync(OUTSIDE)).toBe(true); // rm outside repos did nothing
    },
    180_000,
  );
});

afterAll(() => rmSync(OUTSIDE, { force: true }));
