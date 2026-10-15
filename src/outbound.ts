import { splitPasteBlocks } from "./blocks.ts";
import { ATTACH_THRESHOLD } from "./config.ts";
import { redact } from "./redact.ts";
import { redactKnownSecrets } from "./secrets.ts";
import { splitMessage } from "./split.ts";
import { shortenLinks } from "./links.ts";
import { tablesToCode } from "./tables.ts";

export const DISCORD_MAX = 2000;

export interface OutMsg {
  /** Message text (≤ 2000 chars). */
  content: string;
  /** Attached file (long answers: answer.md; long paste blocks: paste-N.txt). */
  file?: { name: string; data: string };
  /** A paste block: content is only the fenced block (or the block is the attached .txt). */
  paste?: boolean;
}

export interface Outbound {
  /** Messages to send in order. */
  messages: OutMsg[];
  hits: Record<string, number>;
}

/** Prose only: split; very long prose becomes one preview message plus a .md attachment. */
function proseMessages(raw: string): OutMsg[] {
  const text = shortenLinks(raw);
  if (text.length <= ATTACH_THRESHOLD) return splitMessage(text).map((content) => ({ content }));
  const preview = splitMessage(text, 1800)[0] ?? "";
  return [{ content: `${preview}\n\n*(${text.length.toLocaleString()} chars — full answer attached)*`, file: { name: "answer.md", data: text } }];
}

/**
 * Redact (patterns + known secret values), then split. Paste blocks (see src/blocks.ts) become
 * their own messages containing only the fenced block; a block too long for one message is
 * attached as a .txt instead. The prose around them stays in normal messages.
 */
export function prepareOutbound(text: string): Outbound {
  const r = redact(tablesToCode(text.trim()) || "(empty answer)");
  const known = redactKnownSecrets(r.text);
  const safe = known.text;
  const hits = known.hits ? { ...r.hits, "known-secret": known.hits } : r.hits;
  const segments = splitPasteBlocks(safe);
  if (!segments.some((s) => s.kind === "block")) return { messages: proseMessages(safe), hits };

  const proseTotal = segments.reduce((n, s) => n + (s.kind === "prose" ? s.text.length : 0), 0);
  const messages: OutMsg[] = [];
  let n = 0;
  const pushBlock = (s: { body: string; fenced: string }) => {
    n++;
    if (s.fenced.length <= DISCORD_MAX) messages.push({ content: s.fenced, paste: true });
    else
      messages.push({
        content: `📎 Paste block ${n} (${s.body.length.toLocaleString()} chars) is attached — too long for one message.`,
        file: { name: `paste-${n}.txt`, data: s.body },
        paste: true,
      });
  };
  if (proseTotal > ATTACH_THRESHOLD) {
    // Very long prose: preview + full answer.md first, then every paste block on its own.
    messages.push(...proseMessages(safe));
    for (const s of segments) if (s.kind === "block") pushBlock(s);
    return { messages, hits };
  }
  for (const s of segments) {
    if (s.kind === "prose") messages.push(...proseMessages(s.text));
    else pushBlock(s);
  }
  return { messages, hits };
}
