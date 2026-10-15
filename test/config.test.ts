import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNELS, CONFIG_ERROR, OWNER_ID, validateConfig, WORKING_EMOJI } from "../src/config.ts";

const ROOT = join(import.meta.dir, "..");

describe("bot config", () => {
  test("the test fixture loads; ~ in cwd is expanded; working emoji defaults to unicode", () => {
    expect(CONFIG_ERROR).toBeNull();
    expect(OWNER_ID).toBe("100000001");
    expect(CHANNELS["300000002"]!.cwd).toBe(join(process.env.HOME!, "Github", "project-a"));
    expect(WORKING_EMOJI).toBe(process.env.OMP_WORKING_EMOJI ?? "⚙️");
  });
  test("config.example.json is well-formed but its placeholders are rejected", () => {
    const errs = validateConfig(JSON.parse(readFileSync(join(ROOT, "config.example.json"), "utf8")));
    expect(errs.some((e) => e.startsWith("ownerId must be a Discord id"))).toBe(true);
    expect(errs.some((e) => e.startsWith("guildId must be a Discord id"))).toBe(true);
  });
  test("bad shapes are reported", () => {
    expect(validateConfig([])).toEqual(["the file must hold a JSON object"]);
    expect(validateConfig({ ownerId: "1", guildId: "123456", channels: { "123456": { name: "x", cwd: "rel" } } }).join("\n")).toContain("cwd must be absolute");
    expect(validateConfig({ ownerId: "123456", guildId: "123456", channels: {}, egress: { denyIps: "1.2.3.4" } })).toEqual(["egress.denyIps must be an array of strings"]);
    expect(validateConfig({ ownerId: "123456", guildId: "123456", channels: {}, mirror: { macSshHost: "-oProxyCommand=x" } })).toEqual(["mirror.macSshHost must be an SSH host name (or null)"]);
    expect(validateConfig({ ownerId: "123456", guildId: "123456", channels: {} })).toEqual([]);
  });
  test("the bot refuses to start with a clear message when the config is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-cfg-"));
    const missing = spawnSync(process.execPath, ["src/main.ts"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, OMP_BOT_CONFIG: join(dir, "nope.json") }, timeout: 30_000 });
    expect(missing.status).toBe(78);
    expect(missing.stderr).toContain("No bot config at");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, readFileSync(join(ROOT, "config.example.json")));
    const invalid = spawnSync(process.execPath, ["src/main.ts"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, OMP_BOT_CONFIG: bad }, timeout: 30_000 });
    expect(invalid.status).toBe(78);
    expect(invalid.stderr).toContain("replace the placeholder");
  });
});
