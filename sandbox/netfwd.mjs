// Runs inside the Discord sandbox (own network namespace). Forwards 127.0.0.1:<port> to the
// bridge's Unix sockets: the egress proxy and, when configured, the SMTP tunnel.
// Usage: bun netfwd.mjs <port>=<unix-socket> …
import { writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const pairs = process.argv.slice(2).map((a) => a.split("="));
let pending = pairs.length;
for (const [port, sock] of pairs) {
  createServer((c) => {
    const up = connect(sock);
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
    c.pipe(up);
    up.pipe(c);
  })
    .on("error", (e) => console.error(`netfwd ${port}: ${e.message}`))
    .listen(Number(port), "127.0.0.1", () => {
      if (--pending === 0) writeFileSync("/tmp/.omp-netfwd-ready", "");
    });
}
