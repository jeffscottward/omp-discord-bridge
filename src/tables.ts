// Discord does not render Markdown tables and collapses their spacing (owner request 2026-10-14).
// Turn every Markdown table into an aligned monospace code block. Fenced code is left alone.
// A bare ``` fence is used, so src/blocks.ts does not treat it as a paste block.

const ROW = /^\s*\|.*\|\s*$/;
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Display width: wide emoji and CJK count as 2 columns, variation selectors as 0. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/[\u{FE0F}\u{200D}]/u.test(ch)) continue;
    w += /[\p{Extended_Pictographic}\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FF00}-\u{FF60}]/u.test(ch) ? 2 : 1;
  }
  return w;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim().replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"));
}

function render(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ""))));
  const line = (r: string[]) =>
    r.map((c, i) => (i === cols - 1 ? c : c + " ".repeat(w[i]! - width(c)))).join("  ").trimEnd();
  const out = [line(rows[0]!), w.map((n) => "─".repeat(n)).join("  "), ...rows.slice(1).map(line)];
  return ["```", ...out, "```"].join("\n");
}

export function tablesToCode(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) {
      fence = !fence;
      out.push(l);
      continue;
    }
    if (!fence && ROW.test(l) && i + 1 < lines.length && SEP.test(lines[i + 1]!)) {
      const rows = [cells(l)];
      let j = i + 2;
      while (j < lines.length && ROW.test(lines[j]!)) rows.push(cells(lines[j++]!));
      out.push(render(rows));
      i = j - 1;
      continue;
    }
    out.push(l);
  }
  return out.join("\n");
}
