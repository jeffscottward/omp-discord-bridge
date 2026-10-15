import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import prism from "prism-media";
import { OggOpusFile } from "../src/ogg.ts";
import { SILENT_PACKET_BYTES, UtteranceSegmenter } from "../src/segment.ts";
import { synthesize } from "../src/speech.ts";
import { parseSpokenNumbers, spokenIntent } from "../src/spoken.ts";
import { transcribeFile } from "../src/voice.ts";

const speech = Buffer.alloc(80, 1); // a real 20 ms Opus frame is far bigger than a silence frame
const silence = Buffer.alloc(3, 1);

describe("utterance segmentation", () => {
  test("silence before speech does not open an utterance", () => {
    const s = new UtteranceSegmenter();
    expect(s.feed(1000, silence.length)).toBeNull();
    expect(s.isOpen).toBe(false);
    expect(s.poll(5000)).toBeNull();
  });

  test("speech opens once, then 1 s of silence ends the utterance", () => {
    const s = new UtteranceSegmenter({ silenceMs: 1000, minVoicedMs: 240 });
    expect(s.feed(0, speech.length)).toBe("start");
    for (let t = 20; t <= 600; t += 20) expect(s.feed(t, speech.length)).toBeNull();
    expect(s.voicedMs).toBe(620); // 31 packets of 20 ms
    expect(s.poll(1200)).toBeNull(); // only 600 ms since the last speech packet
    expect(s.poll(1599)).toBeNull();
    expect(s.poll(1600)).toBe("end");
    expect(s.isOpen).toBe(false);
  });

  test("silence packets inside an utterance do not extend it", () => {
    const s = new UtteranceSegmenter({ silenceMs: 1000, minVoicedMs: 240 });
    for (let t = 0; t <= 300; t += 20) s.feed(t, speech.length);
    for (let t = 320; t <= 1400; t += 20) s.feed(t, SILENT_PACKET_BYTES); // "always transmit" clients
    expect(s.poll(1300)).toBe("end"); // 1 s after the last real speech packet
  });

  test("a one-word answer is kept, a single stray packet is not", () => {
    const short = new UtteranceSegmenter(); // defaults, as voice mode runs it
    for (let t = 0; t < 300; t += 20) short.feed(t, speech.length); // "two", 15 packets
    expect(short.voicedMs).toBe(300);
    expect(short.poll(1300)).toBe("end");

    const stray = new UtteranceSegmenter();
    stray.feed(0, speech.length);
    expect(stray.voicedMs).toBe(20); // one frame, not 0 ms
    expect(stray.poll(1001)).toBe("discard");
  });

  test("a click or a cough is discarded", () => {
    const s = new UtteranceSegmenter({ silenceMs: 1000, minVoicedMs: 240 });
    s.feed(0, speech.length);
    s.feed(100, speech.length);
    expect(s.poll(1101)).toBe("discard");
  });

  test("a long monologue is cut at the maximum length", () => {
    const s = new UtteranceSegmenter({ silenceMs: 1000, maxMs: 5000 });
    s.feed(0, speech.length);
    for (let t = 20; t <= 4980; t += 20) s.feed(t, speech.length);
    expect(s.poll(5000)).toBe("end");
    expect(s.isOpen).toBe(false);
    expect(s.feed(5020, speech.length)).toBe("start"); // the next one starts cleanly
  });

  test("reset drops the utterance in progress", () => {
    const s = new UtteranceSegmenter();
    s.feed(0, speech.length);
    s.reset();
    expect(s.isOpen).toBe(false);
    expect(s.poll(10_000)).toBeNull();
  });
});

