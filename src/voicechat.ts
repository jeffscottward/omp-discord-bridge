// Voice-channel conversation mode (owner request 2026-10-13).
//
// The owner joining "🎧 OMP Voice" turns it on; leaving turns it off. While it is on:
//   - every final answer the bridge posts is also played in the channel, one at a time;
//   - the owner's speech is cut into utterances, transcribed locally (omp-whisper.service) and
//     handed to `onTranscript`.
// Only the owner's audio is ever subscribed to. Audio files live in a temp dir and are deleted as
// soon as the transcript comes back; nothing leaves the rig except the Opus we send to Discord.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { OggOpusFile } from "./ogg.ts";
import { UtteranceSegmenter } from "./segment.ts";
import { synthesize } from "./speech.ts";
import { transcribeFile } from "./voice.ts";
import { VoiceDebug } from "./voicedebug.ts";

/** How often the segmenter is asked whether the owner stopped talking. */
const POLL_MS = 100;
/** Audio the owner's microphone picks up from the speakers is ignored for this long after we talk. */
const ECHO_TAIL_MS = 400;

export interface VoiceChatOptions {
  guildId: string;
  channelId: string;
  ownerId: string;
  onTranscript: (text: string) => Promise<void>;
  log: (...a: unknown[]) => void;
}

const BARGE_PACKETS = 20; // 20 ms frames: ~0.4 s of continuous speech
export class VoiceChat {
  private readonly opts: VoiceChatOptions;
  private readonly player: AudioPlayer;
  private readonly seg = new UtteranceSegmenter();
  private connection: VoiceConnection | null = null;
  private receiveStream: AudioReceiveStream | null = null;
  private timer: NodeJS.Timeout | undefined;
  private utterance: OggOpusFile | null = null;
  /** Ready-to-play files (48 kHz stereo Ogg Opus), played strictly in order. */
  private readonly queue: string[] = [];
  private pumping = false;
  /** We are talking until this moment, so the microphone echo of our own voice is dropped. */
  private speakingUntil = 0;
  // Barge-in (owner request 2026-10-14): talking over a spoken answer stops it, and what the
  // owner says becomes the next turn. Needs ~0.4 s of real speech so a cough or echo blip does not.
  private bargePackets: Buffer[] = [];
  private bargeLast = 0;
  private bargedIn = false;

  private dbg: VoiceDebug | null = null;
  private pingTimer: NodeJS.Timeout | undefined;

  constructor(opts: VoiceChatOptions) {
    this.opts = opts;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.player.on("error", (e) => opts.log(`voice player: ${e.message}`));
    this.player.on("stateChange", (o, n) => {
      this.dbg?.ev("player", { from: o.status, to: n.status });
      // Hold music ran off the end of its clip: continue with the next track (owner request 2026-10-14).
      if (n.status === AudioPlayerStatus.Idle && this.holdOn && o.status !== AudioPlayerStatus.Idle
        && "resource" in o && o.resource === this.holdResource) this.nextHold();
    });
  }

  /** Debug event from outside (jobs, transcripts). No-op unless voice debug is on. */
  mark(type: string, data: Record<string, unknown> = {}): void {
    this.dbg?.ev(type, data);
  }

  /** On while the owner is in the voice channel. */
  get active(): boolean {
    return this.connection !== null && this.ownerHere;
  }

  // Owner request 2026-10-14: the bot stays in the voice channel all the time, so joining is
  // instant (no connect lag, no "voice mode is on" prompt, no clipped first words). "Voice mode"
  // means the owner is in the channel; leaving ends it, but the bot stays connected.
  private ownerHere = false;
  private lagTimer: NodeJS.Timeout | undefined;
  private txLast = 0;
  private txN = 0;
  private txMax = 0;
  private txWin = 0;
  private channel: VoiceBasedChannel | null = null;
  private rejoinTimer: NodeJS.Timeout | undefined;
  private failStreak = 0; // owner 2026-10-15: alert after repeated failures instead of retrying silently

