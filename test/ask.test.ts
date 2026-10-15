
import { extractAsk as ex2 } from "../src/ask.ts";
import { test as t2, expect as e2 } from "bun:test";
t2("recommended: explicit index and '(Recommended)' suffix", () => {
  const a = ex2('x\n```ask\n{"questions":[{"id":"a","question":"Q?","options":["A","B"],"recommended":1},{"id":"b","question":"R?","options":["X (Recommended)","Y"]}]}\n```');
  e2(a.questions?.[0]?.recommended).toBe(1);
  e2(a.questions?.[1]?.recommended).toBe(0);
  e2(a.questions?.[1]?.options[0]).toBe("X");
});
