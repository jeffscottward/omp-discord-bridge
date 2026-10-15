import { CHANNELS, DM_CWD, GUILD_ID, OWNER_ID } from "./config.ts";

export interface MsgInfo {
  authorId: string;
  authorIsBot: boolean;
  /** null for DMs */
  guildId: string | null;
  channelId: string;
  isDM: boolean;
  isThread: boolean;
  /** parent channel id when isThread */
  parentId: string | null;
}

export type Route =
  | { kind: "ignore"; reason: string }
  | { kind: "new-thread"; cwd: string; channelName: string }
  | { kind: "thread"; cwd: string; channelName: string }
  | { kind: "dm"; cwd: string };

/** Only the owner, never bots/webhooks. */
export function isAllowedAuthor(authorId: string, authorIsBot: boolean): boolean {
  return !authorIsBot && authorId === OWNER_ID;
}

export interface AuthorInfo {
  authorId: string;
  /** Discord `author.bot` */
  isBot: boolean;
  /** Message sent through a webhook (`message.webhookId` set) */
  isWebhook: boolean;
  /** Discord system message (`message.system`) or a non-default message type */
  isSystem: boolean;
  /** The bridge's own bot user id */
  botUserId: string | undefined;
}

/**
 * Real author classification. "owner": the owner's own account typed it (non-bot, non-webhook,
 * non-system). "bridge": the bridge itself (its bot user or a webhook, e.g. relay self-tests).
 * "other": everyone else. Only "owner" is ever routed to an agent as owner input.
 */
export function messageProvenance(a: AuthorInfo): "owner" | "bridge" | "other" {
  if (a.isWebhook || (a.botUserId !== undefined && a.authorId === a.botUserId)) return "bridge";
  if (a.isBot || a.isSystem) return "other";
  return a.authorId === OWNER_ID ? "owner" : "other";
}

export function route(m: MsgInfo): Route {
  if (m.authorIsBot) return { kind: "ignore", reason: "bot" };
  if (!isAllowedAuthor(m.authorId, m.authorIsBot)) return { kind: "ignore", reason: "not-owner" };
  if (m.isDM) return { kind: "dm", cwd: DM_CWD };
  if (m.guildId !== GUILD_ID) return { kind: "ignore", reason: "other-guild" };
  if (m.isThread) {
    const ch = m.parentId ? CHANNELS[m.parentId] : undefined;
    if (!ch) return { kind: "ignore", reason: "unmapped-thread-parent" };
    return { kind: "thread", cwd: ch.cwd, channelName: ch.name };
  }
  const ch = CHANNELS[m.channelId];
  if (!ch) return { kind: "ignore", reason: "unmapped-channel" };
  return { kind: "new-thread", cwd: ch.cwd, channelName: ch.name };
}

/** Thread name from the first URL's host (plus path hint) or the first words. Max 100 chars. */
export function threadName(content: string): string {
  const text = content.trim();
  const urlMatch = text.match(/https?:\/\/[^\s<>]+/i);
  const rest = text.replace(/<?https?:\/\/[^\s<>]+>?/gi, " ").replace(/\s+/g, " ").trim();
  let name = "";
  if (urlMatch) {
    try {
      const host = new URL(urlMatch[0]).hostname.replace(/^www\./, "");
      const words = rest.split(" ").filter(Boolean).slice(0, 6).join(" ");
      name = words ? `${host} – ${words}` : host;
    } catch {
      name = "";
    }
  }
  if (!name) name = text.replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ");
  name = name.replace(/[\r\n`*_~|]/g, "").trim();
  if (!name) name = "omp task";
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}
