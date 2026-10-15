// Manual live check of voice mode (owner request 2026-10-13). Run it from the repo:
//   bun scripts/voice-selftest.ts
// It opens a SECOND gateway session with the bot token, with no message handlers, so it reacts to
// nothing. It joins "🎧 OMP Voice", plays two utterances, then leaves. Audible proof that the
// gateway handshake, aes-256-gcm encryption and Ogg Opus playback work on this machine.
//
// The receive half (packets → Ogg → Whisper) is checked by test/voice-mode.test.ts, which does not
// need a person to talk.
import { readFileSync } from "node:fs";
import { getVoiceConnection } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { BOT_ENV_FILE, GUILD_ID, OWNER_ID, requireConfig, VOICE_CHANNEL_ID } from "../src/config.ts";
import { synthesize } from "../src/speech.ts";
import { VoiceChat } from "../src/voicechat.ts";

requireConfig();
if (!VOICE_CHANNEL_ID) throw new Error("voice.channelId is not set in config.json");
const token = readFileSync(BOT_ENV_FILE, "utf8").match(/^\s*DISCORD_BOT_TOKEN\s*=\s*["']?([^"'\s]+)/m)?.[1];
if (!token) throw new Error("DISCORD_BOT_TOKEN missing");
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const vc = new VoiceChat({
  guildId: GUILD_ID,
  channelId: VOICE_CHANNEL_ID,
  ownerId: OWNER_ID,
  onTranscript: async (t) => log("TRANSCRIPT:", t),
  log,
});

await client.login(token);
await new Promise<void>((r) => client.once(Events.ClientReady, () => r()));
const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
if (!channel?.isVoiceBased()) throw new Error("not a voice channel");

await vc.stay(channel);
vc.ownerJoined(); // test acts as if the owner were present
const connection = getVoiceConnection(GUILD_ID);
log("connection:", connection?.state.status, "| active:", vc.active);

const file = await synthesize("This is the second utterance. The queue plays them one at a time.");
log("second tts file:", file ? "ok" : "FAILED");
if (file) await vc.speakFile(file);

await new Promise((r) => setTimeout(r, 15_000));
log("still connected:", getVoiceConnection(GUILD_ID)?.state.status ?? "gone");
vc.leave();
await new Promise((r) => setTimeout(r, 1500));
log("after leave:", getVoiceConnection(GUILD_ID)?.state.status ?? "gone", "| active:", vc.active);
await client.destroy();
process.exit(0);
