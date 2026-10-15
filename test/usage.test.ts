import { describe, expect, test } from "bun:test";
import { formatUsage } from "../src/usage";

const now = 1_792_000_000_000;
const sample = {
  generatedAt: now,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: now - 1000,
      metadata: { email: "js*7@*", orgName: "Je*" },
      limits: [
        { label: "Claude 5 Hour", status: "ok", window: { resetsAt: now + 3_600_000 }, amount: { usedFraction: 0.27 } },
        { label: "Claude 7 Day", status: "ok", window: { resetsAt: now + 7_200_000 }, amount: { usedFraction: 0.95 } },
      ],
    },
    { provider: "openai-codex", fetchedAt: now - 4 * 86_400_000, metadata: { email: "rc*", planType: "pro" }, resetCredits: { availableCount: 2 }, limits: [{ label: "7 days", status: "ok", amount: { usedFraction: 0 } }] },
    { provider: "openai-codex", fetchedAt: now, metadata: { email: "js*b*", planType: "pro" }, limits: [] },
  ],
  capacity: { "openai-codex": [{ window: "7d", meter: "chat", accounts: 2, remainingAccounts: 2 }], anthropic: [{ window: "5h", accounts: 1, remainingAccounts: 0.73 }] },
  accountsWithoutUsage: [],
  disabledCredentials: [{}],
};

describe("formatUsage", () => {
  const t = formatUsage(sample, now);
  test("groups accounts by provider with counts", () => {
    expect(t).toContain("**Anthropic (Claude)** · 1 account");
    expect(t).toContain("**OpenAI Codex** · 2 accounts");
  });
  test("bars, percent, colour dot and relative reset time", () => {
    expect(t).toContain(`🟢 ▰▰▰▱▱▱▱▱▱▱ **27%** Claude 5 Hour · resets <t:${(now + 3_600_000) / 1000}:R>`);
    expect(t).toContain("🔴");
  });
  test("plan, saved resets and stale data age", () => {
    expect(t).toContain("👤 rc* · plan pro · ✦ 2 saved resets · data 4d old");
  });
  test("capacity only for multi-account providers; disabled credentials warned", () => {
    expect(t).toContain("📦 7d (chat): 2.00 of 2 accounts left");
    expect(t).not.toContain("📦 5h");
    expect(t).toContain("⚠️ 1 credential(s) are disabled in OMP");
  });
  test("empty report", () => {
    expect(formatUsage({ reports: [] }, now)).toContain("No usage reports");
  });
  test("stays under Discord's 2000-character limit", () => {
    const many = { reports: Array.from({ length: 80 }, (_, k) => ({ provider: "anthropic", metadata: { email: `a${k}` }, limits: [{ label: "Claude 5 Hour", amount: { usedFraction: 0.5 } }] })) };
    expect(formatUsage(many, now).length).toBeLessThanOrEqual(2000);
  });
});
