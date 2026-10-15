const FENCE_RE = /^\s*(```+|~~~+)/;

/**
 * Split text into Discord-sized messages (default 2000 chars).
 * Prefers line boundaries; when a chunk boundary falls inside a fenced code block,
 * the block is closed at the end of the chunk and reopened (same info string) in the next.
 */
export function splitMessage(text: string, max = 2000): string[] {
  if (max < 40) throw new Error("max too small");
  const out: string[] = [];
  const closeReserve = 4; // "\n```"
  const pieceSize = Math.floor(max / 2);
  let cur = "";
  let fence: string | null = null; // opener line, e.g. "```ts"
  let fenceMarker = "```";

  const flush = () => {
    if (cur === "" || cur === fence) return;
    out.push(fence ? `${cur}\n${fenceMarker}` : cur);
    cur = fence ?? "";
  };

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const pieces: string[] = [];
    for (let i = 0; i < rawLine.length; i += pieceSize) pieces.push(rawLine.slice(i, i + pieceSize));
    if (pieces.length === 0) pieces.push("");
    for (const piece of pieces) {
      const sep = cur === "" ? "" : "\n";
      if (cur.length + sep.length + piece.length + closeReserve > max) flush();
      cur += (cur === "" ? "" : "\n") + piece;
    }
    const m = rawLine.match(FENCE_RE);
    if (m) {
      if (fence) {
        fence = null;
      } else {
        fence = rawLine.trim().slice(0, 40);
        fenceMarker = m[1]!;
      }
    }
  }
  if (cur !== "" && cur !== fence) out.push(fence ? `${cur}\n${fenceMarker}` : cur);
  return out.filter((c) => c.trim() !== "");
}
