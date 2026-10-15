// Egress filter for sandboxed Discord runs.
// The sandbox has no network of its own (bwrap --unshare-net). Its only way out is this
// HTTP/CONNECT proxy on a Unix socket: any port on public hosts. Loopback, LAN, tailnet
// (CGNAT 100.64/10), link-local and reserved ranges are refused, plus any hosts and IPs listed
// under "egress" in the bot config, so host services and the tailnet cannot be reached.
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { isIP, connect, createServer, type Server, type Socket } from "node:net";
import { CONFIG } from "./config.ts";

/** Hosts never reachable from a Discord run (case-insensitive suffix match). */
export const DENY_HOST_SUFFIXES = [
  "ts.net", // tailnet MagicDNS
  "localhost",
  "local",
  "internal",
  "lan",
  "home.arpa",
  ...(CONFIG.egress?.denyHostSuffixes ?? []).map((s) => s.toLowerCase().replace(/^\./, "")),
];
/** Public IPs that must stay unreachable (config "egress.denyIps"), e.g. a VPS reachable only over SSH. */
export const DENY_IPS: readonly string[] = CONFIG.egress?.denyIps ?? [];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True for loopback/private/tailnet/link-local/reserved addresses and the denied IPs. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return true;
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local (tailscale fd7a:…)
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    if (/^64:ff9b:/.test(lower) || /^2001:db8:/.test(lower)) return true;
    return false;
  }
  if (DENY_IPS.includes(ip)) return true;
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (isIP(h)) return isBlockedAddress(h);
  if (!h.includes(".")) return true; // single-label names (LAN/SSH aliases like "nas" or "laptop")
  return DENY_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export type Decision = { ok: true; address: string } | { ok: false; reason: string };

/** Decide a destination; resolves DNS here and pins the address (no rebinding). */
export async function decide(
  host: string,
  port: number,
  resolve: (h: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<Decision> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: `port ${port} not allowed` };
  if (isBlockedHost(host)) return { ok: false, reason: `host ${host} blocked` };
  const bare = host.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(bare) ? [bare] : await resolve(bare);
  } catch {
    return { ok: false, reason: `cannot resolve ${host}` };
  }
  if (!addrs.length) return { ok: false, reason: `cannot resolve ${host}` };
  if (addrs.some(isBlockedAddress)) return { ok: false, reason: `${host} resolves to a blocked address` };
  return { ok: true, address: addrs[0]! };
}

function parseTarget(method: string, target: string): { host: string; port: number; path?: string } | null {
  if (method === "CONNECT") {
    const m = target.match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
    return m ? { host: m[1]!, port: Number(m[2]) } : null;
  }
  try {
    const u = new URL(target);
    if (u.protocol !== "http:") return null;
    return { host: u.hostname, port: Number(u.port || 80), path: `${u.pathname}${u.search}` };
  } catch {
    return null;
  }
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[egress]", ...a);

function refuse(sock: Socket, reason: string) {
  sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nblocked by Discord sandbox egress filter: ${reason}\n`);
}

function handle(client: Socket) {
  let buf = Buffer.alloc(0);
  const onData = async (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buf.length > 32 * 1024) refuse(client, "header too large");
      return;
    }
    client.off("data", onData);
    client.pause();
    const head = buf.subarray(0, end).toString("latin1");
    const rest = buf.subarray(end + 4);
    const [line, ...headers] = head.split("\r\n");
    const [method = "", target = ""] = (line ?? "").split(" ");
    const t = parseTarget(method, target);
    if (!t) return refuse(client, "unsupported request");
    const d = await decide(t.host, t.port);
    if (!d.ok) {
      log(`deny ${method} ${t.host}:${t.port} (${d.reason})`);
      return refuse(client, d.reason);
    }
    log(`allow ${method} ${t.host}:${t.port}`);
    const up = connect({ host: d.address, port: t.port });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    up.once("connect", () => {
      if (method === "CONNECT") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) up.write(rest);
      } else {
        const kept = headers.filter((h) => !/^(proxy-[a-z-]+|connection|keep-alive)\s*:/i.test(h));
        up.write(`${method} ${t.path} ${line!.split(" ")[2] ?? "HTTP/1.1"}\r\n${[...kept, "Connection: close"].join("\r\n")}\r\n\r\n`);
        if (rest.length) up.write(rest);
      }
      client.pipe(up);
      up.pipe(client);
      client.resume();
    });
  };
  client.on("data", onData);
  client.on("error", () => client.destroy());
  client.setTimeout(10 * 60_000, () => client.destroy());
}

/** Start the proxy on a Unix socket (mode 600). */
export function startEgressProxy(socketPath: string): Server {
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer(handle);
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return server;
}
