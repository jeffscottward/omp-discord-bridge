import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, receiptText, requestText } from "../src/approvals.ts";
import { finalReplies, Mirror, paneHasLiveOmp, parseHerdr, sideSessionKey, slug, transcriptExcerpt } from "../src/mirror.ts";
import { FIRSTMATE_SESSION, OWNER_ID } from "../src/config.ts";
import { decide, DENY_IPS, isBlockedAddress, isBlockedHost } from "../src/egress.ts";
import { handleRequest, planExec, type RunContext } from "../src/hostexec.ts";
import { messageProvenance } from "../src/policy.ts";
import { bwrapArgs, discover, HIDE_DIRS, runEnv, serviceRepos, type SandboxSpec } from "../src/sandbox.ts";
import { redactKnownSecrets, secretValues } from "../src/secrets.ts";
import { cancelEntry, createEntry, hashEntry, movePending, readEntry, readReceipt, type Entry } from "../gate/queue.ts";
import { gitSubcommand } from "../gate/cli.ts";

const BOT = "900000001";
const owner = { authorId: OWNER_ID, isBot: false, isWebhook: false, isSystem: false, botUserId: BOT };
describe("provenance", () => {
  test("only the owner's own non-bot, non-webhook, non-system message is owner", () => {
    expect(messageProvenance(owner)).toBe("owner");
    expect(messageProvenance({ ...owner, isBot: true })).toBe("other");
    expect(messageProvenance({ ...owner, isSystem: true })).toBe("other");
    expect(messageProvenance({ ...owner, authorId: "999" })).toBe("other");
  });
  test("bridge self-tests (bot user or webhook) are bridge, even with a spoofed owner id", () => {
    expect(messageProvenance({ ...owner, authorId: BOT, isBot: true })).toBe("bridge");
    expect(messageProvenance({ ...owner, isWebhook: true })).toBe("bridge");
    expect(messageProvenance({ ...owner, authorId: "123", isBot: true, isWebhook: true })).toBe("bridge");
  });
});

