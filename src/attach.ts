// Trusted mode: an answer line `📎 attach: <path>` uploads that file with the answer.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { isSecretName } from "./sandbox.ts";
import { MAX_ATTACH_BYTES } from "./config.ts";

const LINE = /^[ \t]*📎[ \t]*attach:[ \t]*`?([^`\n]+?)`?[ \t]*$\n?/gm;
const MAX_FILES = 10;

/** Roots an answer may attach from (resolved with realpath; symlinks may not lead out). */
export function attachRoots(home = homedir()): string[] {
  return ["Github", "discord-scratch", "Downloads", "Pictures", "Videos", "Music", "Documents", "Games", ".local/share/omp-discord-bot/scratch"]
    .map((d) => join(home, d))
    .concat("/tmp");
}
/** Path parts that never attach, wherever they are. */
const DENY_PART = /^(\.ssh|\.gnupg|\.password-store|\.aws|\.kube|\.docker|\.omp|\.config|1Password|keyrings|\.git)$/;
const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);

/** Why a resolved path may not be attached (null: allowed). */
export function attachDenied(p: string, home = homedir(), allowed = attachRoots(home)): string | null {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return "file not found";
  }
  const roots = allowed.map((r) => { try { return realpathSync(r); } catch { return r; } });
  if (!roots.some((r) => inside(real, r))) return "outside the allowed folders (~/Github, ~/discord-scratch, ~/Downloads, ~/Pictures, ~/Videos, ~/Music, ~/Documents, ~/Games, /tmp)";
  const parts = real.split(sep).filter(Boolean);
  if (parts.some((x) => DENY_PART.test(x))) return "inside a protected folder";
  if (parts.some((x) => isSecretName(x))) return "looks like a secret file";
  try {
    if (lstatSync(p).isSymbolicLink() && real !== p) return "symlink";
  } catch {}
  return null;
}

export interface Extracted {
  text: string;
  files: { path: string; name: string }[];
  notes: string[];
}

export function extractAttachments(text: string, home = homedir(), limit = MAX_ATTACH_BYTES): Extracted {
  const files: Extracted["files"] = [];
  const notes: string[] = [];
  const rest = text.replace(LINE, (_m, raw: string) => {
    const p = raw.trim().replace(/^~(?=\/)/, home);
    const name = basename(p);
    if (!isAbsolute(p)) notes.push(`⚠️ Not attached: \`${raw.trim()}\` (needs an absolute or ~/ path).`);
    else if (files.length >= MAX_FILES) notes.push(`⚠️ Not attached: \`${name}\` (max ${MAX_FILES} files).`);
    else {
      const denied = attachDenied(p, home);
      if (denied) notes.push(`⚠️ Not attached: \`${name}\` (${denied}).`);
      else try {
        const st = statSync(p);
        if (!st.isFile()) notes.push(`⚠️ Not attached: \`${name}\` (not a regular file).`);
        else if (st.size > limit)
          notes.push(`⚠️ Not attached: \`${name}\` is ${(st.size / 1048576).toFixed(1)} MB, over Discord's ${Math.round(limit / 1048576)} MB limit.`);
        else files.push({ path: p, name });
      } catch {
        notes.push(`⚠️ Not attached: \`${name}\` (file not found).`);
      }
    }
    return "";
  });
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), files, notes };
}

