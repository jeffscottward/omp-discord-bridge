// Owner rule 2026-10-13: never show a long raw URL. Bare URLs in prose become short masked links
// ("[x.com ↗](<url>)"), and markdown links whose label is itself a URL get a short label.
// Angle brackets also stop Discord's big link previews. Code (fenced or `inline`) is untouched.

const BARE = /(?<![(<\[])\bhttps?:\/\/[^\s<>()`]+[^\s<>()`.,;:!?'"*_)\]]/g;
const MD = /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g;

/** Short human label: host (no www) plus the last path part when short. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const tail = last && last.length <= 24 && !/^[0-9a-f-]{16,}$/i.test(last) && !/^\d{8,}$/.test(last) ? `/${last}` : "";
    return `${host}${tail} ↗`;
  } catch {
    return "link ↗";
  }
}

function shortenPlain(text: string): string {
  // Protect `inline code` spans.
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(MD, (_m, label: string, url: string) => `[${/^https?:\/\//.test(label.trim()) ? linkLabel(url) : label}](<${url}>)`)
            .replace(BARE, (url) => `[${linkLabel(url)}](<${url}>)`),
    )
    .join("");
}

/** Apply to prose; fenced code blocks are left as they are. */
export function shortenLinks(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) out.push(inFence ? buf.join("\n") : shortenPlain(buf.join("\n")));
    buf = [];
  };
  for (const line of text.split("\n")) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      if (!inFence) { flush(); inFence = true; buf.push(line); }
      else { buf.push(line); flush(); inFence = false; }
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join("\n");
}