describe("Herdr ↔ Discord mirroring", () => {
  const agentsRaw = JSON.stringify({
    result: {
      agents: [
        { agent: "omp", pane_id: "wB:p3D", tab_id: "wB:t1N", workspace_id: "wB", cwd: "/home/u/Github", agent_session: { kind: "path", value: "/home/u/.omp/agent/sessions/-Github/a.jsonl" } },
        { agent: "omp", pane_id: "wC:pP", tab_id: "wC:t7", workspace_id: "wC", cwd: "/home/u/Github/fun", agent_session: { kind: "path", value: "/s/b.jsonl" } },
        { agent: "omp", pane_id: "wC:pQ", tab_id: "wC:t7", workspace_id: "wC", cwd: "/home/u/Github/fun", agent_session: null },
        { agent: "claude", pane_id: "wD:p1", tab_id: "wD:t1", workspace_id: "wD", cwd: "/x" },
      ],
    },
  });
  const tabsRaw = JSON.stringify({ result: { tabs: [{ tab_id: "wB:t1N", label: "FIRSTMATE" }, { tab_id: "wC:t7", label: "demo-app+docs" }] } });
  test("only OMP panes; channel named after the tab title; two panes in one tab get suffixes", () => {
    const live = parseHerdr("rig", agentsRaw, tabsRaw)!;
    expect(live.map((p) => p.name)).toEqual(["rig-firstmate", "rig-demo-app-docs-pp", "rig-demo-app-docs-pq"]);
    expect(live[0]!.sessionFile).toBe("/home/u/.omp/agent/sessions/-Github/a.jsonl");
    expect(live[2]!.sessionFile).toBeNull();
    expect(parseHerdr("rig", "ssh: connect failed", "")).toBeNull();
    expect(slug("DEMO")).toBe("demo");
    const ws = JSON.stringify({ result: { workspaces: [{ workspace_id: "wB", label: "Github" }, { workspace_id: "wC", label: "Games" }] } });
    expect(parseHerdr("rig", agentsRaw, tabsRaw, ws)!.map((p) => p.name)).toEqual(["rig-github-firstmate", "rig-games-demo-app-docs-pp", "rig-games-demo-app-docs-pq"]);
  });
  test("stable mapping: pane id, then tab id after a Herdr restart; gone panes are archived", () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-"));
    const file = join(dir, "agents.json");
    writeFileSync(
      file,
      JSON.stringify([
        { machine: "rig", paneId: "wB:p3D", tabId: "wB:t1N", workspace: "wB", tab: "FIRSTMATE", name: "rig-github-firstmate", channelId: "111", archived: false, webhookToken: "secret" },
        { machine: "rig", paneId: "wZ:old", tabId: "wC:t7", workspace: "wC", tab: "demo", name: "demo", channelId: "222", archived: false },
        { machine: "rig", paneId: "wY:gone", tabId: "wY:t1", workspace: "wY", tab: "gone", name: "gone", channelId: "333", archived: false },
        { machine: "mac", paneId: "w8:p19", tabId: "w8:tN", workspace: "w8", tab: "misc", name: "misc", channelId: "444", archived: false },
      ]),
    );
    const m = new Mirror(null, file);
    expect(JSON.stringify(m.entries)).not.toContain("secret");
    const { create, update, archive } = m.plan("rig", parseHerdr("rig", agentsRaw, tabsRaw)!);
    expect(update.map(({ e, p }) => [e.channelId, p.paneId])).toEqual([["111", "wB:p3D"], ["222", "wC:pP"]]);
    expect(create.map((p) => p.paneId)).toEqual(["wC:pQ"]);
    expect(archive.map((e) => e.channelId)).toEqual(["333"]); // the Mac entry is untouched
  });
  test("FIRSTMATE keeps its dedicated side session; others side-<channel>; threads their own", () => {
    const base = { machine: "rig" as const, paneId: "p", workspace: "w", name: "n", archived: false };
    expect(sideSessionKey({ ...base, tab: "FIRSTMATE", channelId: "111" }, null)).toBe(FIRSTMATE_SESSION.key);
    expect(sideSessionKey({ ...base, tab: "notes-v1", channelId: "222" }, null)).toBe("side-222");
    expect(sideSessionKey({ ...base, tab: "notes-v1", channelId: "222" }, "999")).toBe("999");
  });
  test("live omp detection: foreground omp, omp below the pane shell, or unknown → held", () => {
    const info = (fg: string[]) => JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_processes: [{ name: fg[0], argv: fg }] } } });
    expect(paneHasLiveOmp(info(["/opt/omp/dist/omp", "-c"]), "")).toBe(true);
    expect(paneHasLiveOmp(info(["bash"]), "100 1 bash bash\n200 100 node node x\n300 200 omp /x/omp -c\n")).toBe(true);
    expect(paneHasLiveOmp(info(["bash"]), "100 1 bash bash\n200 100 vim vim notes.md\n")).toBe(false);
    expect(paneHasLiveOmp("not json", "")).toBe(true);
  });
  test("tail posts only final assistant text and keeps a partial last line for later", () => {
    const lines = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "working" }] } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done ✅" }] } },
    ].map((l) => JSON.stringify(l));
    const full = Buffer.from(`${lines.join("\n")}\n{"type":"mess`);
    const r = finalReplies(full);
    expect(r.texts).toEqual(["Done ✅"]);
    expect(r.consumed).toBe(Buffer.byteLength(`${lines.join("\n")}\n`));
    expect(transcriptExcerpt(Buffer.from(lines.join("\n")))).toBe("USER: hi\n\nASSISTANT: Done ✅");
  });
});


