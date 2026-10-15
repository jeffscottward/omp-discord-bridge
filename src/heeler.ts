// HEELER (iOS Herdr companion) deep links, Heeler 0.1.13+ (README "Opening an Agent from another
// app", Sources/HeelerActivityCore/AgentActivityLink.swift):
//   heeler://agent?host=<saved Host address or name>&session=<herdr session>&pane=<pane id>
// `pane` must be an Agent pane (Heeler's Agents list); without it the link opens the Console.
// Plain shell terminals (the "Approve <id>" tabs) are not addressable: a pane link to one shows
// Heeler's "agent missing" screen, so approval posts link to the rig's Console instead.
// Discord link buttons accept only http/https/discord URLs (API error URL_TYPE_INVALID_SCHEME for
// heeler://), so buttons point at a tiny redirect page you host (heeler-link/worker.js, e.g. as a
// Cloudflare Worker on your own domain) that validates the parameters and opens the heeler:// URL.
// Host and redirect come from the bot config ("heeler") or the env vars below.
import { CONFIG } from "./config.ts";

export const HEELER_HOST = process.env.OMP_BOT_HEELER_HOST ?? CONFIG.heeler?.host ?? "rig";
/** Empty when not configured: no HEELER link buttons are offered. */
export const HEELER_REDIRECT = process.env.OMP_BOT_HEELER_REDIRECT ?? CONFIG.heeler?.redirect ?? "";

export interface LinkButton {
  label: string;
  url: string;
}

/** The heeler:// URL itself (percent-encoded values; `+` would stay a plus sign in Heeler). */
export function heelerUrl(host: string, pane?: string): string {
  return `heeler://agent?host=${encodeURIComponent(host)}${pane ? `&pane=${encodeURIComponent(pane)}` : ""}`;
}

/** https link for a Discord button: the redirect page opens heelerUrl(host, pane). */
export function heelerButton(label: string, pane?: string, host = HEELER_HOST): LinkButton {
  return { label, url: `${HEELER_REDIRECT}?host=${encodeURIComponent(host)}${pane ? `&pane=${encodeURIComponent(pane)}` : ""}` };
}
