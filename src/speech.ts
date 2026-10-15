// Every final answer gets a spoken copy (owner request 2026-10-13), from the local Kokoro server
// (scripts/tts_server.py, omp-tts.service). Markdown is turned into plain speakable text first.
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCK = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "omp-tts.sock");

/** Markdown answer → text to read aloud: no code blocks, links read as their label, no symbols. */
/**
 * Spoken-English pass for TTS only (owner request 2026-10-14): symbols and abbreviations are read
 * the way a person says them. The posted Discord text is never changed.
 */
export function spokenForm(t: string): string {
  const unit: [RegExp, string][] = [
    [/(-?\d+(?:\.\d+)?)\s*°\s*F\b/g, "$1 degrees Fahrenheit"],
    [/(-?\d+(?:\.\d+)?)\s*°\s*C\b/g, "$1 degrees Celsius"],
    [/(-?\d+(?:\.\d+)?)\s*°/g, "$1 degrees"],
    [/(\d)\s*%/g, "$1 percent"],
    [/(\d+(?:\.\d+)?)\s*mph\b/gi, "$1 miles per hour"],
    [/(\d+(?:\.\d+)?)\s*km\/h\b/gi, "$1 kilometers per hour"],
    [/(\d+(?:\.\d+)?)\s*ms\b/g, "$1 milliseconds"],
    [/(\d+(?:\.\d+)?)\s*s\b/g, "$1 seconds"],
    [/(\d+(?:\.\d+)?)\s*min\b/g, "$1 minutes"],
    [/(\d+(?:\.\d+)?)\s*GB\b/g, "$1 gigabytes"],
    [/(\d+(?:\.\d+)?)\s*MB\b/g, "$1 megabytes"],
    [/\$(\d[\d,]*(?:\.\d+)?)\s*k\b/gi, "$1 thousand dollars"],
    [/\$(\d[\d,]*(?:\.\d+)?)\s*M\b/g, "$1 million dollars"],
    [/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars"],
    [/(\d+(?:\.\d+)?)\s*[x×]\b/g, "$1 times"],
  ];
  const word: [RegExp, string][] = [
    [/(\d)\s*[-–—]\s*(\d)/g, "$1 to $2"],
    [/\s*[→⇒➜]\s*/g, " to "],
    [/\s*[–—]\s*/g, ", "],
    [/~\s*(?=\d)/g, "about "],
    [/≈\s*/g, "about "],
    [/\s+&\s+/g, " and "],
    [/\be\.g\./gi, "for example"],
    [/\bi\.e\./gi, "that is"],
    [/\betc\./gi, "and so on"],
    [/\bvs\.?(?=\s)/gi, "versus"],
    [/\bET\b/g, "Eastern time"],
    [/\bAM\b/g, "A M"],
    [/\bPM\b/g, "P M"],
    [/\bNYC\b/g, "New York City"],
    [/\bOMP\b/g, "O M P"],
    [/\s\/\s/g, " or "],
    ...Object.entries({ N: "north", S: "south", E: "east", W: "west", NE: "northeast", NW: "northwest", SE: "southeast", SW: "southwest", NNE: "north-northeast", ENE: "east-northeast", ESE: "east-southeast", SSE: "south-southeast", SSW: "south-southwest", WSW: "west-southwest", WNW: "west-northwest", NNW: "north-northwest" })
      .map(([k, v]): [RegExp, string] => [new RegExp(`(?<=\\b(?:mph|hour|wind|from)\\s+)${k}\\b`, "gi"), v]),
  ];
  for (const [r, w] of [...unit, ...word]) t = t.replace(r, w);
  return t;
}

export function speakable(md: string): string {
  return spokenForm(md)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*📎 attach:.*$/gm, "")
    .replace(/\[([^\]]+)\]\(<?[^)>]+>?\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*\|.*$/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\n{2,}/g, ".\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\.{2,}/g, ".")
    .trim();
}

/** Synthesize to an .ogg file; null when the server is down or the text is empty. */
export function synthesize(text: string): Promise<string | null> {
  const say = speakable(text);
  if (!say) return Promise.resolve(null);
  const out = join(mkdtempSync(join(tmpdir(), "tts-")), "reply.ogg");
  const { promise, resolve } = Promise.withResolvers<string | null>();
  {
    const sock = connect(SOCK);
    let buf = "";
    sock.setTimeout(90_000, () => sock.destroy());
    sock.on("connect", () => sock.write(`${JSON.stringify({ text: say, out })}\n`));
    sock.on("data", (d) => (buf += d));
    sock.on("error", () => resolve(null));
    sock.on("close", () => {
      try {
        const r: { ok?: boolean } = JSON.parse(buf);
        resolve(r.ok ? out : null);
      } catch {
        resolve(null);
      }
    });
  }
  return promise;
}