// Not under /tmp: the broker treats /tmp as private to the sandbox.
mkdirSync(join(import.meta.dir, "..", ".test-tmp"), { recursive: true });
const tmp = mkdtempSync(join(import.meta.dir, "..", ".test-tmp", "gate-"));
const sh = (cmd: string, cwd: string) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });

/** A fake $HOME: one writable repo, one repo a user service runs, secrets, a unit file. */
function fakeHome(): string {
  const home = join(tmp, `home-${Math.random().toString(36).slice(2)}`);
  for (const d of ["Github/app/.git/hooks", "Github/svc/.git/hooks", "Github/notes", ".config/systemd/user", ".ssh", ".config/op", ".omp/agent/blobs", ".omp/agent/extensions", ".omp/natives"]) mkdirSync(join(home, d), { recursive: true });
  for (const f of [".omp/agent/config.yml", ".omp/agent/AGENTS.md", ".omp/agent/models.db"]) writeFileSync(join(home, f), "x\n");
  writeFileSync(join(home, "Github/app/.git/config"), "[core]\n");
  writeFileSync(join(home, "Github/svc/.git/config"), "[core]\n");
  writeFileSync(join(home, "Github/app/.env"), "API_TOKEN=supersecretvalue123\nAPP_REGION=eu\n");
  writeFileSync(join(home, "Github/app/.env.example"), "API_TOKEN=\n");
  writeFileSync(join(home, ".ssh/id_ed25519_vps"), "key");
  writeFileSync(join(home, ".ssh/config"), "Host vps\n");
  writeFileSync(join(home, ".config/systemd/user/svc.service"), "[Service]\nExecStart=%h/Github/svc/run.sh\n");
  return home;
}

function specFor(home: string): SandboxSpec {
  const discovery = discover(home);
  return {
    home,
    cwd: join(home, "Github"),
    sessionDir: join(tmp, "sess"),
    sockDir: join(tmp, "sock"),
    bunBin: process.execPath,
    repoDir: join(import.meta.dir, ".."),
    scratchDir: join(tmp, "scratch"),
    cacheDir: join(tmp, "cache"),
    discovery,
    protectedTrees: serviceRepos(discovery.trees, home),
  };
}

