// Understanding short spoken replies in voice mode (owner request 2026-10-13).
// Only two things are recognised: which numbered options the owner picked, and whether they want
// the questions read out or posted. Everything else is deliberately left alone and treated as a
// normal free-text message.

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  // Whisper homophones for short utterances.
  to: 2, too: 2, for: 4,
};

/** Words that may sit between numbers without making it a free-text reply. */
const FILLER: Record<string, true> = {
  and: true, the: true, a: true, an: true, number: true, numbers: true, option: true,
  options: true, answer: true, answers: true, please: true, ok: true, okay: true, yeah: true,
  yep: true, um: true, uh: true, er: true, both: true, all: true, of: true, them: true,
  then: true, plus: true, also: true, no: true, nope: true,
};

/**
 * "two and three" → [2, 3]; "number 4" → [4]; "first" → [1].
 * Returns null when the utterance is anything other than numbers plus filler, which the caller
 * treats as a free-text reply. Numbers are 1-based, as spoken.
 */
export function parseSpokenNumbers(text: string): number[] | null {
  const tokens = text.toLowerCase().match(/[a-z]+|\d+/g);
  if (!tokens) return null;
  const out: number[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n < 1 || n > 25) return null;
      out.push(n);
      continue;
    }
    const n = NUMBERS[t];
    if (n !== undefined) {
      out.push(n);
      continue;
    }
    if (!FILLER[t]) return null;
  }
  return out.length ? [...new Set(out)] : null;
}

/**
 * The answer to "Read them out, or post them?". null = neither, so it is a free-text reply.
 */
export function spokenIntent(text: string): "post" | "read" | null {
  const t = text.toLowerCase();
  // Only a short reply is an answer to "Read them out, or post them?"; a longer turn is a new
  // request (a 367-char request containing "send" was once swallowed as "post").
  if (t.split(/\s+/).filter(Boolean).length > 6) return null;
  if (/\b(post|type|write|show|send)\b/.test(t)) return "post";
  if (/\b(read|aloud|out loud|say|speak|tell)\b/.test(t)) return "read";
  return null;
}
