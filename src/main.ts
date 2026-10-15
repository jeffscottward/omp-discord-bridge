import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DiscordAPIError,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ApplicationCommandOptionType,
  type ApplicationCommandDataResolvable,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  MessageType,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  Partials,
  type SendableChannels,
  ThreadAutoArchiveDuration,
} from "discord.js";
import { blockFromContent } from "./blocks.ts";
import { BUSY_TEXT, buttonAllowed, FIRSTMATE_PANE, FirstmateSender, SEND_BUTTON_ID } from "./firstmate.ts";
import type { LinkButton } from "./heeler.ts";
import { Approvals, APPROVE_PREFIX } from "./approvals.ts";
import { extractAttachments } from "./attach.ts";
import { isVoice, transcribe } from "./voice.ts";
import { speakable, synthesize } from "./speech.ts";
import { ASK_PREFIX, AskStore, answersText, extractAsk, isOtherOption, type AskQuestion } from "./ask.ts";
import { ALERT_CHANNELS, BOT_ENV_FILE, CONFIG, DEV_CHANNEL_ID, STATE_DIR, CHANNELS, GUILD_ID, MAX_CONCURRENT, OMP_BIN, OWNER_ID, requireConfig, RUN_TIMEOUT_MS, trusted, VOICE_CHANNEL_ID, VOICE_FALLBACK_CHANNEL_ID, VOICE_TRANSCRIPT_CHANNEL_ID, WORKING_EMOJI } from "./config.ts";
import { parseSpokenNumbers, spokenIntent } from "./spoken.ts";
import { VoiceChat } from "./voicechat.ts";
import { startHttp } from "./http.ts";
import { hasSession, onApprovalRequest, refreshDiscovery, resetSession, runHeartbeat, runOmp, stopRun, type RunResult } from "./omp.ts";
import { HEARTBEAT_MS } from "./heartbeat.ts";
import { refreshSecretValues } from "./secrets.ts";
import { prepareOutbound } from "./outbound.ts";
import { messageProvenance, route, threadName } from "./policy.ts";
import { buildPrompt, type PromptInput } from "./preamble.ts";
import { Mirror, sideSessionKey } from "./mirror.ts";
import { JobQueue } from "./queue.ts";
import { redact } from "./redact.ts";
import { noteIsLate, showWorking } from "./working.ts";
import { rigReport, type StatKind } from "./rigstats.ts";
import { usageReport } from "./usage.ts";
import { setRgb } from "./rgb.ts";
import { fitLines, markRestarted, pendingLine, pendingRestart, recordPendingBoard, takePendingBoards } from "./pending.ts";
import * as rig from "./rigcmds.ts";
// Fail fast with a clear message when ~/.config/omp-discord/config.json is missing or invalid.
requireConfig();
const REPO_DIR = resolve(import.meta.dir, "..");