describe("capability sandbox", () => {
  const home = fakeHome();
  const spec = specFor(home);
  const a = bwrapArgs(spec);
  const pairs = (flag: string) => a.flatMap((x, i) => (x === flag ? [`${a[i + 1]} -> ${a[i + 2]}`] : []));
  test("own network namespace, no extra capabilities, empty /run and private /tmp", () => {
    expect(a).toContain("--unshare-all");
    expect(a).not.toContain("--share-net");
    expect(a).not.toContain("--cap-add");
    expect(a.join(" ")).toContain("--tmpfs /run");
    expect(a.join(" ")).toContain("--tmpfs /tmp");
  });
  test("git work trees are writable; a repo a user service runs is read-only; non-repo dirs stay read-only", () => {
    expect(spec.protectedTrees).toContain(join(home, "Github/svc"));
    expect(pairs("--bind")).toContain(`${join(home, "Github/app")} -> ${join(home, "Github/app")}`);
    expect(pairs("--bind")).not.toContain(`${join(home, "Github/svc")} -> ${join(home, "Github/svc")}`);
    expect(pairs("--ro-bind")).toContain(`${join(home, "Github/svc")} -> ${join(home, "Github/svc")}`);
    expect(a.join(" ")).not.toContain(join(home, "Github/notes"));
  });
  test(".git/hooks and .git/config stay read-only (no code planted for the user's own git)", () => {
    for (const p of ["Github/app/.git/hooks", "Github/app/.git/config"]) expect(pairs("--ro-bind")).toContain(`${join(home, p)} -> ${join(home, p)}`);
    const rw = a.indexOf(join(home, "Github/app"));
    expect(a.indexOf(join(home, "Github/app/.git/config"))).toBeGreaterThan(rw);
  });
  test("SSH keys, 1Password, bot state and secret files are hidden; ssh config/known_hosts only", () => {
    for (const d of [".ssh", ".config/op", ".1password", ".config/omp-discord", ".local/share/omp-discord-bot", ".local/share/keyrings", ".omp/run"]) expect(HIDE_DIRS).toContain(d);
    expect(a.join(" ")).toContain(`--tmpfs ${join(home, ".ssh")}`);
    expect(pairs("--ro-bind")).toContain(`${join(home, ".ssh/config")} -> ${join(home, ".ssh/config")}`);
    expect(a.join(" ")).not.toContain("id_ed25519_vps");
    expect(pairs("--ro-bind")).toContain(`/dev/null -> ${join(home, "Github/app/.env")}`);
    expect(a.join(" ")).not.toContain(".env.example");
  });
  test("OMP blob store is writable (image runs persist); config, AGENTS.md, extensions, natives stay read-only", () => {
    const rw = pairs("--bind");
    expect(rw).toContain(`${join(home, ".omp/agent/blobs")} -> ${join(home, ".omp/agent/blobs")}`);
    for (const p of [".omp", ".omp/agent", ".omp/agent/config.yml", ".omp/agent/AGENTS.md", ".omp/agent/extensions", ".omp/natives", ".omp/agent/models.db"]) {
      expect(rw.some((x) => x.startsWith(`${join(home, p)} ->`))).toBe(false);
    }
    // Bound after the read-only root so it is not shadowed.
    expect(a.lastIndexOf(join(home, ".omp/agent/blobs"))).toBeGreaterThan(a.indexOf("/"));
  });
  test("environment: native, plus proxy and wrappers; agent/bus sockets dropped", () => {
    const env = runEnv(
      { PATH: "/usr/bin", HOME: "/h", SSH_AUTH_SOCK: "/run/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", APP_REGION: "eu", OP_SESSION_x: "s", LANG: "C" },
      { home: "/h", repoDir: "/repo", gate: { OMP_GATE_SESSION: "k" } },
    );
    expect(env.PATH!.startsWith("/repo/gate/bin:")).toBe(true);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.APP_REGION).toBe("eu");
    expect(env.LANG).toBe("C");
    for (const k of ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "OP_SESSION_x"]) expect(env[k]).toBeUndefined();
    expect(env.OMP_GATE_SESSION).toBe("k");
  });
});

