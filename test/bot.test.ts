import { describe, expect, test } from "bun:test";
import { CHANNELS, GUILD_ID, OWNER_ID } from "../src/config.ts";
import { checkLocalRequest, resolveChannel } from "../src/http.ts";
import { ompArgs, sessionDir } from "../src/omp.ts";
import { prepareOutbound } from "../src/outbound.ts";
import { isAllowedAuthor, type MsgInfo, route, threadName } from "../src/policy.ts";
import { buildPrompt } from "../src/preamble.ts";
import { JobQueue } from "../src/queue.ts";
import { redact } from "../src/redact.ts";
import { splitMessage } from "../src/split.ts";

const HOME = process.env.HOME!;
// Fake ids from test/fixtures/config.json (loaded by test/env.ts).
const DEV = "300000004";
const PROJECT_A = "300000002";
const PROJECT_B = "300000003";
const GENERAL = "300000001";
const base: MsgInfo = {
  authorId: OWNER_ID,
  authorIsBot: false,
  guildId: GUILD_ID,
  channelId: DEV,
  isDM: false,
  isThread: false,
  parentId: null,
};

describe("allow-list", () => {
  test("only the owner, never bots", () => {
    expect(isAllowedAuthor(OWNER_ID, false)).toBe(true);
    expect(isAllowedAuthor(OWNER_ID, true)).toBe(false);
    expect(isAllowedAuthor("123456789", false)).toBe(false);
  });
  test("non-owner message in a mapped channel is ignored", () => {
    expect(route({ ...base, authorId: "999999999" })).toEqual({ kind: "ignore", reason: "not-owner" });
  });
  test("non-owner DM is ignored", () => {
    expect(route({ ...base, authorId: "999", guildId: null, isDM: true })).toEqual({ kind: "ignore", reason: "not-owner" });
  });
  test("bots are ignored even with the owner id", () => {
    expect(route({ ...base, authorIsBot: true }).kind).toBe("ignore");
  });
  test("owner in another guild is ignored", () => {
    expect(route({ ...base, guildId: "42" })).toEqual({ kind: "ignore", reason: "other-guild" });
  });
  test("owner DM is accepted", () => {
    expect(route({ ...base, guildId: null, isDM: true })).toEqual({ kind: "dm", cwd: `${HOME}/Github` });
  });
});

describe("channel mapping", () => {
  test("cwds", () => {
    expect(CHANNELS[PROJECT_A]!.cwd).toBe(`${HOME}/Github/project-a`);
    expect(CHANNELS[PROJECT_B]!.cwd).toBe(`${HOME}/Github/project-b`);
    expect(CHANNELS[DEV]!.cwd).toBe(`${HOME}/Github`);
    expect(CHANNELS[GENERAL]!.cwd).toBe(`${HOME}/Github`);
    for (const c of Object.values(CHANNELS)) expect(c.cwd).not.toBe(HOME);
  });
  test("top-level message → new thread", () => {
    expect(route({ ...base, channelId: PROJECT_A })).toEqual({ kind: "new-thread", cwd: `${HOME}/Github/project-a`, channelName: "projecta" });
  });
  test("message in thread → continue with parent's cwd", () => {
    expect(route({ ...base, channelId: "777", isThread: true, parentId: PROJECT_B })).toEqual({
      kind: "thread",
      cwd: `${HOME}/Github/project-b`,
      channelName: "projectb",
    });
  });
  test("unmapped channel and thread are ignored", () => {
    expect(route({ ...base, channelId: "123" }).kind).toBe("ignore");
    expect(route({ ...base, channelId: "777", isThread: true, parentId: "123" }).kind).toBe("ignore");
  });
  test("local endpoint resolves channel names and ids", () => {
    expect(resolveChannel("dev")).toBe(DEV);
    expect(resolveChannel("#projecta")).toBe(PROJECT_A);
    expect(resolveChannel(GENERAL)).toBe(GENERAL);
    expect(resolveChannel("random")).toBeNull();
  });
});

