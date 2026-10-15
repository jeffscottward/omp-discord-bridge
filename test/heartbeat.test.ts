import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHeartbeat, RunHeartbeat, sampleTree, SessionTail, verdict, type HeartbeatView } from "../src/heartbeat.ts";

const T0 = Date.parse("2026-10-15T17:00:00Z");
const entry = (ts: number, message: object) => JSON.stringify({ type: "message", timestamp: new Date(ts).toISOString(), message }) + "\n";
const call = (ts: number, id: string, name: string, intent: string) => entry(ts, { role: "assistant", content: [{ type: "thinking" }, { type: "toolCall", id, name, intent, arguments: { command: "secret-arg" } }] });
const result = (ts: number, id: string) => entry(ts, { role: "toolResult", toolCallId: id, content: [] });
const view = (o: Partial<HeartbeatView>): HeartbeatView => ({
  now: T0 + 120_000,
  startedAt: T0,
  tree: { alive: true, procs: 3, ticks: 0 },
  cpuPct: 0,
  lastWrite: T0 + 115_000,
  toolCalls: 4,
  pending: [],
  lastKind: "model",
  ...o,
});

describe("session tail", () => {
  test("tracks pending tool calls across partial reads", () => {
    const t = new SessionTail("/nonexistent");
    const text = call(T0 + 1000, "a", "bash", "run tests") + result(T0 + 2000, "a") + call(T0 + 3000, "b", "wait", "wait for build");
    t.ingest(text.slice(0, 50));
    t.ingest(text.slice(50));
    expect(t.toolCalls).toBe(2);
    expect([...t.pending.values()]).toEqual([{ name: "wait", intent: "wait for build", since: T0 + 3000 }]);
    expect(t.lastKind).toBe("tool");
    t.ingest(result(T0 + 9000, "b"));
    expect(t.pending.size).toBe(0);
    expect(t.lastKind).toBe("model");
    expect(t.lastEntryAt).toBe(T0 + 9000);
  });
});

describe("verdict and text", () => {
  test("recent log write is alive; old quiet with a tool is waiting; old quiet without one is stuck", () => {
    expect(verdict(view({}))).toBe("alive");
    expect(verdict(view({ lastWrite: T0, now: T0 + 6 * 60_000, pending: [{ name: "bash", intent: "x", since: T0 }] }))).toBe("waiting");
    expect(verdict(view({ lastWrite: T0, now: T0 + 6 * 60_000 }))).toBe("stuck");
    expect(verdict(view({ lastWrite: T0, now: T0 + 6 * 60_000, cpuPct: 40 }))).toBe("alive");
    expect(verdict(view({ tree: { alive: false, procs: 0, ticks: 0 } }))).toBe("gone");
  });
  test("shows the tool name and intent, never its arguments", () => {
    const s = formatHeartbeat(view({ pending: [{ name: "bash", intent: "run `tests` now", since: T0 + 60_000 }], lastKind: "tool" }));
    expect(s).toContain("Working… 2m 0s");
    expect(s).toContain("🟢 **Alive** · checked <t:");
    expect(s).toContain("🔧 Running `bash`: run tests now (1m 0s)");
    expect(s).not.toContain("secret-arg");
    expect(formatHeartbeat(view({ lastWrite: T0, now: T0 + 6 * 60_000 }))).toContain("🔴 **No activity for 6m 0s");
  });
});

describe("live run", () => {
  test("samples this process tree and reads only the run's new session entries", () => {
    const tree = sampleTree(process.pid);
    expect(tree.alive).toBe(true);
    expect(tree.procs).toBeGreaterThanOrEqual(1);
    expect(sampleTree(2 ** 30).alive).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, call(T0 - 60_000, "old", "read", "earlier run")); // previous run: not counted
    const hb = new RunHeartbeat(T0, dir);
    hb.pid = process.pid;
    appendFileSync(f, call(T0 + 1000, "n", "bash", "build it"));
    const s = hb.tick(T0 + 20_000);
    expect(s).toContain("🔧 Running `bash`: build it (19s)");
    expect(s).toContain("1 tool calls");
    expect(s).not.toContain("earlier run");
  });
});