describe("host-exec broker validators", () => {
  const home = fakeHome();
  const scratch = join(tmp, "scratch-b");
  mkdirSync(scratch, { recursive: true });
  const repo = join(home, "Github/app");
  sh("git init -q . && git remote add origin https://github.com/x/y.git", repo);
  const svc = join(home, "Github/svc");
  sh("git init -q . && git config core.hooksPath /tmp/evil", svc);
  const queueDir = join(tmp, "q-broker");
  const seen: Entry[] = [];
  const ctx: RunContext = {
    runId: "r1", sessionKey: "s1", channelId: "c1", home, scratchDir: scratch,
    writableTrees: [repo], trees: [repo, svc], queueDir, onApprovalRequest: (e) => seen.push(e),
  };
  const ok = (argv: string[], cwd = repo) => planExec(ctx, argv, cwd).ok;
  test("git push/fetch over https from a repo; ssh/ext remotes, -c and upload/receive-pack refused", () => {
    expect(ok(["git", "push", "origin", "main"])).toBe(true);
    expect(ok(["git", "push", "--dry-run"])).toBe(true);
    expect(ok(["git", "push", "ssh://vps/x"])).toBe(false);
    expect(ok(["git", "push", "root@203.0.113.7:repo"])).toBe(false);
    expect(ok(["git", "-c", "core.sshCommand=sh", "push"])).toBe(false);
    expect(ok(["git", "push", "--receive-pack=sh -c id"])).toBe(false);
    expect(ok(["git", "status"])).toBe(false); // local git runs in the sandbox, not the broker
  });
  test("repo-local config that could run code outside the sandbox blocks brokered git", () => {
    const p = planExec({ ...ctx, writableTrees: [repo, svc] }, ["git", "push"], svc);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toContain("core.hookspath");
  });
  test("pull/clone only into writable places; /tmp is private to the sandbox", () => {
    expect(ok(["git", "pull"], svc)).toBe(false);
    expect(ok(["git", "clone", "https://github.com/x/y"], join(home, "Github"))).toBe(false);
    expect(ok(["git", "clone", "https://github.com/x/y"], join(home, "discord-scratch"))).toBe(true); // ~/discord-scratch → host scratch dir
    expect(planExec(ctx, ["git", "status"], "/tmp").ok).toBe(false);
  });
  test("systemctl --user read verbs only; herdr read only; op names only; gh without auth", () => {
    expect(ok(["systemctl", "--user", "is-active", "backup-monitor"])).toBe(true);
    expect(ok(["systemctl", "--user", "status", "backup.timer"])).toBe(true);
    expect(ok(["systemctl", "--user", "start", "backup.service"])).toBe(false);
    expect(ok(["systemctl", "status", "sshd"])).toBe(false);
    expect(ok(["herdr", "agent", "list"])).toBe(true);
    expect(ok(["herdr", "pane", "process-info", "--pane", "wB:p3D"])).toBe(true);
    expect(ok(["herdr", "pane", "send-text", "wB:p3D", "rm -rf ~"])).toBe(false);
    expect(ok(["herdr", "pane", "run", "wB:p3D", "x"])).toBe(false);
    expect(ok(["herdr", "pane", "read", "wB:p3D"])).toBe(false);
    expect(ok(["op", "item", "list", "--format", "json"])).toBe(true);
    expect(ok(["op", "item", "get", "GitHub"])).toBe(true);
    expect(ok(["op", "item", "get", "GitHub", "--reveal"])).toBe(false);
    expect(ok(["op", "item", "get", "GitHub", "--format", "json"])).toBe(false);
    expect(ok(["op", "read", "op://vault/item/password"])).toBe(false);
    expect(ok(["gh", "pr", "list"])).toBe(true);
    expect(ok(["gh", "auth", "token"])).toBe(false);
    expect(ok(["sudo", "true"])).toBe(false);
    expect(ok(["ssh", "vps"])).toBe(false);
  });
  test("approval requests queue for this run's channel; receipts only for the same session", async () => {
    const r = await handleRequest(ctx, { type: "approve", command: "sudo -n true", cwd: repo, reason: "test" });
    expect(typeof r.id).toBe("string");
    expect(seen.at(-1)).toMatchObject({ command: "sudo -n true", channelId: "c1", sessionKey: "s1", cwd: repo });
    expect((await handleRequest({ ...ctx, sessionKey: "other" }, { type: "receipt", id: String(r.id) })).error).toBe("unknown id");
    expect((await handleRequest(ctx, { type: "receipt", id: String(r.id) })).pending).toBe(true);
    expect((await handleRequest(ctx, { type: "approve", command: "rm -rf /x", cwd: "/tmp" })).error).toMatch(/private/);
  });
  test("in-sandbox git wrapper sends only network subcommands to the broker", () => {
    expect(gitSubcommand(["-C", "x", "push"])).toBe("push");
    expect(gitSubcommand(["--no-pager", "log"])).toBe("log");
    expect(gitSubcommand(["-c", "a=b", "fetch"])).toBe("fetch");
  });
});