function loadToken(): string {
  if (!existsSync(BOT_ENV_FILE)) {
    console.error(`omp-discord-bot: no bot token file at ${BOT_ENV_FILE}. Create it with one line: DISCORD_BOT_TOKEN=<your bot token> (chmod 600).`);
    process.exit(78);
  }
  const env = readFileSync(BOT_ENV_FILE, "utf8");
  const m = env.match(/^\s*DISCORD_BOT_TOKEN\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
  if (!m) throw new Error(`DISCORD_BOT_TOKEN missing in ${BOT_ENV_FILE}`);
  return m[1]!;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const queue = new JobQueue<RunResult>(MAX_CONCURRENT);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const NO_PINGS = { allowedMentions: { parse: [] as never[] } };
/** Owner 2026-10-15: only full answers notify. Status/progress posts are Discord silent messages. */
const QUIET = { ...NO_PINGS, flags: MessageFlags.SuppressNotifications as const };
const mirror = new Mirror(client);

/** Only the owner's private channels: the guild (incl. threads) or a DM with the owner. */
async function privateChannel(id: string): Promise<SendableChannels | null> {
  try {
    const ch = await client.channels.fetch(id);
    if (!ch?.isSendable()) return null;
    if ("guildId" in ch && ch.guildId === GUILD_ID) return ch;
    if (ch.type === ChannelType.DM && ch.recipientId === OWNER_ID) return ch;
  } catch {}
  return null;
}

const approvals = new Approvals({
  privateChannel,
  send: async (ch, text, links) => void (await sendText(ch, text, links)),
  sendApproval: async (ch, text, id) => {
    const out = prepareOutbound(text);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${APPROVE_PREFIX}${id}`).setStyle(ButtonStyle.Success).setLabel(`Approve ${id}`),
    );
    for (const [i, m] of out.messages.entries()) {
      const last = i === out.messages.length - 1;
      await ch.send({ content: m.content, components: last ? [row] : [], ...NO_PINGS });
    }
  },
  log,
});
onApprovalRequest((e) => approvals.onRequest(e));
const firstmate = new FirstmateSender({ log });

/**
 * Outbound: privacy filter + split. Paste blocks go out as their own messages (only the fenced
 * block) with "Send to FIRSTMATE" + "Open FIRSTMATE in HEELER". `links` go on the last message.
 */
/**
 * Owner 2026-10-15: name the spoken reply after the request instead of "reply.ogg", e.g.
 * "rename-the-audio-file.ogg". Discord needs the .ogg extension to show its audio player.
 */
function audioName(prompt: string): string {
  const stop = new Set(["a", "an", "the", "is", "are", "to", "of", "and", "or", "for", "in", "on", "it", "that", "this", "can", "you", "we", "i", "me", "my", "please", "just", "so", "be", "do", "with", "there"]);
  const words = prompt.replace(/https?:\/\/\S+/g, " ").replace(/^\[[^\]]*\]\s*/, "").toLowerCase()
    .normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !stop.has(w));
  let slug = "";
  for (const w of words) {
    if ((slug ? slug.length + 1 : 0) + w.length > 48) break;
    slug = slug ? `${slug}-${w}` : w;
    if (slug.split("-").length >= 6) break;
  }
  return `REPLY-${slug || "omp"}.ogg`;
}

async function sendText(target: SendableChannels, text: string, links?: LinkButton[], replyTo?: Message, voiceTurn = false, audio?: string, audioFile = "omp-reply.ogg"): Promise<Message | undefined> {
  const ask = extractAsk(text);
  if (ask.error) log(`ask block ignored: ${ask.error}`);
  text = ask.text;
  const att = trusted() ? extractAttachments(text) : { text, files: [], notes: [] };
  const out = prepareOutbound([att.text, ...att.notes].filter(Boolean).join("\n\n"));
  if (Object.keys(out.hits).length) log(`redacted outbound: ${JSON.stringify(out.hits)}`);
  const tail = links ?? [];
  let first: Message | undefined;
  let last: Message | undefined;
  for (const [i, m] of out.messages.entries()) {
    const files = m.file ? [new AttachmentBuilder(Buffer.from(m.file.data, "utf8"), { name: m.file.name })] : [];
    const links = i === out.messages.length - 1 ? tail : [];
    const buttons = links.map((l) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(l.label).setURL(l.url));
    if (m.paste) buttons.unshift(new ButtonBuilder().setCustomId(SEND_BUTTON_ID).setStyle(ButtonStyle.Primary).setLabel("Send to FIRSTMATE"));
    const components = buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
    if (i === out.messages.length - 1) for (const f of att.files) files.push(new AttachmentBuilder(f.path, { name: f.name }));
    const reply = i === 0 && replyTo ? { reply: { messageReference: replyTo.id, failIfNotExists: false } } : {};
    // Owner 2026-10-15: the spoken audio rides on the first message (one message, one notification).
    const withAudio = i === 0 && audio && files.length < 10;
    if (withAudio) files.push(new AttachmentBuilder(audio, { name: audioFile }));
    const content = withAudio && m.content.length <= 1997 ? `🔊 ${m.content}` : m.content;
    const loud = audio ? withAudio : i === 0;
    const sent = own(await target.send({ content, files, components, ...reply, ...(loud ? NO_PINGS : QUIET) }));
    first ??= sent;
    last = sent;
  }
  // In voice mode the owner is offered the choice first (see offerQuestionsInVoice).
  if (ask.questions) {
    if (voicechat.active && voiceTurn) await offerQuestionsInVoice(target, ask.questions);
    else last = (await sendQuestions(target, ask.questions)) ?? last;
  }
  void first;
  return last;
}

const asks = new AskStore();

/**
 * Voice conversation mode (src/voicechat.ts). The owner joining "🎧 OMP Voice" turns it on and
 * leaving turns it off. Spoken messages are answered in the channel or thread the owner last
 * wrote in, exactly like a voice message attachment.
 */
const voicechat = new VoiceChat({
  guildId: GUILD_ID,
  channelId: VOICE_CHANNEL_ID,
  ownerId: OWNER_ID,
  onTranscript: (text) => onVoiceTranscript(text),
  log,
});
let lastOwnerChannelId: string | null = null;

/** Questions waiting for a spoken answer. Only one set at a time, like the button flow. */
interface VoiceAsk {
  setId: string;
  channelId: string;
  questions: AskQuestion[];
  mode: "choose" | "answering";
  qi: number;
}
let voiceAsk: VoiceAsk | null = null;

/** In voice mode the buttons are not posted until the owner asks for them. */
async function offerQuestionsInVoice(target: SendableChannels, questions: AskQuestion[]): Promise<void> {
  const set = asks.create(target.id, questions);
  voiceAsk = { setId: set.setId, channelId: target.id, questions, mode: "choose", qi: 0 };
  const n = questions.length;
  const s = n === 1 ? "" : "s";
  await target.send({ content: `❓ ${n} question${s} — say **"read them out"** or **"post them"**.`, ...QUIET });
  await say(`I have ${n} question${s}. Read them out, or post them?`);
}

function spokenQuestion(a: VoiceAsk): string {
  const q = a.questions[a.qi]!;
  const head = a.questions.length > 1 ? `Question ${a.qi + 1} of ${a.questions.length}. ` : "";
  const opts = q.options.map((o, i) => `${i + 1}. ${o}`).join(". ");
  return `${head}${q.question} ${opts}.${q.multi ? " You can say more than one number." : ""}`;
}

/**
 * A spoken utterance while questions are open. True when it answered them (or chose how to get
 * them); anything else is left alone and becomes a normal free-text message.
 */
async function handleVoiceAsk(text: string): Promise<boolean> {
  const a = voiceAsk;
  if (!a) return false;
  const target = await privateChannel(a.channelId);
  if (!target) {
    voiceAsk = null;
    return false;
  }
  if (a.mode === "choose") {
    const intent = spokenIntent(text);
    if (intent === "post") {
      voiceAsk = null;
      await sendQuestions(target, a.questions);
      await say("Posted.");
      return true;
    }
    if (intent !== "read") {
      voiceAsk = null;
      return false;
    }
    a.mode = "answering";
    a.qi = 0;
    await say(spokenQuestion(a));
    return true;
  }
  const q = a.questions[a.qi]!;
  const picks = parseSpokenNumbers(text);
  if (!picks || picks.some((n) => n > q.options.length) || (!q.multi && picks.length > 1)) {
    voiceAsk = null;
    return false;
  }
  const r = asks.answer(AskStore.customId(a.setId, a.qi), picks.map((n) => String(n - 1)));
  if (r === "unknown") {
    voiceAsk = null;
    return false;
  }
  const note = await target.send({ content: `🎙️ **${q.question}** → ${picks.map((n) => q.options[n - 1]).join(", ")}`, ...QUIET });
  if (r === "partial") {
    a.qi++;
    await say(spokenQuestion(a));
    return true;
  }
  voiceAsk = null;
  log(`ask ${r.setId}: answered by voice; sending as the owner's next turn`);
  await handle(note, { authorId: OWNER_ID, text: answersText(r) });
  return true;
}

/** A transcribed utterance from the voice channel, handled as the owner's typed message. */
/** Pre-encoded hold-music clips (scripts/hold-music.sh). */
function holdTracks(): string[] {
  try {
    const dir = join(STATE_DIR, "hold-music", "ready");
    return readdirSync(dir).filter((f) => f.endsWith(".ogg") && !f.includes(".tmp") && !f.includes(".part")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Speak in the call and log it to the transcript. */
async function say(text: string): Promise<void> {
  void transcriptLog(`🤖 **OMP:** ${text}`);
  await voicechat.speak(text);
}

/** Append one turn to 📝 voice-transcript (best effort). */
async function transcriptLog(line: string): Promise<void> {
  const ch = await privateChannel(VOICE_TRANSCRIPT_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send({ content: line.slice(0, 1900), ...QUIET }).catch((e) => log(`transcript log: ${(e as Error).message}`));
}

async function onVoiceTranscript(text: string): Promise<void> {
  if (await handleVoiceAsk(text)) return;
  const target = (lastOwnerChannelId ? await privateChannel(lastOwnerChannelId) : null) ?? (await privateChannel(VOICE_FALLBACK_CHANNEL_ID));
  if (!target) {
    log("voice: nowhere to answer");
    return;
  }
  const member = await client.guilds.cache.get(GUILD_ID)?.members.fetch(OWNER_ID).catch(() => null);
  const note = await target.send({ content: `🎙️ from **${member?.displayName ?? "the owner"}**: *${text.replace(/[*_`]/g, "")}*`, ...QUIET });
  void transcriptLog(`🎙️ **${member?.displayName ?? "Owner"}:** ${text}`);
  // Owner pick 2026-10-13: short acknowledgement so the thinking time is not dead air.
  // Then quiet hold music until the answer is spoken (stops automatically when speech starts).
  void voicechat.speak("One moment.").then(() => voicechat.startHold(holdTracks())).catch(() => {});
  voicechat.mark("turn-to-agent", { chars: text.length, channel: target.id });
  await handle(note, { authorId: OWNER_ID, text, fromVoice: true });
}

/**
 * One message per question. Options are written out in full as a numbered list (select menus cut
 * long labels off on phones), with one short number button each. Multi-select: buttons toggle,
 * then "✅ Done". Owner-only; see src/ask.ts.
 */
const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const multiPicks = new Map<string, Set<number>>();

function askRows(setId: string, qi: number, q: AskQuestion, picked = new Set<number>()): ActionRowBuilder<ButtonBuilder>[] {
  const max = q.multi ? 24 : 25;
  const buttons = q.options.slice(0, max).map((o, oi) =>
    new ButtonBuilder()
      .setCustomId(`${AskStore.customId(setId, qi)}:${isOtherOption(o) ? "other" : oi}`)
      .setLabel(isOtherOption(o) ? `${oi + 1} ✏️` : String(oi + 1))
      .setStyle(picked.has(oi) ? ButtonStyle.Success : q.recommended === oi ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  if (q.multi) buttons.push(new ButtonBuilder().setCustomId(`${AskStore.customId(setId, qi)}:done`).setLabel("✅ Done").setStyle(ButtonStyle.Primary));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function sendQuestions(target: SendableChannels, questions: AskQuestion[]): Promise<Message | undefined> {
  const set = asks.create(target.id, questions);
  let lastQ: Message | undefined;
  for (const [qi, q] of questions.entries()) {
    const n = questions.length > 1 ? ` **Question ${qi + 1} of ${questions.length}**\n` : " ";
    const list = q.options.map((o, oi) => `${NUM[oi] ?? `**${oi + 1}.**`} ${isOtherOption(o) ? "✏️ Other (type or dictate a reply)" : o}${q.recommended === oi ? " **⭐ (Recommended)**" : ""}`).join("\n");
    const hint = q.multi ? "\n*Tap all that apply, then ✅ Done. Or type or dictate a reply.*" : "\n*Tap a number (✏️ opens a text box), or type or dictate a reply.*";
    const text = `❓${n}${q.question}\n\n${list}\n${hint}`;
    lastQ = own(await target.send({ content: prepareOutbound(text).messages[0]?.content ?? text.slice(0, 1900), components: askRows(set.setId, qi, q), ...QUIET }));
  }
  return lastQ;
}

async function handleAskButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can answer.", flags: MessageFlags.Ephemeral });
    return;
  }
  const m = i.customId.match(/^(ask:[a-z0-9]+:\d+):(\d+|done|other)$/);
  if (!m) return;
  if (m[2] === "other") {
    const q0 = asks.question(m[1]!);
    if (!q0) {
      await i.reply({ content: "This question expired or is no longer open.", flags: MessageFlags.Ephemeral });
      return;
    }
    const input = new TextInputBuilder().setCustomId("text").setLabel("Your answer").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    await i.showModal(new ModalBuilder().setCustomId(`askmodal:${m[1]}`).setTitle(q0.question.slice(0, 45)).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    return;
  }
  const qid = m[1]!;
  const pick = m[2]!;
  const [, setId = "", qiStr = "0"] = qid.split(":");
  const q = asks.question(qid);
  if (!q) {
    await i.reply({ content: "This question expired or is no longer open.", flags: MessageFlags.Ephemeral });
    return;
  }
  let values: number[];
  if (q.multi) {
    const sel = multiPicks.get(qid) ?? new Set<number>();
    if (pick !== "done") {
      const oi = Number(pick);
      sel.has(oi) ? sel.delete(oi) : sel.add(oi);
      multiPicks.set(qid, sel);
      await i.update({ components: askRows(setId, Number(qiStr), q, sel) });
      return;
    }
    if (!sel.size) {
      await i.reply({ content: "Pick at least one number first.", flags: MessageFlags.Ephemeral });
      return;
    }
    values = [...sel];
    multiPicks.delete(qid);
  } else values = [Number(pick)];
  const r = asks.answer(qid, values.map(String));
  if (r === "unknown") {
    await i.reply({ content: "This question expired or is no longer open.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.update({ content: (`${i.message.content}\n\n✅ **${values.map((v) => v + 1).join(", ")}**`), components: [] });
  if (r === "partial") return;
  log(`ask ${r.setId}: all answered; sending as the owner's next turn`);
  await handle(i.message, { authorId: i.user.id, text: answersText(r) });
}

async function handleAskModal(i: ModalSubmitInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return;
  const qid = i.customId.slice("askmodal:".length);
  const text = i.fields.getTextInputValue("text");
  const q = asks.question(qid);
  // Multi-select: keep any numbers already ticked, add the typed answer.
  const ticked = q?.multi ? [...(multiPicks.get(qid) ?? [])].map(String) : [];
  multiPicks.delete(qid);
  const r = asks.answer(qid, ticked, Date.now(), text);
  if (r === "unknown" || !i.message) {
    await i.reply({ content: "This question expired or is no longer open.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferUpdate();
  await i.message.edit({ content: `${i.message.content}\n\n✅ ✏️ *${text.replace(/[*_`]/g, "").slice(0, 300)}*`, components: [] });
  if (r === "partial") return;
  log(`ask ${r.setId}: all answered (with Other); sending as the owner's next turn`);
  await handle(i.message, { authorId: i.user.id, text: answersText(r) });
}

/** Discord CDN attachment of a long paste block (bridge's own message). */
async function attachmentText(url: string): Promise<string | null> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(u.hostname)) return null;
  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const t = await r.text();
  return t.length <= 60_000 ? t : null;
}

/** "Send to FIRSTMATE": owner only; delivered only when FIRSTMATE is idle and its input box is empty. */
async function handleSendButton(i: ButtonInteraction): Promise<void> {
  const ok = buttonAllowed({
    userId: i.user.id,
    ownerId: OWNER_ID,
    guildId: i.guildId,
    ownGuildId: GUILD_ID,
    isDM: !i.inGuild(),
    messageAuthorId: i.message.author.id,
    botId: client.user?.id,
  });
  if (!ok) {
    log(`firstmate-send: refused button from ${i.user.id} (not owner or not a bridge message)`);
    await i.reply({ content: "Only the owner can use this button.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const first = firstmate.check();
  if (!first.ok) {
    log(`firstmate-send: msg=${i.message.id} refused (${first.reason})`);
    await i.editReply(`${BUSY_TEXT}\n-# ${first.reason}`);
    return;
  }
  const file = i.message.attachments.find((a) => /^paste-\d+\.txt$/.test(a.name));
  const block = file ? await attachmentText(file.url).catch(() => null) : blockFromContent(i.message.content);
  if (block === null) {
    await i.editReply("Could not read the block from this message. Nothing was sent.");
    return;
  }
  const r = firstmate.deliver(block, i.message.id); // re-checks idle + empty input right before sending
  await i.editReply(r.ok ? `✅ Sent to FIRSTMATE (\`${r.id}\`).` : `${BUSY_TEXT}\n-# ${r.reason}`);
}

async function setReaction(msg: Message, emoji: string, on: boolean): Promise<void> {
  try {
    if (on) await msg.react(emoji);
    // Custom emojis are cached by id; unicode ones may be cached with or without U+FE0F.
    // Remove our own reaction over REST (the message cache can be stale). Custom emoji -> "name:id".
    else {
      const custom = emoji.match(/^<a?:(\w+):(\d+)>$/);
      const key = custom ? `${custom[1]}:${custom[2]}` : encodeURIComponent(emoji);
      await client.rest.delete(`/channels/${msg.channelId}/messages/${msg.id}/reactions/${key}/@me`);
    }
  } catch (e) {
    log(`reaction ${emoji} failed: ${(e as Error).message}`);
  }
}

function fmtAge(since: number): string {
  const s = Math.round((Date.now() - since) / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function statusText(): string {
  const st = queue.status();
  const lines = [`**omp bridge** — running ${st.running.length}/${st.max}, queued ${st.queued.length}`];
  for (const j of st.running) lines.push(`▶️ #${j.id} ${j.label} — ${fmtAge(j.since)} (${j.key.startsWith("dm-") ? "DM" : `<#${j.key}>`})`);
  for (const j of st.queued) lines.push(`⏸️ #${j.id} ${j.label} — waiting ${fmtAge(j.since)}`);
  return lines.join("\n");
}

/**
 * Discord → mirrored pane. Nothing is typed into the pane. If no omp process holds the pane's
 * session, the turn continues that session file in the sandbox (`omp -p --resume`). Otherwise it
 * runs in the linked side session, with a read-only excerpt of the pane's transcript as context.
 */
async function runMirrored(
  channelId: string,
  threadId: string | null,
  target: SendableChannels,
  p: Omit<PromptInput, "followUp" | "context">,
): Promise<RunResult> {
  const d = await mirror.decide(channelId, threadId);
  if (!d) throw new Error("this channel is no longer mirrored");
  if (d.mode === "pane") {
    log(`mirror: continuing pane session ${d.entry.machine}:${d.entry.paneId} (no live omp)`);
    mirror.busy.add(d.entry.channelId);
    try {
      return await runOmp(
        d.key,
        d.cwd,
        buildPrompt({ ...p, where: `${p.where} (continuing the pane's own session)`, followUp: true, approvals: approvals.takeResults(d.key) }),
        { channelId: target.id, resumeFile: d.sessionFile },
      );
    } finally {
      await mirror.markConsumed(d.entry);
      mirror.busy.delete(d.entry.channelId);
    }
  }
  log(`mirror: side session ${d.key} for ${d.entry.machine}:${d.entry.paneId} (${d.reason})`);
  const context = d.context ? { title: `pane "${d.entry.tab}" session (${d.entry.machine})`, text: d.context } : undefined;
  const prompt = buildPrompt({ ...p, where: `${p.where} (side session)`, followUp: hasSession(d.key), context, approvals: approvals.takeResults(d.key) });
  return runOmp(d.key, d.cwd, prompt, { channelId: target.id });
}

/**
 * `asOwner`: the owner's answer picked from an ask menu (the interaction user was already checked
 * against OWNER_ID); `msg` is then the bridge's own question message, used only for routing.
 */
/**
 * One live "queue board" per channel (owner request 2026-10-13): the first Queued notice is kept,
 * and later queue/start/finish events are appended to it instead of posting a new stack.
 */
/** One standalone, silent queue message per channel. */
const queueBoards = new Map<string, { msg: Message; text: string; recent: string[] }>();

/** ↩️ Undo after Stop (owner request 2026-10-14): a new run in the same session that reverts the stopped turn. */
const UNDO_PREFIX = "undo:";
const undoJobs = new Map<string, { msg: Message; startedAt: number; text: string }>();

async function handleUndoButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can undo.", flags: MessageFlags.Ephemeral });
    return;
  }
  const u = undoJobs.get(i.customId.slice(UNDO_PREFIX.length));
  if (!u) {
    await i.update({ components: [] }).catch(() => {});
    await i.followUp({ content: "Nothing to undo for this one any more (the bot restarted).", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  undoJobs.delete(i.customId.slice(UNDO_PREFIX.length));
  await i.update({ content: "🛑 Stopped. ↩️ Undo requested.", components: [] });
  const since = new Date(u.startedAt).toISOString();
  const quoted = u.text.replace(/\s+/g, " ").slice(0, 300);
  await handle(u.msg, {
    authorId: i.user.id,
    text: [
      `[Undo button] The owner stopped your previous turn (started ${since}, request: "${quoted}") and wants everything it changed reverted.`,
      "Restore files, git state (uncommitted edits and any commits made in that turn; never force-push), configs and services to how they were before that turn started.",
      "Do not redo the original request. Leave changes from earlier turns alone. If something cannot be undone (sent messages, orders, external effects), say exactly what. Then report briefly what you reverted.",
    ].join(" "),
  });
}

/** ❌ Stop / cancel (owner request 2026-10-13). */
const STOP_PREFIX = "stop:";
const workingMsgs = new Map<number, Message>();
const finishedJobs = new Set<number>();
/** Owner 2026-10-15: every 10 s the Working message shows a real liveness check (src/heartbeat.ts). */
const heartbeatTimers = new Map<number, NodeJS.Timeout>();
const jobKeys = new Map<number, string>();
/** Owner 2026-10-15: board rows link to the job's message (jump link), so no manual scrolling. */
const jobLinks = new Map<number, string>();
const boardItem = (id: number, text: string) => {
  const url = jobLinks.get(id);
  const t = text.replace(/[[\]]/g, "");
  return url ? `🔗 [${t}](${url})` : t;
};
/** Owner 2026-10-15: queue position as a number emoji on each waiting message (1️⃣ 2️⃣ 3️⃣ …). */
/** Shown while a job runs: ⚙️, or a custom animated emoji from the config (scripts/make-spin-gear.ts uploads one). */
const WORKING = WORKING_EMOJI;
const DIGITS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const queuedNotes = new Map<number, Message>();
const queuedMsgs = new Map<number, { msg: Message; badge?: string }>();
let badgeSync: Promise<void> = Promise.resolve();
function syncBadges(): Promise<void> {
  badgeSync = badgeSync.then(async () => {
    const order = queue.status().queued.map((q) => q.id);
    for (const [id, q] of queuedMsgs) {
      const n = order.indexOf(id);
      const want = n < 0 ? undefined : DIGITS[Math.min(n, DIGITS.length - 1)];
      if (q.badge === want) continue;
      if (q.badge) await setReaction(q.msg, q.badge, false);
      if (want) await setReaction(q.msg, want, true);
      q.badge = want;
      if (n < 0) queuedMsgs.delete(id);
    }
  }).catch((e) => log(`queue badges: ${(e as Error).message}`));
  return badgeSync;
}
const cancelRow = (id: number) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${STOP_PREFIX}${id}`).setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

async function handleStopButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can stop a job.", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = Number(i.customId.slice(STOP_PREFIX.length));
  if (queue.cancel(id)) {
    void syncBadges();
    jobKeys.delete(id);
    jobLinks.delete(id);
    await i.update({ content: "🛑 Cancelled before it started.", components: [] });
    return;
  }
  const key = jobKeys.get(id);
  if (key && stopRun(key)) {
    await i.update({ content: "🛑 Stopping…", components: [] });
    return;
  }
  await i.update({ components: [] }).catch(() => {});
  await i.followUp({ content: "That job already finished.", flags: MessageFlags.Ephemeral }).catch(() => {});
}

/**
 * Queue board (owner 2026-10-15): its own SILENT message (no notification), always the last message in the
 * channel while a queue exists. Reprinted below every new message (debounced), updated by edits.
 * Number buttons at the bottom cancel the matching waiting job, so no per-message "Queued." notes.
 */
const BOARD_RULE = "━━━━━━━━━━━━━━━━━━━━";
const SILENT = { flags: MessageFlags.SuppressNotifications as const };
function waitingFor(channelId: string) {
  return queue.status().queued.filter((q) => jobKeys.get(q.id) === channelId);
}
function renderBoard(channelId: string, recent: string[]): string {
  const st = queue.status();
  const mine = (id: number) => jobKeys.get(id) === channelId;
  const running = st.running.filter((r) => mine(r.id)).map((r) => `${WORKING} ${boardItem(r.id, r.preview ?? r.label)}`);
  const all = waitingFor(channelId).map((q, n) => `${n + 1}. ${boardItem(q.id, q.preview ?? q.label)}`);
  // Cut waiting rows (not the Restart pending / Finished lines) when the board would be too long.
  const budget = 1300;
  const waiting: string[] = [];
  let used = 0;
  for (const [n, l] of all.entries()) {
    if (used + l.length + 1 > budget) {
      waiting.push(`… ${all.length - n} more`);
      break;
    }
    waiting.push(l);
    used += l.length + 1;
  }
  const lines = [BOARD_RULE, "⏳ **Queue**", "———————————", ...running, ...waiting];
  if (!running.length && !waiting.length) lines.push("*Nothing left — all done.*");
  const pending = pendingLine(pendingRestart());
  if (pending) lines.push("\u200b", pending);
  if (recent.length) lines.push("\u200b", "🏁 **Finished**", "———————————", ...recent.slice(-5));
  return fitLines(lines);
}

/** Record an event (✅/❌/🛑 lines are kept as "finished") and re-render the board in place. */
async function editBoard(channelId: string, line: string): Promise<void> {
  const b = queueBoards.get(channelId);
  if (!b) return;
  if (/\*\*(Done|Stopped):\*\*/.test(line)) b.recent.push(line.trim().replace(/\*\*(Done|Stopped):\*\* /, ""));
  // Let the queue settle (the finished job is removed just before onDone).
  await new Promise((r) => setTimeout(r, 50));
  b.text = renderBoard(channelId, b.recent);
  await b.msg.edit({ content: b.text }).catch(() => {});
  if (b.text.includes("Restart pending")) recordPendingBoard(STATE_DIR, channelId, b.msg.id);
}

const isBoardText = (t: string) => t.startsWith("⏳ **Queue") || t.startsWith(`${BOARD_RULE}\n⏳ **Queue`);
const boardTimers = new Map<string, NodeJS.Timeout>();
const boardChains = new Map<string, Promise<void>>();
const boardFinal = new Set<string>();
/** Board reprints running now; with boardTimers, /health reports them so a restart never cuts the 🏁 Finished post. */
let boardInflight = 0;
/** First time a reprint was requested and not yet run: a steady stream of messages must not hold the board back. */
const boardPendingSince = new Map<string, number>();
const BOARD_MAX_WAIT_MS = 3000;
/** Debounced: reprint the board below the newest message. `final` (after the last answer) closes it. */
function keepBoardLast(channelId: string, delay = 1200, final = false): void {
  if (!queueBoards.has(channelId)) return;
  if (final) boardFinal.add(channelId);
  const now = Date.now();
  const since = boardPendingSince.get(channelId) ?? now;
  boardPendingSince.set(channelId, since);
  const wait = Math.max(0, Math.min(delay, since + BOARD_MAX_WAIT_MS - now));
  clearTimeout(boardTimers.get(channelId));
  boardTimers.set(channelId, setTimeout(() => {
    boardTimers.delete(channelId);
    const asked = boardPendingSince.get(channelId) ?? Date.now();
    boardPendingSince.delete(channelId);
    const close = boardFinal.delete(channelId);
    boardInflight++;
    const run = (boardChains.get(channelId) ?? Promise.resolve()).then(() => reprintBoard(channelId, close, asked)).catch((e) => log(`board reprint: ${(e as Error).message}`)).finally(() => boardInflight--);
    boardChains.set(channelId, run);
  }, wait));
}
async function reprintBoard(channelId: string, close: boolean, asked = Date.now()): Promise<void> {
  const t0 = Date.now();
  const b = queueBoards.get(channelId);
  if (!b || !b.msg.channel.isSendable()) return void log(`board reprint skipped: ${b ? "channel not sendable" : "no board"} close=${close}`);
  const ch = b.msg.channel;
  b.text = renderBoard(channelId, b.recent);
  const recent = await ch.messages.fetch({ limit: 30 }).catch((e) => (log(`board fetch: ${(e as Error).message}`), null));
  const tFetch = Date.now();
  let action = "edit";
  if (recent?.first()?.id === b.msg.id) await b.msg.edit({ content: b.text }).catch((e) => log(`board edit: ${(e as Error).message}`));
  else {
    action = "post";
    const fresh = await ch.send({ content: b.text, ...QUIET }).catch((e) => (log(`board post: ${(e as Error).message}`), null));
    if (fresh) {
      await b.msg.delete().catch(() => {});
      b.msg = fresh;
    } else action = "post-failed";
  }
  const tSend = Date.now();
  let stale = 0;
  for (const m of recent?.values() ?? []) {
    if (m.id !== b.msg.id && m.author.id === client.user?.id && isBoardText(m.content)) {
      stale++;
      await m.delete().catch(() => {});
    }
  }
  const busy = [...queue.status().running, ...queue.status().queued].some((x) => jobKeys.get(x.id) === channelId);
  if (close && !busy) queueBoards.delete(channelId); // the 🏁 Finished board stays until the owner writes again
  if (b.text.includes("Restart pending")) recordPendingBoard(STATE_DIR, channelId, b.msg.id);
  log(`board ${action} ${b.msg.id} close=${close} final=${close && !busy} queuedMs=${t0 - asked} fetchMs=${tFetch - t0} sendMs=${tSend - tFetch} totalMs=${Date.now() - t0} staleDeleted=${stale}`);
}
/** After a job's answer is posted: board below it; after the last job, the final reprint closes it. */
async function boardToBottom(channelId: string): Promise<void> {
  keepBoardLast(channelId, 1500, true);
}

/**
 * A finished board (or one left by a restart or an older version) must not stay above new work: when the
 * owner writes and no queue is active, delete the bot's earlier boards and cut boards appended to answers.
 */
async function clearStaleBoards(msg: Message): Promise<void> {
  const older = await msg.channel.messages.fetch({ before: msg.id, limit: 30 }).catch(() => null);
  for (const m of older?.values() ?? []) {
    if (m.author.id !== client.user?.id || queueBoards.get(msg.channelId)?.msg.id === m.id) continue;
    if (isBoardText(m.content)) {
      await m.delete().catch((e) => log(`stale board delete: ${(e as Error).message}`));
      continue;
    }
    const at = m.content.indexOf(`\n\n${BOARD_RULE}\n⏳ **Queue`);
    if (at > 0) await m.edit({ content: m.content.slice(0, at) }).catch((e) => log(`stale board strip: ${(e as Error).message}`));
  }
}

/** Messages posted by the conversation flow (kept for callers; the board no longer lives inside them). */
const ownPosts = new Set<string>();
function own<T extends Message | null | undefined>(m: T): T {
  if (m) {
    ownPosts.add(m.id);
    if (ownPosts.size > 500) ownPosts.delete(ownPosts.values().next().value!);
  }
  return m;
}


async function handle(msg: Message, asOwner?: { authorId: string; text: string; fromVoice?: boolean }): Promise<void> {
  // Provenance: only the owner's own account (not a bot, webhook or system message) is routed.
  // Messages the bridge itself produced (bot user, relay webhooks, self-tests) never are.
  const prov = asOwner ? "owner" : messageProvenance({
    authorId: msg.author.id,
    isBot: msg.author.bot,
    isWebhook: Boolean(msg.webhookId),
    isSystem: msg.system || (msg.type !== MessageType.Default && msg.type !== MessageType.Reply),
    botUserId: client.user?.id,
  });
  if (prov !== "owner") {
    if (prov === "other" && msg.author.id !== client.user?.id) log(`ignored message from ${msg.author.id} (not owner)`);
    return;
  }
  const isDM = msg.channel.type === ChannelType.DM;
  const isThread = msg.channel.isThread();
  const parentId = msg.channel.isThread() ? msg.channel.parentId : null;
  const authorId = asOwner?.authorId ?? msg.author.id;
  let text = asOwner ? asOwner.text : msg.content.trim();
  // Mirrored Herdr tab channels: never typed into the pane (see src/mirror.ts).
  const mirrored = msg.guildId === GUILD_ID ? mirror.byChannel(parentId ?? msg.channelId) : undefined;
  const threadId = isThread ? msg.channelId : null;
  const r = mirrored
    ? null
    : route({
        authorId,
        authorIsBot: asOwner ? false : msg.author.bot || Boolean(msg.webhookId),
        guildId: msg.guildId,
        channelId: msg.channelId,
        isDM,
        isThread,
        parentId,
      });
  if (r?.kind === "ignore") {
    if (r.reason === "not-owner" || r.reason === "bot") log(`ignored message from ${msg.author.id} (${r.reason})`);
    return;
  }

  if (asOwner && text.startsWith("!")) return;
  if (text === "/queue" || text === "!queue") {
    const ch = msg.channelId;
    const sent = await msg.reply({ content: renderBoard(ch, []), ...QUIET }).catch(() => null);
    if (sent) queueBoards.set(ch, { msg: sent, text: sent.content, recent: [] });
    return;
  }
  if (text === "!status") {
    await msg.reply({ content: statusText(), ...QUIET });
    return;
  }
  const deny = text.match(/^!deny\s+([a-z2-9]{8})$/i);
  if (deny) {
    const id = deny[1]!.toLowerCase();
    const r = approvals.deny(id, "the owner in Discord");
    const reply = {
      cancelled: "Cancelled. Nothing ran.",
      running: "Too late: it was already approved with the password and has started.",
      unknown: "No pending approval with that id.",
    }[r];
    await msg.reply({ content: `\`${id}\`: ${reply}`, ...QUIET });
    return;
  }

  let target: SendableChannels;
  let key: string;
  let threadUrl: string;
  let where: string;
  let cwd: string;
  if (mirrored) {
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = threadId ?? `mirror-${mirrored.channelId}`; // queue key: one run per channel/thread at a time
    cwd = "";
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${msg.channelId}`;
    where = `#${mirrored.name}`;
    if (text === "!new") {
      const side = sideSessionKey(mirrored, threadId);
      resetSession(side);
      await msg.reply({ content: `Started a fresh side session (\`${side}\`). The pane's own session is unchanged.`, ...QUIET });
      return;
    }
  } else if (!r) {
    return;
  } else if (r.kind === "new-thread") {
    if (msg.channel.type !== ChannelType.GuildText) return;
    const thread = await msg.startThread({
      name: threadName(text || msg.attachments.first()?.name || "omp task"),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
    target = thread;
    key = thread.id;
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${thread.id}`;
    where = `#${r.channelName}`;
    cwd = r.cwd;
  } else if (r.kind === "thread") {
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = msg.channelId;
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${msg.channelId}`;
    where = `#${r.channelName}`;
    cwd = r.cwd;
  } else {
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = `dm-${msg.channelId}`;
    threadUrl = `https://discord.com/channels/@me/${msg.channelId}`;
    where = "DM";
    cwd = r.cwd;
    if (text === "!new") {
      resetSession(key);
      await msg.reply({ content: "Started a fresh session for this DM.", ...QUIET });
      return;
    }
  }
  // Spoken messages are answered wherever the owner last wrote (src/voicechat.ts).
  lastOwnerChannelId = target.id;

  if (!text && msg.attachments.size === 0) return;
  // Voice messages: transcribe locally, show the transcript, use it as the typed message.
  const voice = asOwner ? [] : [...msg.attachments.values()].filter((a) => isVoice(a));
  let spoken = "";
  for (const v of voice) {
    try {
      const t = await transcribe(v.url);
      spoken += (spoken ? "\n" : "") + t;
    } catch (e) {
      log(`voice: ${(e as Error).message}`);
      await target.send({ content: "⚠️ I couldn't transcribe that voice message. Please type it instead.", ...NO_PINGS });
      return;
    }
  }
  if (voice.length) {
    if (!spoken) {
      await target.send({ content: "🎙️ I couldn't hear any speech in that voice message.", ...QUIET });
      return;
    }
    // Owner 2026-10-15: swap the voice message for its transcript as soon as it is transcribed. The transcript
    // message then carries the ⏳/✅ reactions, ⚙️ Working, Stop/Undo and the answer's reply link.
    // Guild only (bots can't delete DM messages); only when the message is nothing but voice.
    const header = `🎙️ from **${msg.member?.displayName ?? msg.author.globalName ?? msg.author.username}**: *${spoken.replace(/[*_`]/g, "")}*`;
    if (voice.length === msg.attachments.size && !msg.content.trim() && msg.inGuild()) {
      const t = own(await target.send({ content: header, ...QUIET }));
      await msg.delete().catch((e) => log(`voice source delete: ${(e as Error).message}`));
      msg = t;
    } else await msg.reply({ content: header, ...QUIET });
    text = text ? `${text}\n${spoken}` : spoken;
  }
  const attachments = asOwner ? [] : [...msg.attachments.values()].filter((a) => !isVoice(a)).map((a) => ({ name: a.name, url: a.url }));
  const source = { kind: "owner" as const, authorId };
  const followUp = hasSession(key);
  const label = `${where} ${threadName(text || "attachment").slice(0, 60)}`;
  const run = mirrored
    ? () => runMirrored(mirrored.channelId, threadId, target, { source, content: text, threadUrl, where, attachments })
    : () => runOmp(key, cwd, buildPrompt({ source, content: text, threadUrl, where, followUp, attachments, approvals: approvals.takeResults(key) }), { channelId: target.id });

  await setReaction(msg, "⏳", true);
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const preview = words.length ? `${words.slice(0, 6).join(" ").slice(0, 60)}${words.length > 6 ? "…" : ""}` : "attachment";
  let startedAt: number | undefined;
  let gearOn: Promise<void> = Promise.resolve();
  const { id, position } = queue.enqueue({
    key,
    label,
    preview,
    run,
    onStart: () => {
      void syncBadges();
      // Owner 2026-10-15: ⏳ = waiting in the queue, ⚙️ = being worked on now.
      gearOn = setReaction(msg, "⏳", false).then(() => setReaction(msg, WORKING, true));
      // Owner 2026-10-15: turn this job's ⏳ Queued. note into Working… in place, so the order stays
      // ✅ done → ⚙️ Working (Stop) → ⏳ waiting (Cancel). No note (started at once): post at the bottom.
      const note = queuedNotes.get(id);
      queuedNotes.delete(id);
      startedAt = Date.now();
      log(`job start key=${key} cwd=${cwd || "(mirror)"} followUp=${followUp}`);
      // One board edit per job start (owner 2026-10-15): the refresh after Working… posts below covers it.
      const stop = new ButtonBuilder().setCustomId(`${STOP_PREFIX}${id}`).setLabel("Stop").setEmoji("❌").setStyle(ButtonStyle.Danger);
      const working = { content: `${WORKING} Working…`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(stop)], ...QUIET };
      const post = () => msg.reply(working);
      void showWorking(note, { content: working.content, components: working.components, ...NO_PINGS }, post)
        .then((m) => {
          if (finishedJobs.delete(id)) return void m.delete().catch(() => {});
          workingMsgs.set(id, own(m));
          jobLinks.set(id, m.url); // board "Now" links to the Working… message with Stop
          void editBoard(target.id, ""); // refresh now so the Now link points at Working… at once
          let editing = false;
          // Owner 2026-10-15: first heartbeat after ~2 s (the run is registered by then), then every 10 s.
          // One edit per 10 s stays far below Discord's edit rate limit (5 per 5 s per channel).
          const tick = () => {
            const hb = runHeartbeat(target.id);
            if (!hb || editing || !workingMsgs.has(id)) return;
            editing = true;
            let content: string;
            try {
              content = hb.tick();
            } catch (e) {
              editing = false;
              return void log(`heartbeat ${id}: ${(e as Error).message}`);
            }
            m.edit({ content, ...NO_PINGS })
              .catch((e) => {
                log(`heartbeat edit ${id}: ${(e as Error).message}`);
                if (e instanceof DiscordAPIError && e.code === 10008) clearInterval(heartbeatTimers.get(id)); // message deleted
              })
              .finally(() => (editing = false));
          };
          heartbeatTimers.set(id, setInterval(tick, HEARTBEAT_MS));
          setTimeout(tick, 2_000);
        })
        .catch(() => void editBoard(target.id, "")); // Working… failed: still refresh the board
    },
    onDone: async (res, err) => {
      let answer: Message | undefined;
      try {
      // Owner 2026-10-15: delete the ⚙️ Working… message when the job ends (it cluttered the chat).
      clearInterval(heartbeatTimers.get(id));
      heartbeatTimers.delete(id);
      const wm = workingMsgs.get(id);
      if (wm) void wm.delete().catch(() => {});
      else finishedJobs.add(id); // reply not posted yet: delete it when it lands
      workingMsgs.delete(id);
      jobKeys.delete(id);
      jobLinks.delete(id);
      if (res?.cancelled) {
        if (asOwner?.fromVoice) void voicechat.stopHold();
        await gearOn;
        await setReaction(msg, WORKING, false);
        undoJobs.set(String(id), { msg, startedAt: startedAt ?? Date.now(), text });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${UNDO_PREFIX}${id}`).setLabel("Undo its changes").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
        );
        answer = (await msg.reply({ content: "🛑 Stopped. To steer, just type or dictate a correction. To go back to before this message, tap ↩️ Undo.", components: [row], ...QUIET }).catch(() => null)) ?? undefined;
        void editBoard(target.id, `\n🛑 **Stopped:** ${preview}`);
        return;
      }
      void editBoard(target.id, `\n${res?.ok ? "✅" : "❌"} **Done:** ${preview}`);
      log(`job ${id} done key=${key} ok=${res?.ok ?? false} code=${res?.code ?? "n/a"} timedOut=${res?.timedOut ?? false} ms=${res?.durationMs ?? 0}`);
      await gearOn;
      await setReaction(msg, WORKING, false);
      if (res?.ok) {
        await setReaction(msg, "✅", true);
        // Owner 2026-10-15: wait for the speech (fast on the GPU), then send ONE message with text + audio.
        // If speech takes over 45 s or fails, the text goes out alone (the audio follows as a 🔊 reply if it arrives).
        const spokenSource = prepareOutbound(extractAsk(res.stdout).text).messages.filter((m) => !m.paste).map((m) => m.content).join("\n");
        const audio = synthesize(spokenSource).catch(() => null);
        const ready = await Promise.race([audio, new Promise<"late">((r) => setTimeout(() => r("late"), 45_000))]);
        answer = await sendText(target, res.stdout, undefined, msg, asOwner?.fromVoice === true, typeof ready === "string" && ready !== "late" ? ready : undefined, audioName(text));
        const file = await audio;
        if (!file && asOwner?.fromVoice) void voicechat.stopHold();
        if (file) {
          if (ready === "late") {
            log("tts late: posting audio separately");
            const ref = { reply: { messageReference: msg.id, failIfNotExists: false } };
            await target.send({ content: "🔊", files: [new AttachmentBuilder(file, { name: audioName(text) })], ...ref, ...QUIET }).catch((e) => log(`tts post: ${(e as Error).message}`));
          }
          // Same speakable text, played in the voice channel while the owner is in it.
          // Phone-call rule (owner 2026-10-13): only answers to what was SAID in the call are spoken.
          if (asOwner?.fromVoice) {
            // Owner 2026-10-13: no length cap in the call (they can stop it any time).
            await voicechat.speakFile(file).catch((e) => log(`voice say: ${(e as Error).message}`));
            void transcriptLog(`🤖 **OMP:** ${speakable(spokenSource)}`);
          }
          rmSync(dirname(file), { recursive: true, force: true });
        }
        return;
      }
      if (asOwner?.fromVoice) void voicechat.stopHold();
      await setReaction(msg, "❌", true);
      if (res?.timedOut) {
        answer = await sendText(
          target,
          `⏱️ The run hit the ${Math.round(RUN_TIMEOUT_MS / 60_000)}-minute limit and was stopped. The session is kept — reply here to continue.${res.stdout ? `\n\nPartial output:\n${res.stdout}` : ""}`,
        );
        return;
      }
      const detail = err ? (err as Error).message : (res?.stderrTail || res?.stdout || "no output").slice(-800);
      answer = await sendText(target, `❌ OMP run failed (exit ${res?.code ?? "n/a"}).\n\`\`\`\n${redact(detail).text.replace(/```/g, "ˋˋˋ")}\n\`\`\``);
      } finally {
        // Owner 2026-10-15: when the queue is done, the board moves below the last answer.
        void boardToBottom(target.id);
      }
    },
  });
  jobKeys.set(id, target.id);
  jobLinks.set(id, msg.url);
  if (position > 0) {
    queuedMsgs.set(id, { msg });
    void syncBadges();
    // Owner 2026-10-15: each queued message gets a silent "⏳ Queued." note with its own Cancel button.
    const note = await msg.reply({ content: "⏳ Queued.", components: [cancelRow(id)], ...QUIET }).catch(() => null);
    // Race: the job can start (or be cancelled) while this reply is in flight. Then onStart found no note and
    // posted Working… at the bottom; a late note must not keep a Cancel button for a running job.
    if (note && noteIsLate(id, queue.status().queued.map((q) => q.id))) void note.delete().catch(() => {});
    else if (note) {
      queuedNotes.set(id, note);
      jobLinks.set(id, note.url); // owner 2026-10-15: board links go to the note with Cancel
    }
    const place = queue.status().queued.findIndex((q) => q.id === id) + 1 || position;
    if (queueBoards.has(target.id)) await editBoard(target.id, `\n➕ **Queued:** ${preview} (#${place} in line)`);
    else {
      const text = renderBoard(target.id, []);
      const sent = await target.send({ content: text, ...QUIET }).catch(() => null);
      if (sent) queueBoards.set(target.id, { msg: sent, text, recent: [] });
    }
    keepBoardLast(target.id);
  }
}

// discord.js waits out 429s silently; log them so stalls (for example board reprints) are visible.
client.rest.on("rateLimited", (i) => log(`rate limited ${i.method} ${i.route} wait=${i.timeToReset}ms global=${i.global}`));

client.once(Events.ClientReady, (c) => {
  // Keep the ~1.5 s home-directory walk off the main thread: prime now, refresh every 50 s.
  void refreshDiscovery();
  void refreshSecretValues();
  setInterval(() => { void refreshDiscovery(); void refreshSecretValues(); }, 50_000);
  log(`READY as ${c.user.tag} (${c.user.id}); guilds=${c.guilds.cache.size}`);
  log(`mirror: ${mirror.entries.filter((e) => !e.archived).length} channels; never types into panes`);
  const post = async (channelId: string, text: string) => {
    const ch = await mirror.channel(channelId);
    if (ch) await sendText(ch, text);
  };
  void mirror.sync().then(() => mirror.tail(post));
  setInterval(() => void mirror.sync(), 15_000); // new/closed tabs (was 60 s)
  setInterval(() => void mirror.tail(post).catch((e) => log(`tail error: ${(e as Error).message}`)), 1_000); // owner 2026-10-13: near-instant (was 5 s); tail() skips overlapping runs
  setInterval(() => void approvals.tick().catch((e) => log(`approvals error: ${(e as Error).message}`)), 2_000);
  // The bot sits in 🎧 OMP Voice all the time; voice mode is on while the owner is there too.
  if (VOICE_CHANNEL_ID) void (async () => {
    const ch = await c.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (ch?.isVoiceBased()) await voicechat.stay(ch);
    const member = await c.guilds.cache.get(GUILD_ID)?.members.fetch(OWNER_ID).catch(() => null);
    if (member?.voice.channelId === VOICE_CHANNEL_ID) voicechat.ownerJoined();
  })().catch((e) => log(`voice join: ${(e as Error).message}`));
});
client.on(Events.MessageCreate, (msg) => {
  if (!(msg.author.id === client.user?.id && isBoardText(msg.content))) keepBoardLast(msg.channelId);
  if (msg.author.id === OWNER_ID && !queueBoards.has(msg.channelId)) void clearStaleBoards(msg);
  handle(msg).catch((e) => log(`handler error: ${(e as Error).message}`));
});
/** Owner joins "🎧 OMP Voice" = voice mode on; owner leaves = off. Nobody else can turn it on. */
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.id !== OWNER_ID || newState.guild.id !== GUILD_ID) return;
  if (newState.channelId === oldState.channelId) return;
  if (newState.channelId === VOICE_CHANNEL_ID && newState.channel) {
    voicechat.ownerJoined();
    void voicechat.stay(newState.channel).catch((e) => log(`voice join: ${(e as Error).message}`)); // no-op when already connected
    return;
  }
  if (oldState.channelId === VOICE_CHANNEL_ID) voicechat.ownerLeft();
});
async function handleApproveButton(i: ButtonInteraction): Promise<void> {
  const ok = buttonAllowed({
    userId: i.user.id,
    ownerId: OWNER_ID,
    guildId: i.guildId,
    ownGuildId: GUILD_ID,
    isDM: !i.inGuild(),
    messageAuthorId: i.message.author.id,
    botId: client.user?.id,
  });
  if (!ok) {
    log(`approve-button: refused from ${i.user.id}`);
    await i.reply({ content: "Only the owner can approve.", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = i.customId.slice(APPROVE_PREFIX.length);
  const r = approvals.approveButton(id, "the owner");
  log(`approve-button: ${id} -> ${r}`);
  const text = {
    started: `▶️ \`${id}\` approved — running. The result follows here.`,
    gone: `\`${id}\` is no longer pending (already ran, denied or expired).`,
    changed: `\`${id}\` changed after it was posted. Nothing ran.`,
    expired: `\`${id}\` expired. Nothing ran.`,
    unknown: `\`${id}\` is not a pending approval I posted.`,
    off: "Trusted mode is off, so the button is disabled. Use the HEELER approval tab.",
  }[r];
  await i.update({ components: [] }).catch(() => {});
  await i.followUp({ content: text, ...QUIET });
}

// Owner 2026-10-15: /cpu, /gpu, /memory and /stats report the rig's usage; /usage shows AI provider limits
// like `omp usage`; /rgb toggles the rig lights (state:on|off sets them). Guild commands (they appear at once).
const STAT_COMMANDS: (ApplicationCommandDataResolvable & { name: string })[] = [
  { name: "cpu", description: "Rig CPU usage, load, temperature and top programs" },
  { name: "gpu", description: "Rig GPU load, VRAM, temperature, power and top programs" },
  { name: "memory", description: "Rig memory and swap usage and top programs" },
  { name: "stats", description: "Rig CPU, GPU and memory in one report" },
  { name: "usage", description: "AI provider usage limits for every account (like omp usage)" },
  {
    name: "rgb",
    description: "Toggle all rig lights, or set them on or off",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "state",
        description: "on or off (leave empty to toggle)",
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
        ],
      },
    ],
  },
  ...(() => {
    const svc = (list: readonly string[], desc: string) => ({
      type: ApplicationCommandOptionType.String as const,
      name: "service",
      description: desc,
      required: true,
      choices: list.map((s) => ({ name: s, value: s })),
    });
    return [
      { name: "services", description: "Status of the configured systemd user services" },
      { name: "logs", description: "Last 20 log lines of one service", options: [svc(Object.keys(rig.SERVICES), "Which service")] },
      { name: "disk", description: "Free space per drive and the largest folders in ~" },
      { name: "restart", description: "Restart one service (asks first)", options: [svc(rig.RESTARTABLE, "Which service")] },
      { name: "panes", description: "Herdr tabs on the rig" },
      { name: "net", description: "Tailscale exit node, egress location and ping to the configured hosts" },
      { name: "stream", description: "Sunshine status, monitor power and VRAM leak check" },
      {
        name: "remind",
        description: "Set an Omarchy reminder on the rig",
        options: [
          { type: ApplicationCommandOptionType.Integer as const, name: "minutes", description: "In how many minutes", required: true, min_value: 1, max_value: 10080 },
          { type: ApplicationCommandOptionType.String as const, name: "text", description: "Reminder text", required: true, max_length: 200 },
        ],
      },
      { name: "updates", description: "Pending repo and AUR updates (list only)" },
      ...(CONFIG.mirror?.macSshHost ? [{ name: "mac", description: "Is the second machine reachable, uptime and battery" }] : []),
    ];
  })(),
  { name: "help", description: "List the bot's slash commands" },
];
/** /help text: every registered command with its description and options. */
function helpText(): string {
  const lines = ["📖 **Slash commands**", "———————————"];
  for (const c of STAT_COMMANDS) {
    const opts = "options" in c && Array.isArray(c.options) ? (c.options as { name: string; choices?: { name: string }[] }[]) : [];
    const args = opts.map((o) => ` [${o.name}:${o.choices?.map((x) => x.name).join("|") ?? "…"}]`).join("");
    lines.push(`\`/${c.name}${args}\` · ${"description" in c ? c.description : ""}`);
  }
  lines.push("", "💬 Anything else: just write a message here.");
  return lines.join("\n");
}
client.once(Events.ClientReady, (c) => {
  // Owner 2026-10-15: swap the old board's "Restart pending" line for "Restarted".
  const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_DIR, encoding: "utf8" }).stdout.trim();
  for (const [chId, msgId] of Object.entries(takePendingBoards(STATE_DIR))) {
    void (async () => {
      const ch = await c.channels.fetch(chId).catch(() => null);
      if (!ch?.isTextBased()) return;
      const m = await ch.messages.fetch(msgId).catch(() => null);
      if (!m) return void log(`restarted: board ${msgId} gone`);
      const text = markRestarted(m.content, rev);
      if (text !== m.content) await m.edit({ content: text }).then(() => log(`board ${msgId}: marked restarted`)).catch((e) => log(`restarted edit: ${(e as Error).message}`));
    })();
  }
  const guild = c.guilds.cache.get(GUILD_ID);
  if (!guild) return void log("slash commands: guild not in cache");
  guild.commands
    .set(STAT_COMMANDS)
    .then((set) => log(`slash commands registered: ${[...set.values()].map((x) => `/${x.name}`).join(" ")}`))
    .catch((e) => log(`slash commands: ${(e as Error).message}`));
});
async function handleStatCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "These commands are for the owner only.", flags: MessageFlags.Ephemeral }));
  if (i.commandName === "restart") {
    // Ask first: a private confirm button; the restart runs only after the owner presses it.
    const svc = i.options.getString("service", true);
    const yes = new ButtonBuilder().setCustomId(`${RSVC_PREFIX}${svc}`).setLabel(`Restart ${svc}`).setEmoji("🔄").setStyle(ButtonStyle.Danger);
    return void (await i.reply({ content: `🔄 Restart **${svc}**?`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(yes)], flags: MessageFlags.Ephemeral }));
  }
  await i.deferReply();
  let text: string;
  try {
    const name = i.commandName;
    text =
      name === "help" ? helpText()
      : name === "usage" ? await usageReport(OMP_BIN)
      : name === "rgb" ? await setRgb((i.options.getString("state") as "on" | "off" | null) ?? "toggle")
      : name === "services" ? await rig.services()
      : name === "logs" ? await rig.logs(i.options.getString("service", true), (s) => redact(s).text)
      : name === "disk" ? await rig.disk()
      : name === "panes" ? await rig.panes()
      : name === "net" ? await rig.net()
      : name === "stream" ? await rig.stream()
      : name === "remind" ? await rig.remind(i.options.getInteger("minutes", true), i.options.getString("text", true))
      : name === "updates" ? await rig.updates()
      : name === "mac" ? await rig.mac()
      : await rigReport(name as StatKind);
  } catch (e) {
    // Never leave "is thinking…" hanging: answer with the error's first line.
    text = `⚠️ **/${i.commandName} failed:** ${(e as Error).message.split("\n")[0]?.slice(0, 300)}`;
    log(`/${i.commandName} error: ${(e as Error).message}`);
  }
  await i.editReply({ content: text, allowedMentions: { parse: [] } });
}
const RSVC_PREFIX = "rsvc:";
client.on(Events.InteractionCreate, (i) => {
  if (i.isChatInputCommand() && STAT_COMMANDS.some((s) => s.name === i.commandName)) {
    handleStatCommand(i).catch((e) => log(`/${i.commandName} error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(RSVC_PREFIX)) {
    if (i.user.id !== OWNER_ID) return;
    const svc = i.customId.slice(RSVC_PREFIX.length);
    void (async () => {
      await i.update({ content: `🔄 Restarting **${svc}**…`, components: [] });
      const text = await rig.restartService(svc, REPO_DIR).catch((e) => `❌ ${(e as Error).message.split("\n")[0]}`);
      await i.editReply({ content: text });
      log(`/restart ${svc}: ${text}`);
    })().catch((e) => log(`restart-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(UNDO_PREFIX)) {
    handleUndoButton(i).catch((e) => log(`undo-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(STOP_PREFIX)) {
    handleStopButton(i).catch((e) => log(`stop-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("askmodal:")) {
    handleAskModal(i).catch((e) => log(`ask-modal error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(ASK_PREFIX)) {
    handleAskButton(i).catch((e) => log(`ask-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(APPROVE_PREFIX)) {
    handleApproveButton(i).catch((e) => log(`approve-button error: ${(e as Error).message}`));
    return;
  }
  if (!i.isButton() || i.customId !== SEND_BUTTON_ID) return;
  handleSendButton(i).catch((e) => {
    log(`firstmate-send error: ${(e as Error).message}`);
    const reply = { content: "Something went wrong. Nothing was sent.", flags: MessageFlags.Ephemeral } as const;
    void (i.deferred || i.replied ? i.editReply(reply.content) : i.reply(reply)).catch(() => {});
  });
});
client.on(Events.ChannelDelete, (ch) => {
  void mirror
    .closeDeleted(ch.id)
    .then(async (r) => {
      if (!r) return;
      const note = {
        closed: `🗑️ Channel for **${r.tab}** was deleted, so its idle Herdr tab was closed.`,
        busy: `⚠️ Channel for **${r.tab}** was deleted, but its agent is working or waiting for input, so the tab stays open. The channel will be recreated.`,
        unknown: `⚠️ Channel for **${r.tab}** was deleted, but I could not read the tab's state, so it stays open. The channel will be recreated.`,
        failed: `⚠️ Channel for **${r.tab}** was deleted, but closing the Herdr tab failed. It stays open.`,
      }[r.result];
      const alerts = await privateChannel(DEV_CHANNEL_ID);
      if (alerts) await alerts.send({ content: note, ...NO_PINGS });
    })
    .catch((e) => log(`channel-delete: ${(e as Error).message}`));
});
client.on(Events.ShardDisconnect, (_e, id) => log(`shard ${id} disconnected`));
client.on(Events.ShardResume, (id) => log(`shard ${id} resumed`));
client.on(Events.Error, (e) => log(`client error: ${e.message}`));

const mirrorChannel = (ref: string) => {
  const e = mirror.entries.find((x) => !x.archived && (x.channelId === ref || x.name === ref));
  return e ? { id: e.channelId, name: e.name } : null;
};
const server = startHttp({
  health: () => ({ ready: client.isReady(), voice: voicechat.active, boards: boardTimers.size + boardInflight, ...queue.status() }),
  resolveExtra: mirrorChannel,
  post: async (channelId, text) => {
    if (!client.isReady()) throw new Error("gateway not ready");
    if (!CHANNELS[channelId] && !ALERT_CHANNELS[channelId] && !mirrorChannel(channelId)) throw new Error("channel not sendable");
    const ch = await privateChannel(channelId);
    if (!ch) throw new Error("channel not sendable");
    await sendText(ch, text);
  },
});
log(`http listening on http://${server.hostname}:${server.port}`);

const shutdown = (sig: string) => {
  log(`${sig}: shutting down`);
  server.stop(true);
  voicechat.leave();
  void client.destroy().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await client.login(loadToken());
