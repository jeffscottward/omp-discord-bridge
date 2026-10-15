import { expect, test } from "bun:test";
import { formatHeartbeat } from "../src/heartbeat";
const base = { startedAt: 0, tree: { alive: true, procs: 3, ticks: 0 }, cpuPct: 50, toolCalls: 0, pending: [], lastKind: "none" as const };
test("no session write after 8 s shows compaction with ETA", () => {
  expect(formatHeartbeat({ ...base, now: 20_000, lastWrite: 0 })).toContain("🗜️ Compacting memory (usually ~60 s, about 40s left)");
  expect(formatHeartbeat({ ...base, now: 70_000, lastWrite: 0 })).toContain("almost done");
});
test("normal start and active runs are not compaction", () => {
  expect(formatHeartbeat({ ...base, now: 5_000, lastWrite: 0 })).not.toContain("Compacting");
  expect(formatHeartbeat({ ...base, now: 20_000, lastWrite: 2_000 })).not.toContain("Compacting");
});
