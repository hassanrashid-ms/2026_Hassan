// backend/src/domain/bot/grounding.ts

/**
 * The server-side backstop on "answer in the article's own words".
 *
 * The prompt asks the model to reuse the article's wording and only re-aim it at
 * what the player asked. A prompt cannot enforce that. This repo already has the
 * scar: the handoff instruction told the model to *say* it was transferring, and
 * the model wrote the sentence instead of calling the tool, for weeks, until the
 * seam was made structural. Grounding is the same class of promise, with a worse
 * failure mode — a fabricated refund window or support timeline reads exactly
 * like a real one, and the player acts on it.
 *
 * So the rule is checked where it cannot be talked out of: every content word the
 * bot is about to say must already appear in the article it cited or in what the
 * player themselves wrote. Those two sources are the whole permitted vocabulary,
 * and together they are exactly the brief — the article supplies the substance,
 * the player's own words let the answer address *their* situation by name.
 *
 * Deliberately lenient about grammar and deliberately strict about numbers. It
 * exists to catch invented facts, not to police inflection: a false rejection
 * costs a tool call and, at worst, ends the turn in a handoff, which is a safe
 * outcome. A false acceptance puts a made-up promise in front of a player.
 */

/**
 * Ignored entirely: they carry no claim, so requiring the article to contain
 * them would reject ordinary sentence-building rather than fabrication. Kept to
 * function words on purpose — anything with meaning stays in the denominator.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'here',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'may',
  'might',
  'more',
  'must',
  'need',
  'no',
  'not',
  'of',
  'off',
  'on',
  'once',
  'one',
  'only',
  'or',
  'other',
  'our',
  'out',
  'own',
  'please',
  'same',
  'see',
  'should',
  'so',
  'some',
  'still',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'too',
  'up',
  'use',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  // Acknowledgements and greetings: they state nothing about the game, so an
  // article cannot be expected to contain them, and counting them would make a
  // polite answer look fabricated.
  'hello',
  'hey',
  'okay',
  'sorry',
  'sure',
  'thank',
  'thanks',
  'yes',
  'yeah',
]);

/** Below this share of grounded content words the answer is refused. */
export const MIN_GROUNDED_FRACTION = 0.9;

/**
 * Long enough that a shared prefix implies a shared root rather than a
 * coincidence — "refund"/"refuse" diverge at five, "receive"/"receiving" do not.
 */
const PREFIX_LENGTH = 5;

/** Words shorter than this are too collision-prone to match on a prefix. */
const MIN_PREFIX_TOKEN = 5;

const isNumeric = (token: string): boolean => /\d/.test(token);

/**
 * The length floor drops "an", "is", "to" — noise that would only inflate the
 * score. It must never drop a number: "48" is two characters and is exactly the
 * kind of claim this check exists to catch, so anything containing a digit is
 * kept whatever its length. (It did drop them, once, which made the numeric
 * strictness below unreachable — see tests/bot.grounding.test.ts.)
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && (t.length > 2 || isNumeric(t)) && !STOPWORDS.has(t));
}

/**
 * Singular and plural are the same claim. Nothing more aggressive than this —
 * a real stemmer would start collapsing words that mean different things.
 */
function normalize(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

export type GroundingResult = {
  /** Share of the answer's content words found in the sources; 1 when it has none. */
  score: number;
  /** The words that were not, capped for logging. These are what to look at first. */
  ungrounded: string[];
};

/**
 * `sources` is the cited article (title and body) plus the player's own messages
 * — see the file comment for why those two and nothing else.
 */
export function scoreGrounding(answer: string, sources: string[]): GroundingResult {
  const vocabulary = new Set<string>();
  const prefixes = new Set<string>();
  for (const source of sources) {
    for (const raw of tokenize(source)) {
      const token = normalize(raw);
      vocabulary.add(token);
      if (token.length >= MIN_PREFIX_TOKEN) prefixes.add(token.slice(0, PREFIX_LENGTH));
    }
  }

  const answerTokens = tokenize(answer).map(normalize);
  // An answer made entirely of function words states no fact, so there is
  // nothing here to have fabricated. Scoring 0/0 as ungrounded would refuse
  // "Yes, you can — see below." for saying nothing wrong.
  if (answerTokens.length === 0) return { score: 1, ungrounded: [] };

  const ungrounded: string[] = [];
  for (const token of answerTokens) {
    if (vocabulary.has(token)) continue;
    // No prefix leniency for anything containing a digit: an amount, a count or
    // a duration that the article does not state is the single most damaging
    // thing the bot can invent, and "48" must never be grounded by "24".
    if (
      !isNumeric(token) &&
      token.length >= MIN_PREFIX_TOKEN &&
      prefixes.has(token.slice(0, PREFIX_LENGTH))
    )
      continue;
    ungrounded.push(token);
  }

  return {
    score: (answerTokens.length - ungrounded.length) / answerTokens.length,
    ungrounded: [...new Set(ungrounded)].slice(0, 10),
  };
}

export function isGrounded(result: GroundingResult): boolean {
  return result.score >= MIN_GROUNDED_FRACTION;
}
