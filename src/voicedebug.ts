// Voice-call debug capture (owner request 2026-10-14). On while ~/.config/omp-discord/voice-debug
// exists. Per call it writes to ~/.local/state/omp-discord-bot/voice-debug/<start>/:
//   events.jsonl  timestamped events (connection/player/receiver states, ping, packets per second,
//                 utterances, transcription, jobs, hold music, every clip the bot plays)
//   owner.ogg     the owner's microphone for the whole call, silence gaps kept so it lines up
//   bot-NNN.ogg   each clip the bot played (start offset in events.jsonl)
//   mix.ogg       owner + bot mixed on one timeline (made when the call ends)
//   summary.json  counts and timings
// Stays on the rig. The 5 newest calls are kept; older ones are deleted.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OggOpusFile } from "./ogg.ts";

const HOME = homedir();
export const VOICE_DEBUG_FLAG = join(HOME, ".config", "omp-discord", "voice-debug");
const ROOT = join(HOME, ".local", "state", "omp-discord-bot", "voice-debug");
const KEEP = 5;
const FRAME_MS = 20;
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]); // one 20 ms Opus silence frame
const MAX_GAP_FRAMES = 30 * 60 * 50; // never pad more than 30 min

export class VoiceDebug {
  readonly dir: string;
  private readonly t0 = Date.now();
  private readonly owner = new OggOpusFile();
  private lastPacketAt = 0;
  private packets = 0;
  private bytes = 0;
  private secPackets = 0;
  private echoDropped = 0;
  private clips: { file: string; at: number }[] = [];
  private readonly counts: Record<string, number> = {};
  private readonly tick: NodeJS.Timeout;

  private constructor() {
    this.dir = join(ROOT, new Date(this.t0).toISOString().replace(/[:.]/g, "-"));
    mkdirSync(this.dir, { recursive: true });
    this.tick = setInterval(() => {
      if (this.secPackets) this.ev("rx", { packetsPerSec: this.secPackets });
      this.secPackets = 0;
    }, 1000);
  }

  /** A recorder when the debug flag is on, else null. */
  static start(): VoiceDebug | null {
    if (!existsSync(VOICE_DEBUG_FLAG)) return null;
    try {
      const old = existsSync(ROOT) ? readdirSync(ROOT).sort() : [];
      for (const d of old.slice(0, Math.max(0, old.length - (KEEP - 1)))) rmSync(join(ROOT, d), { recursive: true, force: true });
    } catch {}
    return new VoiceDebug();
  }

  ev(type: string, data: Record<string, unknown> = {}): void {
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    try {
      appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify({ t: Date.now() - this.t0, at: new Date().toISOString(), type, ...data })}\n`);
    } catch {}
  }

  /** Every owner packet, including ones the echo filter drops. Gaps are filled with silence. */
  packet(p: Buffer, droppedAsEcho: boolean): void {
    const now = Date.now();
    if (!this.lastPacketAt) {
      this.ev("rx-first", { msAfterJoin: now - this.t0 });
      const lead = Math.min(Math.floor((now - this.t0) / FRAME_MS), MAX_GAP_FRAMES);
      for (let i = 0; i < lead; i++) this.owner.add(SILENCE);
    } else {
      const gap = Math.min(Math.floor((now - this.lastPacketAt) / FRAME_MS) - 1, MAX_GAP_FRAMES);
      if (gap > 0) {
        if (gap >= 25) this.ev("rx-gap", { ms: gap * FRAME_MS });
        for (let i = 0; i < gap; i++) this.owner.add(SILENCE);
      }
    }
    this.lastPacketAt = now;
    this.owner.add(p);
    this.packets++;
    this.secPackets++;
    this.bytes += p.length;
    if (droppedAsEcho) this.echoDropped++;
  }

  /** Copy a clip the bot is about to play. */
  clip(src: string, label: string): void {
    const n = String(this.clips.length + 1).padStart(3, "0");
    const file = join(this.dir, `bot-${n}.ogg`);
    try {
      copyFileSync(src, file);
      this.clips.push({ file, at: Date.now() - this.t0 });
      this.ev("bot-clip", { file: `bot-${n}.ogg`, label });
    } catch {}
  }

  finish(reason: string): void {
    clearInterval(this.tick);
    this.ev("end", { reason });
    const ownerFile = join(this.dir, "owner.ogg");
    try {
      if (this.owner.count) writeFileSync(ownerFile, this.owner.build());
    } catch {}
    // One listenable timeline: owner track plus every bot clip at its start offset.
    try {
      const inputs: string[] = [];
      const filters: string[] = [];
      if (this.owner.count) inputs.push("-i", ownerFile);
      for (const c of this.clips) inputs.push("-i", c.file);
      const nOwner = this.owner.count ? 1 : 0;
      this.clips.forEach((c, i) => filters.push(`[${i + nOwner}:a]adelay=${c.at}:all=1[b${i}]`));
      const mixIn = [...(nOwner ? ["[0:a]"] : []), ...this.clips.map((_, i) => `[b${i}]`)];
      if (mixIn.length) {
        filters.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0[m]`);
        spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[m]", "-c:a", "libopus", "-b:a", "64k", join(this.dir, "mix.ogg")], { timeout: 120_000 });
      }
    } catch {}
    try {
      writeFileSync(
        join(this.dir, "summary.json"),
        JSON.stringify({ durationMs: Date.now() - this.t0, ownerPackets: this.packets, ownerBytes: this.bytes, echoDropped: this.echoDropped, botClips: this.clips.length, events: this.counts, reason }, null, 2),
      );
    } catch {}
  }
}
