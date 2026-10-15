import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { blockFromContent, splitPasteBlocks } from "../src/blocks.ts";
import { GUILD_ID, OWNER_ID } from "../src/config.ts";
import { agentState, buttonAllowed, editorEmpty, FirstmateSender, isFirstmateTab, SENT_LABEL, sessionIdle } from "../src/firstmate.ts";
import { HEELER_REDIRECT, heelerButton, heelerUrl } from "../src/heeler.ts";
import { prepareOutbound } from "../src/outbound.ts";
import worker, { heelerTarget } from "../heeler-link/worker.js";

const FX = join(import.meta.dir, "fixtures", "editor");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");

describe("paste blocks", () => {
  test("two ```text blocks become separate segments; prose stays around them", () => {
    const s = splitPasteBlocks("Intro line\n```text\nfirst block\nline 2\n```\nmiddle\n```text\nsecond\n```\nOutro");
    expect(s.map((x) => x.kind)).toEqual(["prose", "block", "prose", "block", "prose"]);
    expect(s[1]).toMatchObject({ kind: "block", body: "first block\nline 2", fenced: "```text\nfirst block\nline 2\n```" });
    expect(s[3]).toMatchObject({ kind: "block", body: "second" });
  });
  test("code blocks for other languages stay inline; labelled blocks count", () => {
    const s = splitPasteBlocks("Here:\n```ts\nconst x = 1;\n```\nPaste into FIRSTMATE:\n```\ndo the thing\n```\n```firstmate\nalso\n```");
    expect(s.map((x) => x.kind)).toEqual(["prose", "block", "block"]);
    expect(s[0]!.kind === "prose" && s[0]!.text).toContain("```ts\nconst x = 1;\n```");
    expect(s[0]!.kind === "prose" && s[0]!.text.endsWith("Paste into FIRSTMATE:")).toBe(true);
  });
  test("unclosed fences and bare ``` blocks stay prose", () => {
    expect(splitPasteBlocks("a\n```\nx\n```\nb").map((x) => x.kind)).toEqual(["prose"]);
    expect(splitPasteBlocks("a\n```text\nnever closed").map((x) => x.kind)).toEqual(["prose"]);
  });
  test("longer fences and ~~~ work; inner ``` lines stay in the body", () => {
    const s = splitPasteBlocks("````text\n```\ninner\n```\n````");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ body: "```\ninner\n```" });
    expect(splitPasteBlocks("~~~txt\nt\n~~~")[0]).toMatchObject({ body: "t" });
  });
  test("blockFromContent reads back exactly the posted block", () => {
    expect(blockFromContent("```text\na\n\nb\n```")).toBe("a\n\nb");
    expect(blockFromContent("prose\n```text\na\n```")).toBeNull();
    expect(blockFromContent("```text\na")).toBeNull();
  });
});

describe("outbound with paste blocks", () => {
  test("each paste block is its own message containing only the fenced block", () => {
    const out = prepareOutbound("Two blocks:\n```text\none\n```\nand\n```text\ntwo\n```");
    expect(out.messages.map((m) => [m.content, m.paste ?? false])).toEqual([
      ["Two blocks:", false],
      ["```text\none\n```", true],
      ["and", false],
      ["```text\ntwo\n```", true],
    ]);
  });
  test("the privacy filter applies inside blocks", () => {
    const out = prepareOutbound("```text\nacct U1234567\n```");
    expect(out.messages[0]!.content).toBe("```text\nacct [REDACTED-ACCOUNT]\n```");
  });
  test("a block too long for one message is attached as .txt", () => {
    const body = "x".repeat(2500);
    const out = prepareOutbound(`Intro\n\`\`\`text\n${body}\n\`\`\``);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]!.paste).toBe(true);
    expect(out.messages[1]!.file).toEqual({ name: "paste-1.txt", data: body });
    expect(out.messages[1]!.content.length).toBeLessThan(200);
    for (const m of out.messages) expect(m.content.length).toBeLessThanOrEqual(2000);
  });
  test("long prose keeps the 2000-char split; very long prose still attaches answer.md", () => {
    const long = Array.from({ length: 120 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n");
    const out = prepareOutbound(`${long}\n\`\`\`text\nblock\n\`\`\``);
    expect(out.messages.length).toBeGreaterThan(2);
    for (const m of out.messages) expect(m.content.length).toBeLessThanOrEqual(2000);
    expect(out.messages.at(-1)).toMatchObject({ content: "```text\nblock\n```", paste: true });
    const huge = prepareOutbound(`${"p ".repeat(6000)}\n\`\`\`text\nblock\n\`\`\``);
    expect(huge.messages[0]!.file?.name).toBe("answer.md");
    expect(huge.messages.at(-1)).toMatchObject({ content: "```text\nblock\n```", paste: true });
  });
  test("no paste blocks: unchanged behaviour", () => {
    expect(prepareOutbound("hi\n```ts\nx\n```").messages).toEqual([{ content: "hi\n```ts\nx\n```" }]);
  });
});

