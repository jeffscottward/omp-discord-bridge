import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const HOME = homedir();

/**
 * Per-install settings (Discord ids, channel → cwd map, optional integrations) live in a JSON file,
 * never in the code: `$OMP_BOT_CONFIG`, default ~/.config/omp-discord/config.json. See
 * config.example.json for every key. A missing or invalid file does not throw at import time (so
 * tools that only need the path constants still work); `requireConfig()` reports it clearly.
 */
export const CONFIG_FILE = process.env.OMP_BOT_CONFIG ?? join(HOME, ".config", "omp-discord", "config.json");

export interface BotConfig {
  /** The owner's Discord user id. Only this account can talk to the bot. */
  ownerId: string;
  /** The owner's private Discord server id. */
  guildId: string;
  /** Text channel id → { name, cwd }. Only these channels start agent runs. */
  channels: Record<string, { name: string; cwd: string }>;
  /** Post-only channels for the loopback /post endpoint; messages there never start runs. */
  alertChannels?: Record<string, { name: string }>;
  /** Where self-tests, CLI approvals and channel-delete notices go (usually an alert channel). */
  devChannelId?: string;
  /** Working directory for DMs with the owner. */
  dmCwd?: string;
  voice?: {
    /** Voice channel: the owner joining it turns voice mode on. */
    channelId?: string;
    /** Post-only log of every voice-call turn. */
    transcriptChannelId?: string;
    /** A run-starting channel for spoken turns before the owner has written anywhere. */
    fallbackChannelId?: string;
  };
  mirror?: {
    /** Discord category ids for mirrored Herdr panes. Mirroring is off without `rig` and `archive`. */
    categories?: { rig?: string; mac?: string; archive?: string };
    /** SSH host of a second machine whose Herdr panes are mirrored too (null/absent: none). */
    macSshHost?: string | null;
  };
  /** Herdr pane that "Send to FIRSTMATE" buttons deliver to (absent: button disabled). */
  firstmate?: { pane?: string; tabLabel?: string; channelName?: string };
  /** Custom emoji shown while a job runs, e.g. "<a:spin_gear:ID>". Default ⚙️. */
  workingEmoji?: string;
  /** HEELER deep-link redirect page and the Herdr host name it opens. */
  heeler?: { host?: string; redirect?: string };
  /** Extra destinations the sandbox egress proxy refuses (on top of private/reserved ranges). */
  egress?: { denyIps?: string[]; denyHostSuffixes?: string[] };
  /** Fixed SMTP tunnel for sandboxed mail (neomutt). Absent: no mail from sandboxed runs. */
  smtp?: { host: string; port?: number };
  /** /services, /logs and /restart: label → systemd user unit. */
  services?: Record<string, string>;
  /** Labels from `services` that /restart may restart. */
  restartable?: string[];
  /** /net: label → host pinged for latency. */
  pingHosts?: Record<string, string>;
  /** Machine label used in messages ("the approval tab on <hostLabel>"). */
  hostLabel?: string;
}

const ID_RE = /^\d{5,20}$/;

function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

/** The value as a plain object, or an empty one (for optional sections). */
function section(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v));
}

/** Validate a parsed config. Returns the errors (empty when valid). Pure; exported for tests. */
export function validateConfig(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["the file must hold a JSON object"];
  const c = section(raw);
  const id = (v: unknown, key: string, required = false) => {
    if (v === undefined || v === null || v === "") {
      if (required) errs.push(`${key} is required (a Discord id, digits only)`);
    } else if (typeof v !== "string" || !ID_RE.test(v)) errs.push(`${key} must be a Discord id as a string of digits (got ${JSON.stringify(v)}); replace the placeholder`);
  };
  id(c.ownerId, "ownerId", true);
  id(c.guildId, "guildId", true);
  if (!c.channels || typeof c.channels !== "object" || Array.isArray(c.channels)) errs.push("channels must be an object: { \"<channel id>\": { \"name\": \"general\", \"cwd\": \"~/Github\" } }");
  else {
    for (const [k, v] of Object.entries(section(c.channels))) {
      id(k, `channels key ${JSON.stringify(k)}`);
      const ch = section(v);
      if (typeof ch.name !== "string" || typeof ch.cwd !== "string") errs.push(`channels[${k}] needs string "name" and "cwd"`);
      else if (!isAbsolute(expandHome(ch.cwd))) errs.push(`channels[${k}].cwd must be absolute or start with ~/`);
    }
  }
  if (c.alertChannels !== undefined) {
    if (!c.alertChannels || typeof c.alertChannels !== "object") errs.push("alertChannels must be an object");
    else for (const k of Object.keys(c.alertChannels)) id(k, `alertChannels key ${JSON.stringify(k)}`);
  }
  id(c.devChannelId, "devChannelId");
  const voice = section(c.voice);
  for (const k of ["channelId", "transcriptChannelId", "fallbackChannelId"]) id(voice[k], `voice.${k}`);
  const cats = section(section(c.mirror).categories);
  for (const k of ["rig", "mac", "archive"]) id(cats[k], `mirror.categories.${k}`);
  const egress = section(c.egress);
  for (const k of ["denyIps", "denyHostSuffixes"]) {
    const v = egress[k];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) errs.push(`egress.${k} must be an array of strings`);
  }
  if (c.smtp !== undefined && typeof section(c.smtp).host !== "string") errs.push("smtp.host must be a string");
  const mac = section(c.mirror).macSshHost;
  if (mac !== undefined && mac !== null && (typeof mac !== "string" || !/^[A-Za-z0-9][\w.@-]*$/.test(mac))) errs.push("mirror.macSshHost must be an SSH host name (or null)");
  return errs;
}

