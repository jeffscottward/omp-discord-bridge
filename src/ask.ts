// Interactive questions for Discord runs (owner request 2026-10-13).
// `omp -p` does not offer OMP's `ask` tool (verified 2026-10-13: the tool list has no `ask` in
// print mode), so a run asks by ending its answer with a fenced ```ask block of JSON:
//   ```ask
//   {"questions":[{"id":"scope","question":"Which names?","options":["All","Chips only"],"multi":false}]}
//   ```
// The bridge strips the block, posts one message per question with a select menu, collects the
// owner's picks and, once every question is answered, sends them back as the owner's next turn in
// the same session ("Answers: …"). Only the owner can answer. Pending sets live in memory and expire.

export interface AskQuestion {
  id: string;
  question: string;
  options: string[];
  /** Index of the recommended option (owner 2026-10-14: show "(Recommended)" like OMP). */
  recommended?: number;
  multi: boolean;
}
export interface AskSet {
  setId: string;
  channelId: string;
  questions: AskQuestion[];
  answers: Record<string, string[]>;
  createdAt: number;
}

const BLOCK = /^ {0,3}```ask[ \t]*\n([\s\S]*?)\n {0,3}```[ \t]*$/m;
export const ASK_PREFIX = "ask:";
export const ASK_TTL_MS = 24 * 60 * 60_000;
const MAX_Q = 5; // one action row each; Discord allows 5 rows per message, we post one message per question
const MAX_OPT = 25; // Discord select-menu limit

/** Pull an ```ask block out of an answer. Invalid JSON stays in the text (visible to the owner). */
export function extractAsk(text: string): { text: string; questions: AskQuestion[] | null; error?: string } {
  const m = text.match(BLOCK);
  if (!m) return { text, questions: null };
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return { text, questions: null, error: "ask block is not valid JSON" };
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const list = Array.isArray(raw) ? raw : isObj(raw) ? raw.questions : undefined;
  if (!Array.isArray(list) || !list.length) return { text, questions: null, error: "ask block has no questions" };
  const questions: AskQuestion[] = [];
  for (const [i, q] of list.slice(0, MAX_Q).entries()) {
    if (!isObj(q)) return { text, questions: null, error: `question ${i + 1} is not an object` };
    const o = q;
    const question = String(o.question ?? "").trim().slice(0, 150);
    const options = Array.isArray(o.options)
      ? [...new Set(o.options.map((x) => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, MAX_OPT)
      : [];
    if (!question || options.length < 2) return { text, questions: null, error: `question ${i + 1} needs text and at least 2 options` };
    // Recommended: explicit "recommended" index, or an option text ending in "(Recommended)" (tag stripped).
    let recommended = typeof o.recommended === "number" && o.recommended >= 0 && o.recommended < options.length ? o.recommended : undefined;
    const tag = /\s*\((?:recommended)\)\s*$/i;
    options.forEach((x, k) => {
      if (tag.test(x)) {
        options[k] = x.replace(tag, "");
        recommended ??= k;
      }
    });
    questions.push({ id: String(o.id ?? `q${i + 1}`).slice(0, 40), question, options, multi: o.multi === true, ...(recommended !== undefined ? { recommended } : {}) });
  }
  return { text: text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim(), questions };
}

/** Owner's answers as the next turn's text. */
/** "✏️ Other (type a reply)"-style options open a text pop-up instead of being picked as-is. */
export const isOtherOption = (o: string): boolean => /^(✏️\s*)?other\b/i.test(o.trim());

export function answersText(set: AskSet): string {
  const lines = set.questions.map((q) => `- ${q.question} → ${(set.answers[q.id] ?? []).join(", ")}`);
  return ["[Answers to your questions, picked in Discord]", ...lines].join("\n");
}

export class AskStore {
  private sets = new Map<string, AskSet>();
  private n = 0;

  create(channelId: string, questions: AskQuestion[], now = Date.now()): AskSet {
    this.prune(now);
    const setId = `${now.toString(36)}${(this.n++).toString(36)}`;
    const set: AskSet = { setId, channelId, questions, answers: {}, createdAt: now };
    this.sets.set(setId, set);
    return set;
  }

  /** customId for question index `qi` of a set. */
  static customId(setId: string, qi: number): string {
    return `${ASK_PREFIX}${setId}:${qi}`;
  }

  /**
   * Record a pick. Returns the set when this pick completed it (it is then removed), "partial"
   * while questions remain, or "unknown" for an expired/unknown set or bad index/values.
   */
  answer(customId: string, values: string[], now = Date.now(), freeText?: string): AskSet | "partial" | "unknown" {
    this.prune(now);
    const m = customId.slice(ASK_PREFIX.length).match(/^([a-z0-9]+):(\d+)$/);
    const set = m ? this.sets.get(m[1]!) : undefined;
    const q = set?.questions[Number(m?.[2])];
    if (!set || !q) return "unknown";
    const picked = values.map((v) => q.options[Number(v)]).filter((x): x is string => x !== undefined);
    if (freeText?.trim()) picked.push(`Other: ${freeText.trim().slice(0, 1000)}`);
    if (!picked.length || (!q.multi && picked.length > 1)) return "unknown";
    set.answers[q.id] = picked;
    if (set.questions.every((x) => set.answers[x.id]?.length)) {
      this.sets.delete(set.setId);
      return set;
    }
    return "partial";
  }

  /** The open question behind a customId prefix ("ask:<set>:<qi>"), or null. */
  question(customId: string, now = Date.now()): AskQuestion | null {
    this.prune(now);
    const m = customId.slice(ASK_PREFIX.length).match(/^([a-z0-9]+):(\d+)$/);
    return (m && this.sets.get(m[1]!)?.questions[Number(m[2])]) || null;
  }

  private prune(now: number): void {
    for (const [k, s] of this.sets) if (now - s.createdAt > ASK_TTL_MS) this.sets.delete(k);
  }
}