describe("approval queue integrity", () => {
  const dir = join(tmp, "q1");
  const base = { cwd: tmp, reason: "", channelId: "c", sessionKey: "s", runId: "r" };
  test("hash covers the command; an edited entry is rejected by the approval tab before any password prompt", () => {
    const e = createEntry(dir, { ...base, command: "git push --dry-run" });
    const h = hashEntry(e);
    expect(hashEntry({ ...e, command: "git push --force" })).not.toBe(h);
    expect(hashEntry({ ...e, cwd: "/" })).not.toBe(h);
    expect(hashEntry({ ...e, expiresAt: e.expiresAt + 1 })).not.toBe(h);
    writeFileSync(join(dir, "pending", `${e.id}.json`), JSON.stringify({ ...e, command: "rm -rf ~" }));
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../gate/approve.ts"), dir, e.id, h], { encoding: "utf8", env: { ...process.env, OMP_APPROVE_NO_PAUSE: "1" } });
    expect(r.stdout).toContain("REJECTED");
    expect(readReceipt(dir, e.id)).toMatchObject({ status: "rejected" });
    expect(readEntry(dir, "pending", e.id)).toBeNull();
  });
  test("single use: claim is atomic; a cancel after the claim fails and vice versa", () => {
    const e = createEntry(dir, { ...base, command: "true" });
    expect(movePending(dir, e.id, "claimed")).toBe(true);
    expect(movePending(dir, e.id, "claimed")).toBe(false);
    expect(cancelEntry(dir, e.id, "cancelled", "x")).toBe(false);
    const f = createEntry(dir, { ...base, command: "true" });
    expect(cancelEntry(dir, f.id, "cancelled", "owner")).toBe(true);
    expect(movePending(dir, f.id, "claimed")).toBe(false);
    expect(readReceipt(dir, f.id)).toMatchObject({ status: "cancelled" });
  });
  test("expired entries are closed by the bridge and the approval tab refuses them", async () => {
    const e = createEntry(dir, { ...base, command: "true" }, Date.now() - 31 * 60_000);
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../gate/approve.ts"), dir, e.id, hashEntry(e)], { encoding: "utf8", env: { ...process.env, OMP_APPROVE_NO_PAUSE: "1" } });
    expect(r.stdout).toContain("Expired");
    expect(readReceipt(dir, e.id)).toMatchObject({ status: "expired" });
  });
});

