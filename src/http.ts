import { ALERT_CHANNELS, CHANNELS, HTTP_HOST, HTTP_PORT } from "./config.ts";

export interface HttpDeps {
  post: (channelId: string, text: string) => Promise<void>;
  health: () => unknown;
  /** Extra channels (mirrored Herdr tab channels): name/id → id, or null. */
  resolveExtra?: (ref: string) => { id: string; name: string } | null;
}

const MAX_BODY = 64 * 1024;

/** Resolve "dev" / "#dev" / a mapped channel id to a channel id. */
export function resolveChannel(ref: string): string | null {
  const r = ref.trim().replace(/^#/, "");
  if (CHANNELS[r] || ALERT_CHANNELS[r]) return r;
  const hit = [...Object.entries(CHANNELS), ...Object.entries(ALERT_CHANNELS)].find(([, c]) => c.name === r);
  return hit ? hit[0] : null;
}

/**
 * Local-only guard: loopback Host header (blocks DNS rebinding), no browser Origin
 * (blocks cross-site requests), JSON content type (forces a CORS preflight we never answer).
 */
export function checkLocalRequest(req: Request, port = HTTP_PORT): string | null {
  const host = req.headers.get("host") ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return "bad host";
  if (req.headers.get("origin")) return "browser origin not allowed";
  return null;
}

export function startHttp(deps: HttpDeps, port = HTTP_PORT) {
  return Bun.serve({
    hostname: HTTP_HOST,
    port,
    async fetch(req) {
      const bad = checkLocalRequest(req, port);
      if (bad) return Response.json({ error: bad }, { status: 403 });
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") return Response.json(deps.health());
      if (req.method !== "POST" || url.pathname !== "/post") return Response.json({ error: "not found" }, { status: 404 });
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
        return Response.json({ error: "content-type must be application/json" }, { status: 415 });
      const raw = await req.text();
      if (raw.length > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      if (!body || typeof body !== "object" || !("channel" in body) || !("text" in body))
        return Response.json({ error: "expected {channel, text}" }, { status: 400 });
      const { channel, text } = body;
      if (typeof channel !== "string" || typeof text !== "string" || !text.trim())
        return Response.json({ error: "channel and text must be non-empty strings" }, { status: 400 });
      const channelId = resolveChannel(channel);
      const extra = channelId ? null : (deps.resolveExtra?.(channel.trim().replace(/^#/, "")) ?? null);
      if (!channelId && !extra) return Response.json({ error: "unknown channel" }, { status: 400 });
      const id = channelId ?? extra!.id;
      try {
        await deps.post(id, text);
      } catch (e) {
        return Response.json({ error: `post failed: ${(e as Error).message}` }, { status: 502 });
      }
      return Response.json({ ok: true, channel: channelId ? (CHANNELS[channelId] ?? ALERT_CHANNELS[channelId])!.name : extra!.name });
    },
  });
}
