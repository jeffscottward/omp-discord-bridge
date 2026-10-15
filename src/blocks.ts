// Paste blocks: fenced blocks meant to be pasted into FIRSTMATE. Each is posted as its own Discord
// message (only the fenced block), so iOS long-press → Copy Text copies just that block, and it
// gets a "Send to FIRSTMATE" button. A paste block is a fenced block whose info string is a
// plain-text language (```text, ```txt, ```plaintext, ```plain, ```prompt) or names FIRSTMATE
// (```firstmate), or whose label line right before it mentions FIRSTMATE ("Paste into FIRSTMATE:").
// Other code blocks (```ts, bare ```) stay inline in the prose.

export type Segment =
  | { kind: "prose"; text: string }
  | { kind: "block"; info: string; body: string; fenced: string };

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const PASTE_INFO: Record<string, true> = { text: true, txt: true, plaintext: true, plain: true, prompt: true, firstmate: true };
const LABEL_RE = /firstmate/i;

export function isPasteInfo(info: string): boolean {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return PASTE_INFO[lang] === true || LABEL_RE.test(info);
}

/** Split text into prose and paste-block segments (in order). Unclosed fences stay prose. */
export function splitPasteBlocks(text: string): Segment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Segment[] = [];
  let prose: string[] = [];
  const pushProse = () => {
    const t = prose.join("\n").replace(/^\n+|\s+$/g, "");
    if (t.trim()) out.push({ kind: "prose", text: t });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(OPEN_RE);
    if (!m) {
      prose.push(lines[i]!);
      continue;
    }
    const marker = m[1]!;
    const info = m[2]!.trim();
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j]!)) j++;
    if (j >= lines.length) {
      // Unclosed: leave the rest as prose.
      prose.push(...lines.slice(i));
      break;
    }
    const body = lines.slice(i + 1, j).join("\n");
    const labelled = LABEL_RE.test(prose.join("\n").replace(/\s+$/, "").split("\n").pop() ?? "");
    if (isPasteInfo(info) || labelled) {
      pushProse();
      out.push({ kind: "block", info, body, fenced: `${marker}${info}\n${body}\n${marker}` });
    } else {
      prose.push(...lines.slice(i, j + 1));
    }
    i = j;
  }
  pushProse();
  return out;
}

/** The block text of a posted paste-block message (content is exactly one fenced block). */
export function blockFromContent(content: string): string | null {
  const lines = content.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return null;
  const m = lines[0]!.match(OPEN_RE);
  if (!m) return null;
  const marker = m[1]!;
  if (lines[lines.length - 1] !== marker) return null;
  return lines.slice(1, -1).join("\n");
}