describe("approval manager", () => {
  const dir = join(tmp, "q2");
  const calls: string[][] = [];
  const posts: string[] = [];
  const herdr = (args: string[]) => {
    calls.push(args);
    const out: Record<string, unknown> = {
      "workspace list": { result: { workspaces: [{ workspace_id: "wB", label: "Github" }] } },
      "tab create": { result: { tab: { tab_id: "wB:t9" }, root_pane: { pane_id: "wB:p9" } } },
      "pane process-info": { result: { process_info: { shell_pid: 5, foreground_process_group_id: 5, foreground_processes: [{ name: "bash", argv: ["/usr/bin/bash"] }] } } },
    };
    return { code: 0, out: JSON.stringify(out[`${args[0]} ${args[1]}`] ?? {}) };
  };
  const ch = { id: "c" } as never;
  const mgr = new Approvals({ queueDir: dir, herdr, log: () => {}, send: async (_c, t) => void posts.push(t), privateChannel: async (id) => (id === "c" ? ch : null) });
  const base = { cwd: tmp, reason: "why", sessionKey: "s", runId: "r" };
  test("posts the exact command and the HEELER instruction, then opens a no-focus, no-autostart tab", async () => {
    const e = createEntry(dir, { ...base, channelId: "c", command: "rm /tmp/omp-gate-e2e/marker" });
    await mgr.tick();
    expect(posts[0]).toContain("rm /tmp/omp-gate-e2e/marker");
    expect(posts[0]).toContain(`Open HEELER → terminal list → 'Approve ${e.id}' tab on rig, check the command, enter your login password.`);
    const create = calls.find((c) => c[0] === "tab" && c[1] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--env", "OMP_AUTO_START=0", "--no-focus", "--label", `Approve ${e.id}`]));
    const run = calls.find((c) => c[0] === "pane" && c[1] === "run")!;
    expect(run[3]).toContain(`gate/approve.ts' '${dir}' ${e.id} ${hashEntry(e)}`);
    expect(calls.some((c) => c.includes("read") || c.includes("send-text"))).toBe(false); // never captures or types into panes
    expect(mgr.deny(e.id, "the owner in Discord")).toBe("cancelled");
    expect(calls.at(-1)).toEqual(["tab", "close", "wB:t9"]);
    await mgr.tick();
    expect(posts.at(-1)).toContain(`Approval \`${e.id}\` cancelled`);
    expect(mgr.takeResults("s")[0]).toContain("cancelled");
  });
  test("requests from outside the owner's private channels are rejected, never posted", async () => {
    const e = createEntry(dir, { ...base, channelId: "public", command: "true" });
    const n = posts.length;
    await mgr.tick();
    expect(posts.length).toBe(n);
    expect(readReceipt(dir, e.id)).toMatchObject({ status: "rejected" });
  });
  test("texts", () => {
    expect(receiptText({ id: "abcdefgh", status: "ran", exitCode: 0, output: "ok", detail: "exit 0", at: 0 })).toContain("✅");
    expect(requestText({ v: 1, id: "abcdefgh", createdAt: 0, expiresAt: Date.now() + 60_000, command: "a ``` b", cwd: "/", reason: "", channelId: "c", sessionKey: "s", runId: "r" })).not.toContain("a ``` b");
  });
});

describe("known-secret redaction", () => {
  test("values of secret-looking keys are redacted wherever they appear", () => {
    const vals = secretValues('API_TOKEN=supersecretvalue123\nAPP_REGION=eu,us\nexport DB_PASSWORD="hunter2hunter2"\nset smtp_pass = "app-pass-1234"\nDEBUG=true');
    expect(vals).toEqual(["supersecretvalue123", "hunter2hunter2", "app-pass-1234"]);
    expect(redactKnownSecrets("x supersecretvalue123 y", vals)).toEqual({ text: "x [REDACTED-SECRET] y", hits: 1 });
  });
});

afterAll(() => {
  if (existsSync(tmp)) spawnSync("rm", ["-rf", tmp]);
});

describe("egress filter", () => {
  test("private, loopback, tailnet (CGNAT), link-local, documentation and configured addresses are blocked", () => {
    expect(DENY_IPS).toContain("203.0.113.7"); // egress.denyIps in test/fixtures/config.json
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.152", "172.16.0.1", "100.64.0.1", "169.254.169.254", "203.0.113.7", "198.51.100.20", "::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["93.184.215.14", "2606:4700::6810:84e5"]) expect(isBlockedAddress(ip)).toBe(false);
  });
  test("configured, tailnet and single-label hosts are blocked", () => {
    for (const h of ["api.blocked.example", "blocked.example", "vps", "gateway", "box.tail1234.ts.net", "localhost"]) {
      expect([h, isBlockedHost(h)]).toEqual([h, true]);
    }
    expect(isBlockedHost("api.anthropic.com")).toBe(false);
  });
  test("any port to public hosts; DNS answers are checked (no rebinding to LAN)", async () => {
    const pub = async () => ["93.184.215.14"];
    expect(await decide("example.com", 443, pub)).toEqual({ ok: true, address: "93.184.215.14" });
    expect((await decide("smtp.example.com", 587, pub)).ok).toBe(true);
    expect((await decide("example.com", 0, pub)).ok).toBe(false);
    expect((await decide("vps", 22, pub)).ok).toBe(false);
    expect((await decide("x.example", 4002, async () => ["203.0.113.7"])).ok).toBe(false);
    expect((await decide("evil.example", 443, async () => ["192.168.0.10"])).ok).toBe(false);
    expect((await decide("evil.example", 443, async () => ["93.184.215.14", "127.0.0.1"])).ok).toBe(false);
  });
});
