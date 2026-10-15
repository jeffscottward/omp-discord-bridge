// Fixed tunnel from the sandbox to one host-side destination (a Unix socket, mode 600): the SMTP
// server from the bot config ("smtp") for mail (neomutt; the sandbox's /etc/hosts points that name
// at 127.0.0.1).
import { chmodSync, existsSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";

/** Pipe every connection to a fixed host:port. */
export function startTcpTunnel(socketPath: string, host: string, port: number): Server {
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer((c) => {
    const up = connect({ host, port });
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
    c.pipe(up);
    up.pipe(c);
  });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return server;
}
