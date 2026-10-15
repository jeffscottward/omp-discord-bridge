// Spinning ⚙️ for "job running" (owner 2026-10-15). Source: Google's official animated Noto emoji (gear, U+2699),
// which rotates about its true centre. (Rotating the Twemoji gear ourselves wobbled: its artwork is off-centre.)
// Owner 2026-10-15: frames reversed so it spins clockwise (Noto spins counter-clockwise), and saved as animated
// WebP (smooth 8-bit alpha edges; GIF edges looked pixelated). Downscales to 128 px with every 2nd frame
// (Discord emoji limit 256 KB), checks that every frame is centred,
// and uploads it as the OMP bot's application emoji "spin_gear" (replacing any old one). Prints the new id.
// Usage: bun scripts/make-spin-gear.ts   (then set "workingEmoji": "<a:spin_gear:ID>" in config.json, ID = the printed id)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const dir = "/tmp/spin-gear-build";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const run = (cmd: string[]): string => {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd[0]}: ${r.stderr.toString().slice(0, 300)}`);
  return r.stdout.toString();
};
const src = await fetch("https://fonts.gstatic.com/s/e/notoemoji/latest/2699_fe0f/512.gif");
if (!src.ok) throw new Error(`Noto download: HTTP ${src.status}`);
writeFileSync(`${dir}/noto.gif`, Buffer.from(await src.arrayBuffer()));
run(["magick", `${dir}/noto.gif`, "-coalesce", `${dir}/n_%03d.png`]);
const half = readdirSync(dir).filter((f) => f.startsWith("n_")).sort().reverse().filter((_, i) => i % 2 === 0).map((f) => `${dir}/${f}`);
run(["magick", "-delay", "6", ...half, "-resize", "128x128", "-loop", "0", "-quality", "85", "-define", "webp:method=6", `${dir}/spin-gear.webp`]);
const gif = readFileSync(`${dir}/spin-gear.webp`);
if (gif.length > 256 * 1024) throw new Error(`gif too large for Discord: ${gif.length} bytes`);

// Centre check: in every frame the opaque area must have equal left/right and top/bottom margins (±1 px).
run(["magick", `${dir}/spin-gear.webp`, "-coalesce", `${dir}/c_%03d.png`]);
let worst = 0;
const frames = readdirSync(dir).filter((f) => f.startsWith("c_"));
for (const f of frames) {
  const [w, h, x, y] = run(["magick", `${dir}/${f}`, "-alpha", "extract", "-threshold", "50%", "-format", "%@", "info:"]).split(/[x+]/).map(Number);
  worst = Math.max(worst, Math.abs(x! - (128 - w! - x!)), Math.abs(y! - (128 - h! - y!)));
}
console.log(`${frames.length} frames, ${gif.length} bytes, worst centre offset ${worst} px`);
if (worst > 1) throw new Error("gear is not centred; not uploading");

const tok = readFileSync(`${process.env.HOME}/.config/omp-discord/bot.env`, "utf8").match(/DISCORD_BOT_TOKEN=(.+)/)![1]!.trim().replace(/^["']|["']$/g, "");
const H = { Authorization: `Bot ${tok}`, "content-type": "application/json" };
const app = (await (await fetch("https://discord.com/api/v10/applications/@me", { headers: H })).json()) as { id: string };
const list = (await (await fetch(`https://discord.com/api/v10/applications/${app.id}/emojis`, { headers: H })).json()) as { items: { id: string; name: string }[] };
const old = list.items?.find((e) => e.name === "spin_gear");
if (old) await fetch(`https://discord.com/api/v10/applications/${app.id}/emojis/${old.id}`, { method: "DELETE", headers: H });
const r = await fetch(`https://discord.com/api/v10/applications/${app.id}/emojis`, {
  method: "POST", headers: H,
  body: JSON.stringify({ name: "spin_gear", image: `data:image/webp;base64,${gif.toString("base64")}` }),
});
const j = (await r.json()) as { id?: string; animated?: boolean };
console.log(r.status, JSON.stringify({ id: j.id, animated: j.animated }));
