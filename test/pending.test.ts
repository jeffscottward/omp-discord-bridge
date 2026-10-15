import { describe, expect, test } from "bun:test";
import { fitLines, pendingLine } from "../src/pending";

describe("pending restart line", () => {
  test("no waiter: no line", () => expect(pendingLine(null)).toBeNull());
  test("counts updates", () => {
    expect(pendingLine({ updates: 1 })).toContain("1 update ready");
    expect(pendingLine({ updates: 9 })).toContain("9 updates ready");
    expect(pendingLine({ updates: 0 })).toContain("no new code (reload only)");
    expect(pendingLine({ updates: 3 })).toContain("restarts when this queue is empty");
  });
});

describe("fitLines", () => {
  test("keeps whole lines and marks the cut", () => {
    const link = "1. [msg](https://discord.com/channels/1/2/3)";
    const out = fitLines(Array(100).fill(link), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.split("\n").slice(0, -1).every((l) => l === link)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
  test("short boards are unchanged", () => expect(fitLines(["a", "b"])).toBe("a\nb"));
});

import { markRestarted } from "../src/pending";
test("markRestarted swaps only the pending line", () => {
  const b = "⏳ **Queue**\n🔄 **Restart pending:** 3 updates ready. The bot restarts when this queue is empty.\n🏁 **Finished**";
  const t = markRestarted(b, "abc1234");
  expect(t).toContain("✅ **Restarted:** the bot is running `abc1234`");
  expect(t).not.toContain("Restart pending");
  expect(t).toContain("🏁 **Finished**");
});