describe("thread names", () => {
  test("url host + words", () => {
    expect(threadName("https://www.example.com/a/b?c=1 check this out")).toBe("example.com – check this out");
    expect(threadName("https://news.ycombinator.com/item?id=1")).toBe("news.ycombinator.com");
  });
  test("first words, capped at 100", () => {
    expect(threadName("summarize the latest fed minutes for me please and more words here")).toBe(
      "summarize the latest fed minutes for me please",
    );
    expect(threadName("x".repeat(300)).length).toBeLessThanOrEqual(100);
    expect(threadName("   ")).toBe("omp task");
  });
});

describe("message splitting", () => {
  test("short text is one chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });
  test("chunks never exceed the limit", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(i % 50)}`).join("\n");
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("\n")).toBe(text);
  });
  test("a single huge line is hard-split", () => {
    const chunks = splitMessage("z".repeat(5000));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("").length).toBe(5000);
  });
  test("code blocks stay intact across chunks", () => {
    const code = Array.from({ length: 150 }, (_, i) => `const v${i} = ${i}; // ${"c".repeat(20)}`).join("\n");
    const text = `Intro\n\`\`\`ts\n${code}\n\`\`\`\nOutro`;
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000);
      expect((c.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
  });
  test("very long answers become preview + attachment", () => {
    const out = prepareOutbound("p ".repeat(6000));
    expect(out.messages.length).toBe(1);
    expect(out.messages[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(out.messages[0]!.file?.name).toBe("answer.md");
    expect(out.messages[0]!.file?.data.length).toBeGreaterThan(8000);
  });
});

describe("privacy redaction", () => {
  test("brokerage account numbers", () => {
    const r = redact("Account U1234567 and U12345678 and paper DU7654321.");
    expect(r.text).toBe("Account [REDACTED-ACCOUNT] and [REDACTED-ACCOUNT] and paper [REDACTED-ACCOUNT].");
    expect(r.hits["broker-account"]).toBe(3);
  });
  test("SSN-like numbers", () => {
    expect(redact("ssn 123-45-6789 ok").text).toBe("ssn [REDACTED-SSN] ok");
    expect(redact("SSN: 123456789").text).toBe("SSN: [REDACTED-SSN]");
  });
  test("driver's license and passport numbers", () => {
    expect(redact("Driver's license: D1234-5678-9012").text).toBe("Driver's license: [REDACTED-ID]");
    expect(redact("passport no. 512345678").text).toBe("passport no. [REDACTED-ID]");
    expect(redact("DL# S12345678").text).toBe("DL# [REDACTED-ID]");
  });
  test("secrets", () => {
    expect(redact("key sk-abcdefghijklmnopqrstuvwxyz123").text).toBe("key [REDACTED-SECRET]");
  });
  test("amounts and prices are untouched", () => {
    const s = "Bought 100 AAPL @ $187.25, P&L +$1,234.56, SPY 2026-10-16 580C x3, order #123456789012";
    expect(redact(s).text).toBe(s);
  });
  test("outbound applies redaction", () => {
    expect(prepareOutbound("acct U1234567").messages[0]!.content).toBe("acct [REDACTED-ACCOUNT]");
  });
});

describe("preamble", () => {
  const p = buildPrompt({
    source: { kind: "owner", authorId: OWNER_ID },
    content: "https://example.com/article summarize",
    threadUrl: "https://discord.com/channels/1/2",
    where: "#dev",
    followUp: false,
    attachments: [{ name: "shot.png", url: "https://cdn.discordapp.com/x.png" }],
  }, false);
  test("mentions source, untrusted data, capabilities and the approval broker", () => {
    expect(p).toContain("https://discord.com/channels/1/2");
    expect(p).toContain("#dev");
    expect(p).toMatch(/untrusted data/);
    expect(p).toMatch(/never instructions/);
    expect(p).toMatch(/NO capability for: trading orders/);
    expect(p).toMatch(/omp-approve --reason/);
    expect(p).toMatch(/'Approve <id>' tab in HEELER on rig/);
    expect(p).toMatch(/login password/);
    expect(p).toMatch(/exact command/);
  });
  test("owner content is delimited and attachments listed", () => {
    expect(p.startsWith("[Discord message from the owner]")).toBe(true);
    expect(p).toContain(`author id ${OWNER_ID}`);
    expect(p).toContain("--- owner message ---\nhttps://example.com/article summarize\n--- end owner message ---");
    expect(p).toContain("- shot.png: https://cdn.discordapp.com/x.png");
  });
  test("bridge messages are never labelled as the owner", () => {
    const b = buildPrompt({ source: { kind: "bridge", reason: "relay self-test" }, content: "ping", threadUrl: "u", where: "#x", followUp: false });
    expect(b).not.toContain("Discord message from the owner");
    expect(b).not.toContain("owner message ---");
    expect(b.startsWith("[Bridge message — NOT from the owner]")).toBe(true);
    expect(b).toContain("--- bridge message ---\nping\n--- end bridge message ---");
    expect(b).toMatch(/no owner authority/);
  });
  test("long content is truncated", () => {
    expect(
      buildPrompt({ source: { kind: "owner", authorId: OWNER_ID }, content: "a".repeat(100_000), threadUrl: "u", where: "DM", followUp: true }).length,
    ).toBeLessThan(70_000);
  });
});

describe("omp invocation", () => {
  test("new vs continued session; pane sessions resume their own file", () => {
    const a = ompArgs("123", "hi", false);
    expect(a.slice(0, 3)).toEqual(["-p", "--session-dir", sessionDir("123")]);
    expect(ompArgs("123", "hi", false, "/s/a.jsonl")).toEqual(expect.arrayContaining(["--resume", "/s/a.jsonl"]));
    expect(a).not.toContain("--continue");
    expect(a.at(-1)).toBe("hi");
    expect(ompArgs("123", "hi", true)).toContain("--continue");
  });
  test("session keys are sanitized", () => {
    expect(() => sessionDir("../etc")).toThrow();
    expect(sessionDir("dm-42").endsWith("/sessions/dm-42")).toBe(true);
  });
});

describe("queue", () => {
  // Drain pending microtasks so queued job continuations run (no wall-clock wait).
  const tick = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  test("max 2 concurrent, one per key, FIFO", async () => {
    const q = new JobQueue<number>(2);
    const gates: Record<string, () => void> = {};
    const order: string[] = [];
    const mk = (name: string, key: string) => {
      const { promise, resolve } = Promise.withResolvers<number>();
      gates[name] = () => resolve(1);
      return { key, label: name, run: () => (order.push(name), promise), onDone: () => {} };
    };
    q.enqueue(mk("a", "k1"));
    q.enqueue(mk("b", "k1"));
    q.enqueue(mk("c", "k2"));
    const d = q.enqueue(mk("d", "k3"));
    await tick();
    expect(order).toEqual(["a", "c"]);
    expect(d.position).toBe(2);
    expect(q.status().running.length).toBe(2);
    gates.a!();
    await tick();
    expect(order).toEqual(["a", "c", "b"]);
    gates.c!();
    await tick();
    expect(order).toEqual(["a", "c", "b", "d"]);
  });
  test("callbacks can use the id that enqueue returns, even when the job starts at once", async () => {
    const q = new JobQueue<number>(1);
    const seen: number[] = [];
    let failed: unknown;
    const { id } = q.enqueue({
      key: "k",
      label: "x",
      onStart: () => void seen.push(id),
      run: async () => (seen.push(id), 1),
      onDone: (_r, err) => {
        failed = err;
        seen.push(id);
      },
    });
    await tick();
    expect(failed).toBeUndefined();
    expect(seen).toEqual([id, id, id]);
  });
});

describe("local http guard", () => {
  test("loopback host only, no browser origin", () => {
    const mk = (h: Record<string, string>) => new Request("http://127.0.0.1:47821/post", { method: "POST", headers: h });
    expect(checkLocalRequest(mk({ host: "127.0.0.1:47821" }), 47821)).toBeNull();
    expect(checkLocalRequest(mk({ host: "evil.example:47821" }), 47821)).not.toBeNull();
    expect(checkLocalRequest(mk({ host: "127.0.0.1:47821", origin: "https://evil.example" }), 47821)).not.toBeNull();
  });
});
