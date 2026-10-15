// Voice messages → text (owner request 2026-10-13): transcribed locally with faster-whisper
// (scripts/transcribe.py), shown in the thread, and used as the owner's typed message.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const REPO = join(import.meta.dir, "..");

export function isVoice(a: { name: string; contentType?: string | null }): boolean {
  return /^audio\//.test(a.contentType ?? "") || /\.(ogg|oga|opus|m4a|mp3|wav)$/i.test(a.name);
}

/** Download a Discord CDN audio file and transcribe it. Returns "" when nothing was heard. */
export async function transcribe(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(u.hostname)) throw new Error("not a Discord CDN URL");
  const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const file = join(dir, "voice");
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  try {
    return await transcribeFile(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Transcribe a local audio file (anything ffmpeg reads). The caller owns the file and must delete
 * it: no audio is kept after this returns. Returns "" when nothing was heard.
 */
export async function transcribeFile(file: string): Promise<string> {
  // Warm server (scripts/whisper_server.py, model kept loaded); one-shot script if it is down.
  const warm = await viaServer(file).catch(() => null);
  if (warm !== null) return warm;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("uv", ["run", "--quiet", join(REPO, "scripts", "transcribe.py"), file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out.trim()) : reject(new Error(`transcription failed: ${err.trim().split("\n").pop() ?? code}`));
    });
  });
}

const SOCK = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "omp-whisper.sock");

function viaServer(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK);
    let buf = "";
    sock.setTimeout(120_000, () => sock.destroy(new Error("timeout")));
    sock.on("connect", () => sock.write(`${file}\n`));
    sock.on("data", (d) => (buf += d));
    sock.on("error", reject);
    sock.on("close", () => {
      try {
        const r: { text?: string; error?: string } = JSON.parse(buf);
        r.error === undefined && typeof r.text === "string" ? resolve(r.text) : reject(new Error(r.error ?? "bad reply"));
      } catch (e) {
        reject(e);
      }
    });
  });
}
