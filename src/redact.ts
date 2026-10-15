/**
 * Outbound privacy filter. Applied to every message the bot posts.
 * Amounts and prices are intentionally allowed.
 */
interface Rule {
  name: string;
  re: RegExp;
  replace: string | ((...m: string[]) => string);
}

const ID_VALUE = String.raw`((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,19})`;

const RULES: Rule[] = [
  // Brokerage account numbers like U1234567 / U12345678, plus paper (DU) and advisor (F/DF) prefixes.
  { name: "broker-account", re: /\b(?:DU|DF|U|F)\d{7,8}\b/g, replace: "[REDACTED-ACCOUNT]" },
  // SSN-like: 123-45-6789 / 123 45 6789
  { name: "ssn", re: /\b\d{3}([- ])\d{2}\1\d{4}\b/g, replace: "[REDACTED-SSN]" },
  // Labeled bare 9-digit SSN / TIN
  {
    name: "ssn-labeled",
    re: /\b(SSN|TIN|ITIN|social security(?: number| no\.?| #)?)(\s*[:#]?\s*)\d{9}\b/gi,
    replace: (_m, label, sep) => `${label}${sep}[REDACTED-SSN]`,
  },
  // Driver's license / passport / generic ID document numbers when labeled.
  {
    name: "id-document",
    re: new RegExp(
      String.raw`\b(driver'?s?\s+licen[cs]e(?:\s*(?:no\.?|number|num|#))?|DL(?:\s*(?:no\.?|number|#))?|passport(?:\s*(?:no\.?|number|num|#))?|licen[cs]e\s*(?:no\.?|number|num|#)|ID\s*(?:no\.?|number|#))(\s*[:#]?\s*)` +
        ID_VALUE +
        String.raw`\b`,
      "gi",
    ),
    replace: (_m, label, sep) => `${label}${sep}[REDACTED-ID]`,
  },
  // Credentials that should never reach Discord.
  { name: "discord-token", re: /\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}\b/g, replace: "[REDACTED-SECRET]" },
  { name: "api-key", re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED-SECRET]" },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, replace: "[REDACTED-SECRET]" },
];

export interface RedactResult {
  text: string;
  hits: Record<string, number>;
}

export function redact(input: string): RedactResult {
  let text = input;
  const hits: Record<string, number> = {};
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: string[]) => {
      hits[rule.name] = (hits[rule.name] ?? 0) + 1;
      return typeof rule.replace === "string" ? rule.replace : rule.replace(...args);
    });
  }
  return { text, hits };
}
