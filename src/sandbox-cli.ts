// Run one command inside the Discord capability sandbox (same isolation and bridge sockets as runs).
// Usage: bun src/sandbox-cli.ts [--key K] [--cwd DIR] [--channel ID] -- <command…>
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_CHANNEL_ID } from "./config.ts";
import { spawnSandboxed } from "./omp.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep === -1 ? [] : argv.slice(0, sep);
const cmd = sep === -1 ? argv : argv.slice(sep + 1);
const opt = (name: string, dflt: string) => {
  const i = opts.indexOf(name);
  return i === -1 ? dflt : opts[i + 1]!;
};
if (!cmd.length) {
  console.error("usage: bun src/sandbox-cli.ts [--key K] [--cwd DIR] [--channel ID] -- <command…>");
  process.exit(2);
}
const child = spawnSandboxed(opt("--key", "cli-test"), opt("--cwd", join(homedir(), "Github")), cmd, { channelId: opt("--channel", DEV_CHANNEL_ID) });
child.stdout!.pipe(process.stdout);
child.stderr!.pipe(process.stderr);
child.on("close", (code) => setTimeout(() => process.exit(code ?? 1), 50));
