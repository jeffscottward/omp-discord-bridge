// Cutting a continuous Opus packet stream into utterances (owner request 2026-10-13: voice mode).
// Discord sends one Opus packet every 20 ms while a user transmits. With voice activity detection
// the client simply stops sending during silence; with "always transmit" it keeps sending, but the
// encoder produces tiny comfort-noise frames. Both cases are handled: a packet counts as speech
// only when it is larger than `silentPacketBytes`, and an utterance ends after `silenceMs` without
// a speech packet.

/** Opus frames at or below this size carry no speech (silence frame = 3 bytes). */
export const SILENT_PACKET_BYTES = 12;

export interface SegmentOptions {
  /** Silence that ends an utterance. */
  silenceMs?: number;
  /** Utterances with less speech than this are dropped (a cough, a key click). */
  minVoicedMs?: number;
  /** Hard cap, so one long monologue still gets transcribed. */
  maxMs?: number;
  silentPacketBytes?: number;
  /** Audio per Opus packet. Discord sends 20 ms frames. */
  frameMs?: number;
}

export class UtteranceSegmenter {
  readonly silenceMs: number;
  readonly minVoicedMs: number;
  readonly maxMs: number;
  readonly silentPacketBytes: number;
  readonly frameMs: number;
  private open = false;
  private startedAt = 0;
  private lastVoiceAt = 0;
  private voicedPackets = 0;

  constructor(o: SegmentOptions = {}) {
    this.silenceMs = o.silenceMs ?? 1000;
    this.minVoicedMs = o.minVoicedMs ?? 120;
    this.maxMs = o.maxMs ?? 60_000;
    this.silentPacketBytes = o.silentPacketBytes ?? SILENT_PACKET_BYTES;
    this.frameMs = o.frameMs ?? 20;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Speech collected so far, counted per packet rather than from the first to the last timestamp.
   * The span would undercount by one frame and report 0 ms for a single packet, which threw away
   * one-word answers such as "two".
   */
  get voicedMs(): number {
    return this.voicedPackets * this.frameMs;
  }

  /**
   * One Opus packet arrived. Returns "start" when it opened a new utterance, so the caller can
   * open a file. Silence packets are only kept while an utterance is already open.
   */
  feed(now: number, bytes: number): "start" | null {
    if (bytes <= this.silentPacketBytes) return null;
    this.lastVoiceAt = now;
    this.voicedPackets++;
    if (this.open) return null;
    this.open = true;
    this.startedAt = now;
    return "start";
  }

  /**
   * Call on a timer. "end" = transcribe it, "discard" = too short to be speech, null = keep going.
   */
  poll(now: number): "end" | "discard" | null {
    if (!this.open) return null;
    const silent = now - this.lastVoiceAt >= this.silenceMs;
    const tooLong = now - this.startedAt >= this.maxMs;
    if (!silent && !tooLong) return null;
    const voiced = this.voicedMs;
    this.reset();
    return voiced >= this.minVoicedMs ? "end" : "discard";
  }

  reset(): void {
    this.open = false;
    this.startedAt = 0;
    this.lastVoiceAt = 0;
    this.voicedPackets = 0;
  }
}