describe("Send to FIRSTMATE button: owner only", () => {
  const base = { userId: OWNER_ID, ownerId: OWNER_ID, guildId: GUILD_ID, ownGuildId: GUILD_ID, isDM: false, messageAuthorId: "bot", botId: "bot" };
  test("owner on a bridge message in the server or DM", () => {
    expect(buttonAllowed(base)).toBe(true);
    expect(buttonAllowed({ ...base, isDM: true, guildId: null })).toBe(true);
  });
  test("anyone else, another guild, or a non-bridge message is refused", () => {
    expect(buttonAllowed({ ...base, userId: "123" })).toBe(false);
    expect(buttonAllowed({ ...base, guildId: "999" })).toBe(false);
    expect(buttonAllowed({ ...base, messageAuthorId: "someone" })).toBe(false);
    expect(buttonAllowed({ ...base, botId: undefined })).toBe(false);
  });
});

const SESSION = join(homedir(), ".omp", "agent", "sessions", "-Github", "s.jsonl");
const agentJson = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ result: { agent: { pane_id: "wB:p3D", agent: "omp", agent_status: "idle", tab_id: "wB:t1N", agent_session: { kind: "path", value: SESSION }, ...o } } });
const tabJson = (label: string) => JSON.stringify({ result: { tab: { label } } });
const line = (o: object) => `${JSON.stringify(o)}\n`;
const stop = line({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
const toolUse = line({ type: "message", message: { role: "assistant", stopReason: "toolUse" } });
const user = line({ type: "message", message: { role: "user", content: "hi" } });
const advisor = line({ type: "custom_message", customType: "advisor", content: "note" });

describe("idle check", () => {
  test("herdr status: idle/done omp agent on exactly that pane", () => {
    expect(agentState(agentJson(), "wB:p3D")).toEqual({ ok: true, sessionFile: SESSION, tabId: "wB:t1N" });
    expect(agentState(agentJson({ agent_status: "done" }), "wB:p3D").ok).toBe(true);
    expect(agentState(agentJson({ agent_status: "working" }), "wB:p3D")).toEqual({ ok: false, reason: "agent working" });
    expect(agentState(agentJson({ agent_status: "blocked" }), "wB:p3D").ok).toBe(false);
    expect(agentState(agentJson({ pane_id: "wB:p37" }), "wB:p3D").ok).toBe(false);
    expect(agentState(agentJson({ agent: "claude" }), "wB:p3D").ok).toBe(false);
    expect(agentState(agentJson({ agent_session: { kind: "path", value: "/tmp/x.jsonl" } }), "wB:p3D").ok).toBe(false);
    expect(agentState("not json", "wB:p3D").ok).toBe(false);
    expect(isFirstmateTab(tabJson("FIRSTMATE"))).toBe(true);
    expect(isFirstmateTab(tabJson("dev"))).toBe(false);
  });
  test("session JSONL: last turn entry must be a completed assistant turn", () => {
    expect(sessionIdle(user + stop)).toEqual({ ok: true });
    expect(sessionIdle(user + stop + advisor + line({ type: "model_usage" }))).toEqual({ ok: true });
    expect(sessionIdle(user + toolUse).ok).toBe(false);
    expect(sessionIdle(stop + user).ok).toBe(false);
    expect(sessionIdle(stop + line({ type: "custom", customType: "tool_execution_start" })).ok).toBe(false);
    expect(sessionIdle(stop + line({ type: "custom_message", customType: "async-result" })).ok).toBe(false);
    expect(sessionIdle(line({ type: "message", message: { role: "assistant", stopReason: "aborted" } })).ok).toBe(false);
    expect(sessionIdle(stop.trimEnd()).ok).toBe(false); // partial last line: still being written
    expect(sessionIdle("").ok).toBe(false);
  });
});

describe("empty input check (real OMP screen captures)", () => {
  const bar = "\ue0b6 \uf0d57 \ue0b1 Opus 5.5 \ue0b1 /tmp \ue0b0──────";
  test("empty editor", () => {
    expect(editorEmpty(fx("empty.txt"))).toEqual({ ok: true });
    expect(editorEmpty(`${bar}\n╰─${" ".repeat(90)}← ← to see 1 running agent\n`)).toEqual({ ok: true });
  });
  test("typed draft, multi-line draft, anything below, unknown layout → refused", () => {
    expect(editorEmpty(fx("typed.txt"))).toEqual({ ok: false, reason: "input box not empty" });
    expect(editorEmpty(fx("multiline.txt"))).toEqual({ ok: false, reason: "input box not empty" });
    expect(editorEmpty(`${bar}\n╰─\n   second line`).ok).toBe(false);
    expect(editorEmpty(`${bar}\n╰─\n> /model picker`).ok).toBe(false);
    expect(editorEmpty(`${bar}\n╰─${" ".repeat(90)}something else`).ok).toBe(false);
    expect(editorEmpty("╰─\n").ok).toBe(false);
    expect(editorEmpty("plain shell $ ").ok).toBe(false);
  });
});

describe("FirstmateSender", () => {
  const empty = fx("empty.txt");
  const setup = (screens: string[], status: string[] = ["idle"]) => {
    const calls: string[][] = [];
    let reads = 0;
    let gets = 0;
    const herdr = (args: string[]) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get") return { code: 0, out: agentJson({ agent_status: status[Math.min(gets++, status.length - 1)] }) };
      if (args[0] === "tab") return { code: 0, out: tabJson("FIRSTMATE") };
      if (args[0] === "agent" && args[1] === "read") return { code: 0, out: screens[Math.min(reads++, screens.length - 1)]! };
      if (args[0] === "agent" && args[1] === "prompt") return { code: 0, out: "{}" };
      return { code: 1, out: "" };
    };
    const logs: string[] = [];
    const logFile = join(mkdtempSync(join(tmpdir(), "fm-")), "log.jsonl");
    const s = new FirstmateSender({ herdr, readTail: () => user + stop, log: (m) => logs.push(String(m)), logFile, pane: "wB:p3D" });
    return { s, calls, logs, logFile };
  };
  test("idle + empty: delivers once to the FIRSTMATE pane with the label; logs id/time, not content", () => {
    const { s, calls, logs, logFile } = setup([empty]);
    const r = s.deliver("secret-ish block body", "m1");
    expect(r.ok).toBe(true);
    const prompts = calls.filter((c) => c[1] === "prompt");
    expect(prompts).toEqual([["agent", "prompt", "wB:p3D", `${SENT_LABEL}\n\nsecret-ish block body`]]);
    expect(calls.some((c) => c[0] === "pane" || c.includes("send-text") || c.includes("send-keys"))).toBe(false);
    expect(calls.filter((c) => c[1] === "read")[0]).toEqual(["agent", "read", "wB:p3D", "--source", "visible", "--lines", "6"]);
    const rec = JSON.parse(readFileSync(logFile, "utf8").trim());
    expect(rec).toMatchObject({ messageId: "m1", status: "delivered", chars: 21 });
    expect(typeof rec.id).toBe("string");
    expect(typeof rec.at).toBe("string");
    expect(readFileSync(logFile, "utf8")).not.toContain("block body");
    expect(logs.join("\n")).not.toContain("block body");
    expect(s.deliver("again", "m1").ok).toBe(false); // double tap within 30 s
  });
  test("busy or typing: nothing is sent", () => {
    for (const [screens, status] of [[[fx("typed.txt")], ["idle"]], [[empty], ["working"]], [[empty], ["blocked"]]] as const) {
      const { s, calls } = setup([...screens], [...status]);
      expect(s.deliver("x", "m").ok).toBe(false);
      expect(calls.some((c) => c[1] === "prompt")).toBe(false);
    }
  });
  test("re-check right before sending: typing started after the press → refused", () => {
    const { s, calls } = setup([empty, fx("typed.txt")]);
    expect(s.check()).toEqual({ ok: true }); // at the press
    const r = s.deliver("x", "m2"); // final check sees a draft
    expect(r).toEqual({ ok: false, reason: "input box not empty" });
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
  });
  test("only the FIRSTMATE tab; empty/huge blocks refused", () => {
    const calls: string[][] = [];
    const s = new FirstmateSender({
      herdr: (a) => (calls.push(a), a[0] === "tab" ? { code: 0, out: tabJson("other") } : { code: 0, out: agentJson() }),
      readTail: () => stop,
      logFile: join(mkdtempSync(join(tmpdir(), "fm-")), "l"),
    });
    expect(s.deliver("x", "m").ok).toBe(false);
    expect(s.deliver("", "m").ok).toBe(false);
    expect(s.deliver("x".repeat(70_000), "m").ok).toBe(false);
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
  });
});

describe("HEELER links", () => {
  test("button URL is https and the redirect page opens the heeler:// link", async () => {
    const b = heelerButton("Open", "wB:p3D");
    expect(b.url).toBe(`${HEELER_REDIRECT}?host=rig&pane=wB%3Ap3D`);
    expect(b.url.startsWith("https://")).toBe(true);
    const res = await worker.fetch(new Request(b.url.replace(HEELER_REDIRECT, "https://h.test/open")));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(heelerUrl("rig", "wB:p3D"));
    expect(heelerUrl("rig")).toBe("heeler://agent?host=rig");
  });
  test("redirect page only builds validated heeler://agent URLs", async () => {
    expect(heelerTarget(new URLSearchParams("host=rig"))?.url).toBe("heeler://agent?host=rig");
    expect(heelerTarget(new URLSearchParams("host=a&pane=%22%3E%3Cscript%3E"))).toBeNull();
    expect(heelerTarget(new URLSearchParams("host=https://evil"))).toBeNull();
    expect(heelerTarget(new URLSearchParams("pane=wB:p1"))).toBeNull();
    expect((await worker.fetch(new Request("https://h.test/?u=https://evil"))).status).toBe(404);
  });
});