  /** Connect and stay. Safe to call repeatedly. */
  async stay(channel: VoiceBasedChannel): Promise<void> {
    if (channel.id !== this.opts.channelId) return;
    this.channel = channel;
    if (this.connection) return;
    this.opts.log(`voice: joining ${channel.name} (always on)`);
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.opts.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // we have to hear the owner
      selfMute: false,
    });
    this.connection = connection;
    connection.on("stateChange", (o, n) => this.dbg?.ev("conn", { from: o.status, to: n.status }));
    // Per-packet send timing (owner request 2026-10-14): each 20 ms audio frame should leave on a
    // steady beat. Log gaps (>60 ms) right away and a 5 s summary, only while debug capture is on.
    // The player sends through dispatchAudio() (not playOpusPacket), once per 20 ms frame.
    const send = connection.dispatchAudio.bind(connection);
    connection.dispatchAudio = () => {
      const d = this.dbg;
      if (d) {
        const now = performance.now();
        const gap = this.txLast ? now - this.txLast : 0;
        this.txLast = now;
        if (gap > 60) d.ev("tx-gap", { ms: Math.round(gap) });
        this.txN++;
        this.txMax = Math.max(this.txMax, gap);
        if (now - this.txWin >= 5_000) {
          d.ev("tx", { packets: this.txN, maxGapMs: Math.round(this.txMax), udpPing: connection.ping.udp ?? null });
          this.txN = 0;
          this.txMax = 0;
          this.txWin = now;
        }
      }
      return send();
    };
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // A move or a short network drop: give it a moment to come back, otherwise reconnect.
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        this.opts.log("voice: disconnected; reconnecting in 5 s");
        this.disconnect();
        this.scheduleRejoin(5_000);
      });
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      this.opts.log(`voice: could not connect (${(e as Error).message}); retrying in 30 s`);
      if (++this.failStreak === 3)
        Bun.spawn(["bun", `${import.meta.dir}/../scripts/notify-owner.ts`,
          "⚠️ **OMP 🤖 cannot join 🎧 OMP Voice** (3 failed attempts; still retrying). Check that the bot can see the channel (View Channel, Connect, Speak)."], { stdout: "ignore", stderr: "ignore" });
      this.disconnect();
      this.scheduleRejoin(30_000);
      return;
    }
    connection.subscribe(this.player);
    this.listen();
    if (this.failStreak >= 3) Bun.spawn(["bun", `${import.meta.dir}/../scripts/notify-owner.ts`, "✅ **OMP 🤖 is back in 🎧 OMP Voice.**"], { stdout: "ignore", stderr: "ignore" });
    this.failStreak = 0;
    this.opts.log("voice: connected and waiting");
  }

  private scheduleRejoin(ms: number): void {
    clearTimeout(this.rejoinTimer);
    this.rejoinTimer = setTimeout(() => {
      if (this.channel) void this.stay(this.channel).catch((e) => this.opts.log(`voice rejoin: ${(e as Error).message}`));
    }, ms);
  }

  /** The owner joined: start a voice-mode session (and a debug capture if enabled). No greeting. */
  ownerJoined(): void {
    if (this.ownerHere) return;
    this.ownerHere = true;
    this.seg.reset();
    this.utterance = null;
    this.dbg = VoiceDebug.start();
    if (this.dbg) this.opts.log(`voice: debug capture on -> ${this.dbg.dir}`);
    // Event-loop stall detector: a blocked bot process cannot send audio frames on time.
    let lagLast = performance.now();
    clearInterval(this.lagTimer);
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      const lag = now - lagLast - 50;
      lagLast = now;
      if (lag > 100) this.dbg?.ev("loop-stall", { ms: Math.round(lag) });
    }, 50);
    this.dbg?.ev("owner-join", { connected: this.connection !== null });
    const c = this.connection;
    if (c) this.pingTimer = setInterval(() => this.dbg?.ev("ping", { ws: c.ping.ws ?? null, udp: c.ping.udp ?? null }), 5_000);
    this.opts.log("voice: owner joined; voice mode on");
  }

  /** The owner left: end the session, stop any audio, stay connected. */
  ownerLeft(): void {
    if (!this.ownerHere) return;
    this.ownerHere = false;
    clearInterval(this.pingTimer);
    clearInterval(this.lagTimer);
    this.dbg?.finish("owner-left");
    if (this.dbg) this.opts.log(`voice: debug capture saved -> ${this.dbg.dir}`);
    this.dbg = null;
    this.holdOn = false;
    this.holdAfterSpeech = null;
    this.holdResource = null;
    this.utterance = null;
    this.seg.reset();
    for (const f of this.queue.splice(0)) rmSync(dirname(f), { recursive: true, force: true });
    try {
      this.player.stop(true);
    } catch {}
    this.opts.log("voice: owner left; voice mode off (still connected)");
  }

  /** Bot shutdown. */
  leave(): void {
    clearTimeout(this.rejoinTimer);
    this.channel = null;
    this.ownerLeft();
    this.disconnect();
  }

  private disconnect(): void {
    const connection = this.connection;
    this.connection = null;
    this.receiveStream?.destroy();
    this.receiveStream = null;
    try {
      this.player.stop(true);
      connection?.destroy();
    } catch {}
  }

  /** Subscribe to the owner only. Nobody else's audio is ever collected. */
  private listen(): void {
    const receiver = this.connection?.receiver;
    if (!receiver) return;
    if (!this.timer) {
      receiver.speaking.on("start", (id) => id === this.opts.ownerId && this.dbg?.ev("speaking-start"));
      receiver.speaking.on("end", (id) => id === this.opts.ownerId && this.dbg?.ev("speaking-end"));
      this.timer = setInterval(() => this.poll(), POLL_MS);
    }
    const stream = receiver.subscribe(this.opts.ownerId, { end: { behavior: EndBehaviorType.Manual } });
    stream.on("error", (e) => this.opts.log(`voice receive: ${e.message}`));
    stream.on("data", (packet: Buffer) => this.onPacket(packet));
    // If the receive stream ever ends while still connected, subscribe again instead of going deaf.
    stream.on("close", () => {
      this.dbg?.ev("rx-stream-closed");
      if (this.connection && this.receiveStream === stream) {
        this.opts.log("voice: receive stream closed; resubscribing");
        this.receiveStream = null;
        this.listen();
      }
    });
    this.receiveStream = stream;
  }

  private onPacket(packet: Buffer): void {
    if (!this.ownerHere) return;
    const echo = Date.now() < this.speakingUntil;
    this.dbg?.packet(packet, echo);
    if (echo) {
      // Our own voice can come back through the microphone, so only sustained speech counts.
      const now = Date.now();
      if (!this.pumping || packet.length < 20) return; // silence frames, or only hold music playing
      if (now - this.bargeLast > 120) this.bargePackets = [];
      this.bargeLast = now;
      this.bargePackets.push(packet);
      if (this.bargePackets.length < BARGE_PACKETS) return;
      this.interrupt();
      return;
    }
    if (this.seg.feed(Date.now(), packet.length) === "start") {
      this.utterance = new OggOpusFile();
      this.dbg?.ev("utterance-start");
    }
    if (this.seg.isOpen) this.utterance?.add(packet);
  }

  /** Stop talking now and start recording the owner's words (kept from the start of the barge-in). */
  private interrupt(): void {
    const kept = this.bargePackets;
    this.bargePackets = [];
    this.bargedIn = true;
    this.dbg?.ev("barge-in", { packets: kept.length });
    this.opts.log(`voice: owner interrupted; stopping speech (${this.queue.length} queued dropped)`);
    for (const f of this.queue.splice(0)) rmSync(dirname(f), { recursive: true, force: true });
    this.speakingUntil = 0;
    this.seg.reset();
    this.utterance = new OggOpusFile();
    const t0 = Date.now() - kept.length * 20;
    kept.forEach((pk, i) => {
      this.seg.feed(t0 + i * 20, pk.length);
      this.utterance?.add(pk);
    });
    try {
      this.player.stop(true);
    } catch {}
  }

  private poll(): void {
    const r = this.seg.poll(Date.now());
    if (!r) return;
    const utterance = this.utterance;
    this.utterance = null;
    this.dbg?.ev("utterance-end", { result: r, ms: utterance?.durationMs ?? 0 });
    if (r === "discard" || !utterance?.count) return;
    void this.transcribe(utterance);
  }

  private async transcribe(utterance: OggOpusFile): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "voice-utt-"));
    const file = join(dir, "utterance.ogg");
    try {
      writeFileSync(file, utterance.build());
      const t0 = Date.now();
      const text = await transcribeFile(file);
      this.dbg?.ev("transcribed", { ms: Date.now() - t0, audioMs: utterance.durationMs, chars: text.length });
      this.opts.log(`voice: heard ${utterance.durationMs} ms -> ${text ? `${text.length} chars` : "(nothing)"}`);
      if (!text) return;
      await this.opts.onTranscript(text);
    } catch (e) {
      this.opts.log(`voice transcribe: ${(e as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true }); // no audio is kept
    }
  }

  /** Say something that was not posted as text (the voice-only question prompts). */
  async speak(text: string): Promise<void> {
    if (!this.active) return;
    const file = await synthesize(text);
    if (!file) return;
    try {
      await this.speakFile(file);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  }

  /**
   * Play an existing TTS file (the same .ogg posted as the 🔊 attachment). It is re-encoded into
   * the queue's own temp dir, so the caller can delete the original straight away.
   */
  async speakFile(src: string): Promise<void> {
    if (!this.active) return;
    const ready = await this.toDiscordOpus(src);
    if (!ready) return;
    this.queue.push(ready);
    void this.pump();
  }

  /** Re-encode to what the voice gateway wants: 48 kHz stereo Ogg Opus. */
  private toDiscordOpus(src: string): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "voice-say-"));
    const out = join(dir, "say.ogg");
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const args = ["-loglevel", "error", "-y", "-i", src, "-vn", "-af", "adelay=250:all=1", "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-b:a", "48k", "-frame_duration", "20", out];
    const ff = spawn("ffmpeg", args, { stdio: "ignore" });
    const t = setTimeout(() => ff.kill("SIGKILL"), 60_000);
    const fail = (why: string) => {
      clearTimeout(t);
      rmSync(dir, { recursive: true, force: true });
      this.opts.log(`voice: ffmpeg ${why}`);
      resolve(null);
    };
    ff.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out) : fail(`failed (${code})`);
    });
    ff.on("error", (e) => fail(e.message));
    return promise;
  }

  // Hold music (owner request 2026-10-13): after "One moment." lo-fi fades in from a random point
  // of a pre-encoded clip, and fades out (1.5 s tail rendered from the same position) before the
  // answer is spoken. Separate from pump(): no echo lock, and the cached clips are never deleted.
  private holdOn = false;
  private holdAfterSpeech: string[] | null = null;
  private holdTrack = "";
  private holdOffset = 0;
  private holdResource: ReturnType<typeof createAudioResource> | null = null;

  /** ffmpeg → Ogg Opus stream of `track` from `offset` s, optional length and fade filter. */
  private clip(track: string, offset: number, filter: string, seconds?: number) {
    const args = ["-loglevel", "error", "-ss", offset.toFixed(2), ...(seconds ? ["-t", String(seconds)] : []), "-i", track,
      "-af", filter, "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-b:a", "64k", "-frame_duration", "20", "-f", "ogg", "pipe:1"];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    return createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
  }

  /** Start hold music (preferred clip first, random point, 2 s fade-in) until stopHold() or speech. */
  startHold(tracks: string[]): void {
    if (!this.connection || !tracks.length || this.holdOn) return;
    // Still saying "One moment.": start right after it finishes (see pump()).
    if (this.pumping) {
      this.holdAfterSpeech = tracks;
      return;
    }
    this.holdOn = true;
    // Preferred clip first: a file name containing $OMP_HOLD_MUSIC_FIRST (e.g. a video id); others shuffled.
    const want = process.env.OMP_HOLD_MUSIC_FIRST;
    const fav = want ? tracks.filter((t) => t.includes(want)) : [];
    const rest = tracks.filter((t) => !fav.includes(t)).sort(() => Math.random() - 0.5);
    this.holdList = [...fav, ...rest];
    this.holdIndex = 0;
    this.holdTrack = this.holdList[0]!;
    const room = Math.max(0, this.duration(this.holdTrack) - 120); // leave at least 2 min to play
    this.holdOffset = Math.floor(Math.random() * room);
    this.playHold("afade=t=in:d=2");
  }

  private holdList: string[] = [];
  private holdIndex = 0;
  private durations = new Map<string, number>();

  private duration(track: string): number {
    let d = this.durations.get(track);
    if (d === undefined) {
      const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", track], { encoding: "utf8" });
      d = Number.parseFloat(r.stdout) || 600;
      this.durations.set(track, d);
    }
    return d;
  }

  private playHold(filter: string): void {
    this.holdResource = this.clip(this.holdTrack, this.holdOffset, filter);
    this.dbg?.ev("hold-start", { track: this.holdTrack.split("/").pop(), offset: this.holdOffset });
    this.player.play(this.holdResource);
  }

  /** The current hold clip ended: play the next track in the list from its start (loops forever). */
  private nextHold(): void {
    if (!this.connection || !this.holdList.length) return;
    this.holdIndex = (this.holdIndex + 1) % this.holdList.length;
    this.holdTrack = this.holdList[this.holdIndex]!;
    this.holdOffset = 0;
    this.opts.log(`voice: hold music continues with ${this.holdTrack.split("/").pop()}`);
    this.playHold("anull");
  }

  /** Fade the hold music out (1.5 s) and wait until it is silent. Safe to call when not playing. */
  async stopHold(): Promise<void> {
    this.holdAfterSpeech = null;
    if (!this.holdOn) return;
    this.holdOn = false;
    const pos = this.holdOffset + (this.holdResource?.playbackDuration ?? 0) / 1000;
    this.dbg?.ev("hold-stop", { playedMs: this.holdResource?.playbackDuration ?? 0 });
    this.holdResource = null;
    if (!this.connection) return;
    try {
      this.player.play(this.clip(this.holdTrack, pos, "afade=t=out:d=1.5", 1.5));
      await entersState(this.player, AudioPlayerStatus.Playing, 5_000);
      await entersState(this.player, AudioPlayerStatus.Idle, 10_000);
    } catch {
      this.player.stop(true);
    }
  }

  /** One utterance at a time; they never overlap. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    // Speech wins: fade any hold music out before the first utterance.
    await this.stopHold();
    try {
      while (this.queue.length && this.active) {
        const file = this.queue.shift()!;
        this.speakingUntil = Number.MAX_SAFE_INTEGER; // reset below, once we stop talking
        const startedAt = Date.now();
        try {
          this.dbg?.clip(file, "speech");
          this.player.play(createAudioResource(createReadStream(file), { inputType: StreamType.OggOpus }));
          await entersState(this.player, AudioPlayerStatus.Playing, 10_000);
          this.dbg?.ev("speech-playing", { msToStart: Date.now() - startedAt });
          await entersState(this.player, AudioPlayerStatus.Idle, 10 * 60_000);
          this.dbg?.ev("speech-done", { ms: Date.now() - startedAt });
          this.opts.log(`voice: said ${Date.now() - startedAt} ms (${this.queue.length} waiting)`);
        } catch (e) {
          this.opts.log(`voice play: ${(e as Error).message}`);
        } finally {
          rmSync(dirname(file), { recursive: true, force: true });
          if (this.bargedIn) {
            this.bargedIn = false; // keep the owner's words that are being recorded
          } else {
            this.speakingUntil = Date.now() + ECHO_TAIL_MS;
            this.seg.reset();
            this.utterance = null;
          }
        }
      }
    } finally {
      this.pumping = false;
    }
    const pending = this.holdAfterSpeech;
    this.holdAfterSpeech = null;
    if (pending) this.startHold(pending);
  }
}