describe("spoken numbers", () => {
  test("numbers, words and ordinals", () => {
    expect(parseSpokenNumbers("one")).toEqual([1]);
    expect(parseSpokenNumbers("Two and three.")).toEqual([2, 3]);
    expect(parseSpokenNumbers("number 4 please")).toEqual([4]);
    expect(parseSpokenNumbers("first")).toEqual([1]);
    expect(parseSpokenNumbers("1, 2 and 5")).toEqual([1, 2, 5]);
    expect(parseSpokenNumbers("option two")).toEqual([2]);
    expect(parseSpokenNumbers("two, two")).toEqual([2]); // said twice, picked once
  });

  test("anything else is a free-text reply", () => {
    expect(parseSpokenNumbers("post them")).toBeNull();
    expect(parseSpokenNumbers("use the second approach but keep the tests")).toBeNull();
    expect(parseSpokenNumbers("")).toBeNull();
    expect(parseSpokenNumbers("...")).toBeNull();
    expect(parseSpokenNumbers("okay")).toBeNull(); // filler only, no number
    expect(parseSpokenNumbers("99")).toBeNull(); // out of range
  });

  test("read out or post", () => {
    expect(spokenIntent("read them out")).toBe("read");
    expect(spokenIntent("Post them.")).toBe("post");
    expect(spokenIntent("say them out loud")).toBe("read");
    expect(spokenIntent("just do whatever you think")).toBeNull();
  });
});

describe("Ogg Opus container", () => {
  const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

  test("pages carry OpusHead, OpusTags and an end-of-stream flag", () => {
    const f = new OggOpusFile({ serial: 7 });
    for (let i = 0; i < 3; i++) f.add(speech);
    const buf = f.build();
    expect(buf.subarray(0, 4).toString()).toBe("OggS");
    expect(buf[5]).toBe(0x02); // beginning of stream
    expect(buf.includes(Buffer.from("OpusHead"))).toBe(true);
    expect(buf.includes(Buffer.from("OpusTags"))).toBe(true);
    expect(f.durationMs).toBe(60);
    // The last page is the end of the stream.
    const last = buf.lastIndexOf(Buffer.from("OggS"));
    expect(buf[last + 5]).toBe(0x04);
  });

  test("no packets means no file", () => {
    expect(new OggOpusFile().build().length).toBe(0);
  });

  test.skipIf(!ffmpeg)("ffmpeg decodes a stream we built from real Opus packets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ogg-test-"));
    try {
      const src = join(dir, "src.ogg");
      const out = join(dir, "out.ogg");
      const make = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-frame_duration", "20", src]);
      expect(make.status).toBe(0);
      const demuxer = new prism.opus.OggDemuxer();
      const packets: Buffer[] = [];
      demuxer.on("data", (p: Buffer) => packets.push(p));
      demuxer.end(readFileSync(src));
      await new Promise((r) => demuxer.on("end", r));
      expect(packets.length).toBeGreaterThan(90);

      const f = new OggOpusFile({ serial: 1 });
      for (const p of packets) f.add(p);
      writeFileSync(out, f.build());
      const pcm = spawnSync("ffmpeg", ["-loglevel", "error", "-i", out, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], { maxBuffer: 1e8 });
      expect(pcm.stderr.toString()).toBe("");
      expect(pcm.status).toBe(0);
      expect(pcm.stdout.length / 2 / 16000).toBeCloseTo(2, 1); // ~2 seconds of audio back
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The receive half without needing a person to talk: real speech is synthesized, split into the
 * Opus packets Discord would deliver, put back together by our muxer and transcribed by the same
 * local Whisper server voice mode uses. Skipped when the two GPU services are not running.
 */
describe("voice input pipeline", () => {
  const live = existsSync(join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "omp-tts.sock")) && existsSync(join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "omp-whisper.sock"));

  test.skipIf(!live)("spoken words survive packets → Ogg → Whisper", async () => {
    const said = "Please restart the weather dashboard and show me the open issues.";
    const tts = await synthesize(said);
    expect(tts).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "voice-pipe-"));
    try {
      // What @discordjs/voice hands us: one Opus packet per 20 ms frame.
      const demuxer = new prism.opus.OggDemuxer();
      const utterance = new OggOpusFile();
      demuxer.on("data", (p: Buffer) => utterance.add(p));
      demuxer.end(readFileSync(tts!));
      await new Promise((r) => demuxer.on("end", r));
      expect(utterance.count).toBeGreaterThan(50);

      const file = join(dir, "utterance.ogg");
      writeFileSync(file, utterance.build());
      const heard = await transcribeFile(file);
      expect(heard.toLowerCase()).toContain("weather dashboard");
      expect(heard.toLowerCase()).toContain("open issues");
    } finally {
      rmSync(dirname(tts!), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