function load(): { config: BotConfig; error: string | null } {
  const empty: BotConfig = { ownerId: "", guildId: "", channels: {} };
  if (!existsSync(CONFIG_FILE)) {
    return { config: empty, error: `No bot config at ${CONFIG_FILE}. Copy config.example.json there (or set OMP_BOT_CONFIG) and fill in your Discord ids.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    return { config: empty, error: `Bot config ${CONFIG_FILE} is not valid JSON: ${(e as Error).message}` };
  }
  const errs = validateConfig(raw);
  if (errs.length) return { config: empty, error: `Bot config ${CONFIG_FILE} is invalid:\n  - ${errs.join("\n  - ")}` };
  return { config: raw as BotConfig, error: null };
}

const loaded = load();
export const CONFIG: BotConfig = loaded.config;
/** Why the config could not be loaded (null when it is fine). */
export const CONFIG_ERROR: string | null = loaded.error;

/** Call at program start: prints a clear message and exits when the config is missing or invalid. */
export function requireConfig(): BotConfig {
  if (CONFIG_ERROR) {
    console.error(`omp-discord-bot: ${CONFIG_ERROR}`);
    process.exit(78); // EX_CONFIG
  }
  return CONFIG;
}

export const OWNER_ID = CONFIG.ownerId;
export const GUILD_ID = CONFIG.guildId;

/** Text channel id → { name, cwd }. Only these channels start agent runs. */
export const CHANNELS: Record<string, { name: string; cwd: string }> = Object.fromEntries(
  Object.entries(CONFIG.channels).map(([id, c]) => [id, { name: c.name, cwd: expandHome(c.cwd) }]),
);

/** Post-only alert channels. Reachable through the loopback /post endpoint; messages there never start agent runs. */
export const ALERT_CHANNELS: Record<string, { name: string }> = CONFIG.alertChannels ?? {};

/** DMs have no channel mapping; they run here (default ~/Github). */
export const DM_CWD = expandHome(CONFIG.dmCwd ?? "~/Github");

/**
 * Voice conversation mode: the owner joining the configured voice channel turns it on; leaving
 * turns it off. Empty string: voice mode is off.
 */
export const VOICE_CHANNEL_ID = CONFIG.voice?.channelId ?? "";
/** Log of every voice-call turn (post-only). */
export const VOICE_TRANSCRIPT_CHANNEL_ID = CONFIG.voice?.transcriptChannelId ?? "";
/** Where spoken turns run when the owner has not written anywhere since the bot started. Must be a channel
 * that starts runs (a post-only transcript channel would silently drop them). */
export const VOICE_FALLBACK_CHANNEL_ID = CONFIG.voice?.fallbackChannelId ?? "";

/** Self-tests, sandbox-cli approvals and channel-delete notices post here. */
export const DEV_CHANNEL_ID = CONFIG.devChannelId ?? "";

/** Machine label used in user-facing text. */
export const HOST_LABEL = CONFIG.hostLabel ?? "rig";

/** Shown while a job runs. A custom (animated) emoji needs its id, so the default is plain unicode. */
export const WORKING_EMOJI = process.env.OMP_WORKING_EMOJI ?? CONFIG.workingEmoji ?? "⚙️";

export const MAX_CONCURRENT = Number(process.env.OMP_BOT_MAX_CONCURRENT ?? 2);
export const RUN_TIMEOUT_MS = Number(process.env.OMP_BOT_TIMEOUT_MIN ?? 30) * 60_000;

export const STATE_DIR =
  process.env.OMP_BOT_STATE_DIR ?? join(HOME, ".local", "share", "omp-discord-bot");
export const SESSIONS_DIR = join(STATE_DIR, "sessions");
/** Per-session writable scratch dirs, mounted at ~/discord-scratch inside the sandbox. */
export const SCRATCH_DIR = join(STATE_DIR, "scratch");
/** Persistent cache mounted at ~/.cache inside runs (uv, bun, npm caches). */
export const CACHE_DIR = join(STATE_DIR, "cache");
/** Password-gated approval queue (bridge-owned; hidden from runs). */
export const QUEUE_DIR = join(STATE_DIR, "approvals");
/** Herdr workspace (label) where approval tabs are created. */
export const APPROVAL_WORKSPACE = process.env.OMP_BOT_APPROVAL_WORKSPACE ?? "Github";

/**
 * The mirrored FIRSTMATE pane's channel uses its own persistent headless session (cwd ~/Github).
 * It never types into the interactive FIRSTMATE Herdr pane.
 */
export const FIRSTMATE_SESSION = {
  key: "firstmate",
  cwd: join(HOME, "Github"),
  tabLabel: CONFIG.firstmate?.tabLabel ?? "FIRSTMATE",
  channelName: CONFIG.firstmate?.channelName ?? "rig-github-firstmate",
};

export const OMP_BIN =
  process.env.OMP_BOT_OMP_BIN ?? join(HOME, ".local", "share", "mise", "shims", "omp");

export const HTTP_HOST = "127.0.0.1";
export const HTTP_PORT = Number(process.env.OMP_BOT_HTTP_PORT ?? 47821);

/** Outputs longer than this are attached as a .md file instead of many messages. */
export const ATTACH_THRESHOLD = 8000;

export const BOT_ENV_FILE = join(HOME, ".config", "omp-discord", "bot.env");

/**
 * Trusted mode (owner decision 2026-10-13): runs are not sandboxed, approvals are a Discord button
 * (no password), and answers can attach files. On while this flag file exists; checked per run, so
 * `rm ~/.config/omp-discord/trusted` restores the sandboxed model for the next run.
 */
export const TRUSTED_FLAG = join(HOME, ".config", "omp-discord", "trusted");
export function trusted(): boolean {
  return existsSync(TRUSTED_FLAG);
}
/** Largest file an answer may attach (Discord's default upload limit for bots). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
