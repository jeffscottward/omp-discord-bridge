// Approval tab script. The bridge starts it in a dedicated Herdr tab on the host:
//   exec bun gate/approve.ts <queue-dir> <id> <sha256>
// It shows the exact queued command, verifies the user's login password through PAM
// with sudo's own hidden prompt (`sudo -k; sudo -v`, 3 tries, then `sudo -k`), and only then runs
// the command unchanged with `bash -c` in its cwd. The password never passes through this script,
// is never logged or stored, and no sudo ticket is left behind (the ticket is per-tty anyway).
// It writes a non-secret receipt (exit code, truncated output through the privacy filter and the
// known-secret filter; output of secret-revealing commands is shown here only) and exits, which
// closes the tab.
import { spawn, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { redact } from "../src/redact.ts";
import { redactKnownSecrets } from "../src/secrets.ts";
import { cancelEntry, hashEntry, movePending, readEntry, readReceipt, writeReceipt, type Entry } from "./queue.ts";

const RUN_TIMEOUT_MS = 20 * 60_000;
const MAX_CAPTURE = 256 * 1024;
const RECEIPT_CHARS = 3000;
/** Commands whose output is a secret: the output is shown in this tab only, never in the receipt. */
export const REVEALS_SECRETS = /\bop\s+(read|inject|run)\b|--reveal|\bsecret-tool\b|\bgh\s+auth\s+token\b|\bgit\s+credential\b|\.env\b|credential|token|passw|secret|\.pem\b|id_ed25519|id_rsa/i;
const USES_SUDO = /(^|[\s;&|(`])sudo(\s|$)/m;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
/** Pauses so the user can read the tab before it closes (tests set OMP_APPROVE_NO_PAUSE). */
const pause = (ms: number) => Bun.sleep(process.env.OMP_APPROVE_NO_PAUSE ? 0 : ms);

async function main(): Promise<number> {
  const [dir, id, hash] = process.argv.slice(2);
  if (!dir || !id || !hash) {
    console.error("usage: approve.ts <queue-dir> <id> <sha256>");
    return 2;
  }
  console.log(bold(`${hostname()} — Discord approval ${id}`));
  const entry = readEntry(dir, "pending", id);
  if (!entry) {
    const r = readReceipt(dir, id);
    console.log(r ? `Already finished: ${r.status} (${r.detail}).` : "No pending entry with this id.");
    await pause(4000);
    return 1;
  }
  if (hashEntry(entry) !== hash) {
    cancelEntry(dir, id, "rejected", "the queue entry changed after it was posted");
    console.log("REJECTED: the queue entry changed after it was posted. Nothing ran.");
    await pause(6000);
    return 1;
  }
  if (Date.now() > entry.expiresAt) {
    cancelEntry(dir, id, "expired", "expired before approval");
    console.log("Expired. Nothing ran.");
    await pause(4000);
    return 1;
  }
  console.log(`\nReason given by the agent: ${entry.reason || "(none)"}`);
  console.log(`Working directory: ${entry.cwd}`);
  console.log(`Expires: ${new Date(entry.expiresAt).toLocaleTimeString()}`);
  console.log(bold("\nExact command (runs with bash -c, unchanged):"));
  console.log("─".repeat(60));
  console.log(entry.command);
  console.log("─".repeat(60));
  console.log("Approve by entering your login password. Ctrl-C (or !deny in Discord) cancels.\n");

  // A sudo that does not ask for a password cannot verify anything: refuse.
  spawnSync("sudo", ["-k"], { stdio: "ignore" });
  if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0) {
    spawnSync("sudo", ["-k"], { stdio: "ignore" });
    cancelEntry(dir, id, "rejected", "sudo did not require a password, so the password could not be verified");
    console.log("REJECTED: sudo did not ask for a password; cannot verify. Nothing ran.");
    await pause(6000);
    return 1;
  }
  const verified = await verifyPassword(dir, entry);
  if (!verified.ok) {
    spawnSync("sudo", ["-k"], { stdio: "ignore" });
    cancelEntry(dir, id, verified.status, verified.detail);
    console.log(`\n${verified.detail}. Nothing ran.`);
    await pause(4000);
    return 1;
  }
  // Single use: claim atomically, then re-check the claimed bytes.
  if (!movePending(dir, id, "claimed")) {
    spawnSync("sudo", ["-k"], { stdio: "ignore" });
    console.log("\nThe entry was cancelled meanwhile. Nothing ran.");
    await pause(4000);
    return 1;
  }
  const claimed = readEntry(dir, "claimed", id);
  if (!claimed || hashEntry(claimed) !== hash) {
    spawnSync("sudo", ["-k"], { stdio: "ignore" });
    writeReceipt(dir, { id, status: "rejected", detail: "the queue entry changed during approval", at: Date.now() });
    console.log("\nREJECTED: the entry changed during approval. Nothing ran.");
    await pause(6000);
    return 1;
  }
  if (!USES_SUDO.test(claimed.command)) spawnSync("sudo", ["-k"], { stdio: "ignore" });
  const secret = REVEALS_SECRETS.test(claimed.command);
  console.log(bold("\nPassword verified. Running…\n"));
  const res = await runCommand(claimed, secret);
  spawnSync("sudo", ["-k"], { stdio: "ignore" });
  let output: string;
  if (secret) output = "[output withheld: shown only in the approval tab, because the command can reveal secrets]";
  else {
    const tail = res.output.length > RECEIPT_CHARS ? `…${res.output.slice(-RECEIPT_CHARS)}` : res.output;
    output = redactKnownSecrets(redact(tail).text).text;
  }
  writeReceipt(dir, {
    id,
    status: "ran",
    exitCode: res.code,
    output,
    detail: res.timedOut ? `stopped after ${RUN_TIMEOUT_MS / 60_000} min` : `exit ${res.code}`,
    at: Date.now(),
  });
  console.log(bold(`\nDone: exit ${res.code}. The result was sent to Discord.`));
  await pause(secret ? 90_000 : 5000);
  return 0;
}

/** sudo's own hidden prompt (PAM, 3 tries). Killed on expiry or when the entry is cancelled. */
async function verifyPassword(
  dir: string,
  entry: Entry,
): Promise<{ ok: true } | { ok: false; status: "denied" | "expired" | "cancelled"; detail: string }> {
  const child = spawn("sudo", ["-v", "-p", `[approve ${entry.id}] login password for %u: `], { stdio: "inherit" });
  let stop: { status: "expired" | "cancelled"; detail: string } | null = null;
  const timer = setInterval(() => {
    if (Date.now() > entry.expiresAt) stop = { status: "expired", detail: "Expired before the password was entered" };
    else if (!readEntry(dir, "pending", entry.id)) stop = { status: "cancelled", detail: "Cancelled" };
    if (stop) child.kill("SIGTERM");
  }, 1000);
  const closed = Promise.withResolvers<number | null>();
  child.on("close", closed.resolve);
  const code = await closed.promise;
  clearInterval(timer);
  if (stop) return { ok: false, ...(stop as { status: "expired" | "cancelled"; detail: string }) };
  if (code === 0) return { ok: true };
  return { ok: false, status: "denied", detail: "Password not verified (wrong password 3 times, or cancelled)" };
}

async function runCommand(e: Entry, secret: boolean): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const child = spawn("bash", ["-c", e.command], { cwd: e.cwd, stdio: ["inherit", secret ? "inherit" : "pipe", secret ? "inherit" : "pipe"] });
  let output = "";
  const take = (d: Buffer, to: NodeJS.WriteStream) => {
    to.write(d);
    if (output.length < MAX_CAPTURE) output += d.toString();
  };
  child.stdout?.on("data", (d: Buffer) => take(d, process.stdout));
  child.stderr?.on("data", (d: Buffer) => take(d, process.stderr));
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, RUN_TIMEOUT_MS);
  const closed = Promise.withResolvers<number | null>();
  child.on("close", closed.resolve);
  child.on("error", () => closed.resolve(127));
  const code = await closed.promise;
  clearTimeout(t);
  return { code, output, timedOut };
}

if (import.meta.main) process.exit(await main());
