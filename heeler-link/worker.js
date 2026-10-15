// <your redirect host>/open?host=<Host>&pane=<pane id>[&session=<name>] → heeler://agent?…
// Discord link buttons only accept http/https, so the bridge's "Open in HEELER" buttons point
// here. Not an open redirect: it only ever builds a heeler://agent URL from validated values.
// No cookies, no logging, no storage.
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PANE_RE = /^[A-Za-z0-9]{1,12}:[A-Za-z0-9]{1,12}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,63}$/;

export function heelerTarget(params) {
  const host = params.get("host");
  const pane = params.get("pane");
  const session = params.get("session");
  if (!host || !HOST_RE.test(host)) return null;
  if (pane !== null && !PANE_RE.test(pane)) return null;
  if (session !== null && !SESSION_RE.test(session)) return null;
  let url = `heeler://agent?host=${encodeURIComponent(host)}`;
  if (session) url += `&session=${encodeURIComponent(session)}`;
  if (pane) url += `&pane=${encodeURIComponent(pane)}`;
  return { url, label: pane ? `${host} · ${pane}` : `${host} · Console` };
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function page(target) {
  // target.url contains only [A-Za-z0-9._:%=&?/-]: safe in an attribute and a JS string.
  const u = target.url;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open in HEELER</title><meta http-equiv="refresh" content="0;url=${u}">
<style>body{font:17px -apple-system,system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:90vh;margin:0}
a{display:inline-block;padding:14px 22px;border-radius:12px;background:#5865f2;color:#fff;text-decoration:none;font-weight:600}p{color:#999;text-align:center}</style>
</head><body><div style="text-align:center"><p>${target.label}</p><a href="${u}">Open in HEELER</a><p>Needs Heeler 0.1.13 or later.</p></div>
<script>location.replace(${JSON.stringify(u)})</script></body></html>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/open") return new Response("not found", { status: 404 });
    const target = heelerTarget(url.searchParams);
    if (!target) return new Response("bad link", { status: 400, headers: { "cache-control": "no-store" } });
    return new Response(page(target), { headers: { ...HEADERS, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
  },
};
