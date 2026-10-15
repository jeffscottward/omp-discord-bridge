// Live end-to-end checks with real `omp -p` runs through the production path (runOmp → capability
// sandbox → bridge sockets). Prompts are bridge-generated and labelled as such (never as the owner).
// Usage:
//   bun src/selftest.ts native   native reads: ~/Github, systemctl --user, herdr, op names
//   bun src/selftest.ts gate     an omp-approve request is queued; the RUNNING bridge service posts it
//                                and opens the approval tab; the test then cancels it through the queue
//                                cancel path and checks that nothing ran. No password is ever entered.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEV_CHANNEL_ID, QUEUE_DIR } from "./config.ts";
import { runOmp, sessionDir } from "./omp.ts";
import { buildPrompt } from "./preamble.ts";
import { cancelEntry, listPending, readEntry, readPosted, readReceipt } from "../gate/queue.ts";

type Call = { name: string; args: string; result: string; isError: boolean };
type Block = { type: string; id?: string; name?: string; arguments?: unknown; text?: string };
type SessionLine = { message?: { role?: string; content?: Block[] | string; toolCallId?: string; isError?: boolean } };

/** Tool calls and their results from the run's session file. */
function toolCalls(key: string): Call[] {
  const dir = sessionDir(key);
  const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  if (!file) return [];
  const calls = new Map<string, Call>();
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = (JSON.parse(line) as SessionLine).message;
    if (!m) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "toolCall" && b.id) calls.set(b.id, { name: String(b.name), args: JSON.stringify(b.arguments), result: "(no result)", isError: false });
    }
    if (m.role === "toolResult" && m.toolCallId && calls.has(m.toolCallId)) {
      const text = Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join(" ") : String(m.content);
      Object.assign(calls.get(m.toolCallId)!, { result: text.replace(/\s+/g, " ").slice(0, 400), isError: Boolean(m.isError) });
    }
  }
  return [...calls.values()];
}

async function run(name: string, content: string) {
  const key = `selftest-${name}-${Date.now()}`;
  const prompt = buildPrompt({
    source: { kind: "bridge", reason: `${name} self-test requested by the owner` },
    content,
    threadUrl: `https://discord.com/channels/@bridge/${DEV_CHANNEL_ID}`,
    where: "bridge self-test (#dev)",
    followUp: false,
  });
  const res = await runOmp(key, join(homedir(), "Github"), prompt, { channelId: DEV_CHANNEL_ID });
  console.log(`\n===== ${name} (exit ${res.code}, ${Math.round(res.durationMs / 1000)}s, session ${key}) =====`);
  for (const c of toolCalls(key)) console.log(`${c.isError ? "✗" : "✓"} ${c.name} ${c.args.slice(0, 220)}\n    → ${c.result}`);
  console.log("--- final answer ---");
  console.log(res.stdout || res.stderrTail);
  return res;
}

const NATIVE = `Capability check of the bridge's run environment (harmless reads only). Run each command once as its own bash call, exactly as written, then reply with a table: command → exit status → short result.
1. ls ~/Github | head -5
2. systemctl --user is-active omp-discord-bot
3. herdr agent list | jq '.result.agents | length'
4. timeout 30 op item list --format json | jq length`;

if (process.argv[2] === "native") {
  await run("native", NATIVE);
} else if (process.argv[2] === "gate") {
  const marker = join(homedir(), "omp-gate-e2e-marker");
  writeFileSync(marker, `created ${new Date().toISOString()} by the bridge gate self-test\n`);
  const before = new Set(listPending(QUEUE_DIR));
  await run(
    "gate",
    `Gate self-test: the file ~/omp-gate-e2e-marker is outside every git repo, so this run cannot delete it. Do not try rm yourself. Request it through the approval broker exactly once, without --wait:\nomp-approve --reason "bridge gate self-test (will be cancelled)" -- 'rm ~/omp-gate-e2e-marker'\nThen reply with the approval id it printed.`,
  );
  const id = listPending(QUEUE_DIR).find((i) => !before.has(i));
  if (!id) throw new Error("no new pending approval");
  const entry = readEntry(QUEUE_DIR, "pending", id)!;
  console.log(`\nqueued ${id}: ${entry.command} (cwd ${entry.cwd})`);
  // The running service posts it to Discord and opens the tab.
  let posted = readPosted(QUEUE_DIR, id);
  for (let i = 0; i < 60 && !posted?.tabId; i++) {
    await Bun.sleep(1000);
    posted = readPosted(QUEUE_DIR, id);
  }
  console.log(`posted by the service: ${Boolean(posted)}; tab ${posted?.tabId ?? "none"} pane ${posted?.paneId ?? "none"}`);
  const tab = posted?.tabId ? spawnSync("herdr", ["tab", "get", posted.tabId], { encoding: "utf8" }).stdout : "";
  console.log(`tab present: ${tab.includes(`Approve ${id}`)} (${tab.trim().slice(0, 160)})`);
  await Bun.sleep(3000);
  const cancelled = cancelEntry(QUEUE_DIR, id, "cancelled", "cancelled by the bridge gate self-test (queue cancel path)");
  console.log(`cancel: ${cancelled}`);
  await Bun.sleep(6000);
  const after = posted?.tabId ? spawnSync("herdr", ["tab", "get", posted.tabId], { encoding: "utf8" }).stdout : "";
  console.log(`tab closed: ${!after.includes("tab_info")}`);
  console.log(`receipt: ${JSON.stringify(readReceipt(QUEUE_DIR, id))}`);
  console.log(`claimed (ran): ${Boolean(readEntry(QUEUE_DIR, "claimed", id))}; marker still exists (nothing ran): ${existsSync(marker)}`);
  console.log(`result posted to Discord: ${Boolean(readPosted(QUEUE_DIR, id)?.resultPosted)}`);
} else {
  console.error("usage: bun src/selftest.ts native|gate");
}
process.exit(0);
