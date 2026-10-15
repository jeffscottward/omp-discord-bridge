// Post a short status line to the owner's Discord channel (restart notices, reports).
// Usage: bun scripts/notify-owner.ts "<text>" [--file <path>]   Channel: $OMP_NOTIFY_CHANNEL or devChannelId from config.json.
// The bot token is read from bot.env and never printed.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEV_CHANNEL_ID, requireConfig } from "../src/config.ts";
const args = process.argv.slice(2);
const fi = args.indexOf("--file");
const file = fi >= 0 ? args.splice(fi, 2)[1] : undefined;
const text = args.join(" ").trim();
if (!text && !file) process.exit(0);
const env = readFileSync(`${process.env.HOME}/.config/omp-discord/bot.env`, "utf8");
const tok = env.match(/DISCORD_BOT_TOKEN=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!tok) process.exit(1);
if (!process.env.OMP_NOTIFY_CHANNEL) requireConfig();
const channel = process.env.OMP_NOTIFY_CHANNEL || DEV_CHANNEL_ID;
if (!/^\d{5,20}$/.test(channel)) {
  console.error("notify-owner: no channel (set OMP_NOTIFY_CHANNEL or devChannelId in config.json)");
  process.exit(1);
}
const payload = { content: text.slice(0, 1900), allowed_mentions: { parse: [] } };
let body: FormData | string;
const headers: Record<string, string> = { Authorization: `Bot ${tok}` };
if (file) {
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify(payload));
  fd.append("files[0]", new Blob([readFileSync(file)]), basename(file));
  body = fd;
} else {
  headers["content-type"] = "application/json";
  body = JSON.stringify(payload);
}
const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, { method: "POST", headers, body });
console.log(r.ok ? "posted" : `post failed: ${r.status}`);
process.exit(r.ok ? 0 : 1);
