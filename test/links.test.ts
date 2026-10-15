import { expect, test } from "bun:test";
import { shortenLinks } from "../src/links.ts";

test("long URLs become short masked links; code is untouched", () => {
  const out = shortenLinks("a https://cdn.discordapp.com/x/y/IMG.png?ex=1&hm=2 b\n[https://x.com/u/status/123456789012](https://x.com/u/status/123456789012)\n`https://k.io/i`\n```\nhttps://k.io/f\n```");
  expect(out).toContain("[cdn.discordapp.com/IMG.png ↗](<https://cdn.discordapp.com/x/y/IMG.png?ex=1&hm=2>)");
  expect(out).toContain("[x.com ↗](<https://x.com/u/status/123456789012>)");
  expect(out).toContain("`https://k.io/i`");
  expect(out).toContain("```\nhttps://k.io/f\n```");
});
