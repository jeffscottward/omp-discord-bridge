// Ogg Opus container for the Opus packets Discord sends us (owner request 2026-10-13: voice mode).
// @discordjs/voice hands over bare Opus packets; ffmpeg (and therefore Whisper) needs them in a
// container. prism-media 1.3.5 can demux Ogg but not mux it, and its 2.x muxer is still alpha, so
// the pages are written here. Utterances are short, so the file is built in memory.
//
// Format: RFC 3533 (Ogg pages) and RFC 7845 (Opus in Ogg).

/** CRC-32/MPEG-2 style checksum used by Ogg: poly 0x04c11db7, no reflection, no final xor. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x8000_0000 ? (r << 1) ^ 0x04c1_1db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(page: Buffer): number {
  let c = 0;
  for (const b of page) c = (((c << 8) >>> 0) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]!) >>> 0;
  return c >>> 0;
}

/** Lacing bytes for one packet: 255s then the remainder (a trailing 0 when it divides exactly). */
function lacing(length: number): number[] {
  const out: number[] = [];
  let left = length;
  while (left >= 255) {
    out.push(255);
    left -= 255;
  }
  out.push(left);
  return out;
}

const HEADER_BOS = 0x02;
const HEADER_EOS = 0x04;
/** Discord always sends 20 ms frames: 960 samples at 48 kHz. */
export const SAMPLES_PER_PACKET = 960;

export interface OggOpusOptions {
  /** Channels declared in OpusHead. Discord's clients send stereo. */
  channels?: number;
  sampleRate?: number;
  /** Stream serial number; random by default. */
  serial?: number;
}

/** Collects Opus packets and writes them out as one Ogg Opus stream. */
export class OggOpusFile {
  private readonly packets: Buffer[] = [];
  private readonly channels: number;
  private readonly sampleRate: number;
  private readonly serial: number;

  constructor(o: OggOpusOptions = {}) {
    this.channels = o.channels ?? 2;
    this.sampleRate = o.sampleRate ?? 48_000;
    this.serial = (o.serial ?? Math.floor(Math.random() * 0xffff_ffff)) >>> 0;
  }

  get count(): number {
    return this.packets.length;
  }

  /** Audio length in milliseconds, assuming Discord's 20 ms frames. */
  get durationMs(): number {
    return Math.round((this.packets.length * SAMPLES_PER_PACKET * 1000) / this.sampleRate);
  }

  add(packet: Buffer): void {
    if (packet.length) this.packets.push(packet);
  }

  private page(type: number, granule: number, seq: number, segments: number[], body: Buffer): Buffer {
    const head = Buffer.alloc(27 + segments.length);
    head.write("OggS", 0, "ascii");
    head[4] = 0; // stream structure version
    head[5] = type;
    head.writeBigInt64LE(BigInt(granule), 6);
    head.writeUInt32LE(this.serial, 14);
    head.writeUInt32LE(seq >>> 0, 18);
    head.writeUInt32LE(0, 22); // checksum placeholder
    head[26] = segments.length;
    for (const [i, s] of segments.entries()) head[27 + i] = s;
    const page = Buffer.concat([head, body]);
    page.writeUInt32LE(oggCrc(page), 22);
    return page;
  }

  /** The complete .ogg file. Empty when no packets were collected. */
  build(): Buffer {
    if (!this.packets.length) return Buffer.alloc(0);
    const idHeader = Buffer.alloc(19);
    idHeader.write("OpusHead", 0, "ascii");
    idHeader[8] = 1; // version
    idHeader[9] = this.channels;
    idHeader.writeUInt16LE(0, 10); // pre-skip: our packets start at the real beginning
    idHeader.writeUInt32LE(this.sampleRate, 12);
    idHeader.writeInt16LE(0, 16); // output gain
    idHeader[18] = 0; // channel mapping family

    const vendor = Buffer.from("omp-discord-bot", "utf8");
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write("OpusTags", 0, "ascii");
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length); // no user comments

    const pages: Buffer[] = [
      this.page(HEADER_BOS, 0, 0, lacing(idHeader.length), idHeader),
      this.page(0, 0, 1, lacing(tags.length), tags),
    ];
    let seq = 2;
    let granule = 0;
    let i = 0;
    while (i < this.packets.length) {
      const segments: number[] = [];
      const body: Buffer[] = [];
      while (i < this.packets.length) {
        const l = lacing(this.packets[i]!.length);
        if (segments.length + l.length > 255) break;
        segments.push(...l);
        body.push(this.packets[i]!);
        granule += SAMPLES_PER_PACKET;
        i++;
      }
      const last = i >= this.packets.length;
      pages.push(this.page(last ? HEADER_EOS : 0, granule, seq++, segments, Buffer.concat(body)));
    }
    return Buffer.concat(pages);
  }
}
