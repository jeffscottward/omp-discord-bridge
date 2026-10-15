import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDenied, extractAttachments } from "../src/attach.ts";
import { AskStore, answersText, extractAsk } from "../src/ask.ts";
import { hostPath } from "../src/hostexec.ts";
import { buildPrompt } from "../src/preamble.ts";
import { createEntry, hashEntry, readEntry, readReceipt } from "../gate/queue.ts";
import { runFromButton } from "../gate/run.ts";

describe("trusted mode", () => {
  test("attach lines become files; bad ones become notes", () => {
    const d = mkdtempSync(join(tmpdir(), "att-"));
    writeFileSync(join(d, "a.mp4"), "x");
    writeFileSync(join(d, "big.bin"), "x".repeat(50));
    const r = extractAttachments(`Here.\n📎 attach: ${d}/a.mp4\n📎 attach: \`${d}/big.bin\`\n📎 attach: ${d}/nope\n📎 attach: rel.txt\nBye`, "/h", 10);
    expect(r.files).toEqual([{ path: `${d}/a.mp4`, name: "a.mp4" }]);
    expect(r.notes.length).toBe(3);
    expect(r.text).toBe("Here.\nBye");
    expect(extractAttachments("📎 attach: ~/x", "/h").notes[0]).toContain("not found");
  });

  test("attach only from allowed folders; no secrets, protected dirs or symlinks out", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(home, "Github", "r"), { recursive: true });
    mkdirSync(join(home, ".ssh"));
    mkdirSync(join(home, "Github", "r", ".git"));
    writeFileSync(join(home, "Github", "r", "v.mp4"), "x");
    writeFileSync(join(home, "Github", "r", ".env"), "x");
    writeFileSync(join(home, "Github", "r", ".git", "config"), "x");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "x");
    writeFileSync(join(home, "notes.txt"), "x");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, "Github", "r", "link.txt"));
    const roots = [join(home, "Github")];
    expect(attachDenied(join(home, "Github", "r", "v.mp4"), home, roots)).toBeNull();
    expect(attachDenied(join(home, "Github", "r", ".env"), home, roots)).toContain("secret");
    expect(attachDenied(join(home, "Github", "r", ".git", "config"), home, roots)).toContain("protected");
    expect(attachDenied(join(home, "notes.txt"), home, roots)).toContain("outside");
    expect(attachDenied(join(home, "Github", "r", "link.txt"), home, roots)).toContain("outside");
  });

  test("trusted runs may use /tmp as cwd", () => {
    const ctx = { home: "/h", scratchDir: "/s" };
    expect(hostPath(ctx, "/tmp/x", true)).toBe("/tmp/x");
    expect(hostPath(ctx, "/tmp/x", false)).toBeNull();
  });

  test("ask blocks become questions; picks come back as the next turn", () => {
    const t = 'Plan ready.\n```ask\n{"questions":[{"id":"a","question":"Scope?","options":["All","Chips"]},{"question":"Which?","options":["X","Y","Z"],"multi":true}]}\n```';
    const r = extractAsk(t);
    expect(r.text).toBe("Plan ready.");
    expect(r.questions?.length).toBe(2);
    expect(extractAsk("```ask\nnot json\n```").error).toContain("JSON");
    expect(extractAsk('```ask\n{"questions":[{"question":"Q","options":["only"]}]}\n```').questions).toBeNull();
    const store = new AskStore();
    const set = store.create("c", r.questions!, 1000);
    expect(store.answer(AskStore.customId(set.setId, 0), ["1"], 1000)).toBe("partial");
    expect(store.answer(AskStore.customId(set.setId, 0), ["0", "1"], 1000)).toBe("unknown");
    const done = store.answer(AskStore.customId(set.setId, 1), ["0", "2"], 1000);
    expect(done).not.toBe("partial");
    if (typeof done === "string") throw new Error("expected a completed set");
    expect(answersText(done)).toBe("[Answers to your questions, picked in Discord]\n- Scope? → Chips\n- Which? → X, Z");
    expect(store.answer(AskStore.customId(set.setId, 1), ["0"], 1000)).toBe("unknown");
  });

  test("button run: single use, hash checked, receipt written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-"));
    const e = createEntry(dir, { command: "echo hi", cwd: tmpdir(), reason: "", channelId: "1", sessionKey: "k", runId: "r" });
    expect(runFromButton(dir, e.id, "bad", "t").state).toBe("changed");
    const r = runFromButton(dir, e.id, hashEntry(e), "t");
    expect(r.state).toBe("started");
    await r.done;
    expect(readReceipt(dir, e.id)?.output).toContain("hi");
    expect(readReceipt(dir, e.id)?.detail).toContain("Discord button");
    expect(readEntry(dir, "pending", e.id)).toBeNull();
    expect(runFromButton(dir, e.id, hashEntry(e), "t").state).toBe("gone");
  });

  test("prompt rules switch with the mode", () => {
    const p = { source: { kind: "owner" as const, authorId: "1" }, content: "x", threadUrl: "u", where: "w", followUp: false };
    expect(buildPrompt(p, true)).toContain("NOT sandboxed");
    expect(buildPrompt(p, true)).toContain("no extra Discord approval layer");
    expect(buildPrompt(p, true)).not.toMatch(/Ask before consequential/);
    expect(buildPrompt(p, true)).toContain("```ask");
    expect(buildPrompt(p, false)).toContain("NO capability");
  });
});

test("Other option opens free text; typed answer is recorded", async () => {
  const { AskStore, answersText, isOtherOption } = await import("../src/ask.ts");
  expect(isOtherOption("✏️ Other (type a reply)")).toBe(true);
  expect(isOtherOption("Others pay")).toBe(false);
  const s = new AskStore();
  const set = s.create("c", [{ id: "n", question: "Name?", options: ["A", "✏️ Other (type a reply)"], multi: false }], 1);
  const r = s.answer(AskStore.customId(set.setId, 0), [], 1, "Talkback");
  if (typeof r === "string") throw new Error("expected done");
  expect(answersText(r)).toContain("Name? → Other: Talkback");
});

test("spokenIntent ignores long turns", async () => {
  const { spokenIntent } = await import("../src/spoken.ts");
  expect(spokenIntent("post them")).toBe("post");
  expect(spokenIntent("read them out")).toBe("read");
  expect(spokenIntent("after you say one moment I want lofi music and I will send you the youtube link for it")).toBeNull();
});

test("TTS spoken form: units and symbols read naturally; posted text untouched", async () => {
  const { speakable } = await import("../src/speech.ts");
  const s = speakable("70°F, 69% humidity, wind 9 mph WSW, 0.6–0.9 s, ~$4k → done");
  expect(s).toBe("70 degrees Fahrenheit, 69 percent humidity, wind 9 miles per hour west-southwest, 0.6 to 0.9 seconds, about 4 thousand dollars to done");
});

test("Markdown tables become aligned code blocks; fenced code untouched", async () => {
  const { tablesToCode } = await import("../src/tables.ts");
  const out = tablesToCode("Hi\n| Written | Spoken |\n|---|---|\n| **70°F** | 70 degrees |\n| 9 mph | 9 miles per hour |\nBye\n```\n| a | b |\n|---|---|\n```");
  expect(out).toBe("Hi\n```\nWritten  Spoken\n───────  ────────────────\n70°F     70 degrees\n9 mph    9 miles per hour\n```\nBye\n```\n| a | b |\n|---|---|\n```");
});
