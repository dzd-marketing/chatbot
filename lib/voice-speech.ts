/**
 * Helpers for voice conversations (components/chat/voice-call.tsx): which
 * of the device's built-in voices to speak with, turning a reply into
 * speakable text, and cutting a streaming reply into sentences so speaking
 * can start before the whole reply has arrived.
 */

export type CallLanguage = "en-IN" | "si-LK" | "ta-LK";

/* ----------------------------------------------------------------- voices */

/** Well-known female voices across Chrome, Edge, Safari/iOS and Android. */
const FEMALE_NAMES =
  /\b(female|woman|aria|jenny|sonia|libby|neerja|ava|allison|samantha|susan|karen|moira|tessa|serena|veena|isha|fiona|victoria|zira|hazel|heera|kalpana|natasha|clara|emma|michelle|ana|joanna|kendra|kimberly|salli|amy|olivia|zoe|nicky|catherine|siri female|pallavi|valluvar female|thilini|sinhala female)\b/i;
const MALE_NAMES =
  /\b(male|man|david|mark|george|daniel|alex|fred|rishi|ravi|guy|ryan|tom|aaron|arthur|gordon|james|thomas|oliver|lee|prabhat|hemant|valluvar|eddy|reed|rocko|grandpa|ralph|albert|bruce|junior)\b/i;
const NATURAL = /natural|neural|premium|enhanced|online/i;

const languagePrefix = (lang: CallLanguage) => lang.slice(0, 2);
const normalizeLang = (lang: string) => lang.replace("_", "-").toLowerCase();

/**
 * The most natural-sounding female voice the device has for `lang`, or
 * null when it has none (for example iPhones have no Sinhala voice).
 */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang: CallLanguage
): SpeechSynthesisVoice | null {
  const prefix = languagePrefix(lang);
  const candidates = voices.filter((voice) =>
    normalizeLang(voice.lang).startsWith(prefix)
  );
  if (candidates.length === 0) {
    return null;
  }
  const wanted = lang.toLowerCase();
  const score = (voice: SpeechSynthesisVoice) => {
    const name = `${voice.name} ${voice.voiceURI}`;
    const female = FEMALE_NAMES.test(name);
    let value = 0;
    if (female) {
      value += 6;
    } else if (MALE_NAMES.test(name)) {
      value -= 12;
    }
    if (NATURAL.test(name)) {
      value += 3;
    }
    // Google's network voices sound far better than the offline ones.
    if (/google/i.test(name)) {
      value += 2;
    }
    const voiceLang = normalizeLang(voice.lang);
    if (voiceLang === wanted) {
      value += 2;
    } else if (prefix === "en" && /en-(us|gb)/.test(voiceLang)) {
      value += 1;
    }
    if (voice.default) {
      value += 0.5;
    }
    return value;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/* ------------------------------------------------------- speakable text */

const SUPERSCRIPTS: Record<string, string> = {
  "²": " squared",
  "³": " cubed",
};

/**
 * Plain text for a text-to-speech voice: no markdown, links, code, emoji or
 * LaTeX, with a few symbols said in words.
 */
export function toSpeakable(markdown: string) {
  return (
    markdown
      // Code blocks are not read out.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      // Display and inline maths: keep the content without the markup.
      .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
      .replace(/\$([^$\n]+)\$/g, "$1")
      .replace(/\\\(|\\\)|\\\[|\\\]/g, " ")
      .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1 over $2")
      .replace(/\\sqrt\{([^}]*)\}/g, "the square root of $1")
      .replace(/\\(times|cdot)/g, " times ")
      .replace(/\\div/g, " divided by ")
      .replace(/\\pm/g, " plus or minus ")
      .replace(/\\(le|leq)\b/g, " less than or equal to ")
      .replace(/\\(ge|geq)\b/g, " greater than or equal to ")
      .replace(
        /\\(alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|Delta|Omega)\b/g,
        " $1 "
      )
      .replace(/\\[a-zA-Z]+/g, " ")
      .replace(/\^2\b/g, " squared")
      .replace(/\^3\b/g, " cubed")
      .replace(/[²³]/g, (match) => SUPERSCRIPTS[match] ?? match)
      // Links and images: keep the label, drop the address.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      // Headings, quotes, list markers, tables, emphasis.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+•]\s+/gm, "")
      .replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, " ")
      .replace(/\|/g, ", ")
      .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
      .replace(/[*_#~]/g, "")
      // Emoji and other pictographs.
      .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
      // Headings and list items end without a full stop: add a pause.
      .replace(/([^\s.!?…:;,])[ \t]*\n+/g, "$1. ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/* --------------------------------------------------------------- sentences */

/** Sentence ends: . ! ? … plus the Sinhala/Tamil full stop "।" when used. */
const SENTENCE_END = /[.!?…।]+["'”’)\]]*(?=\s|$)/g;
/** Long sentences are also cut at a comma so the voice starts sooner. */
const SOFT_LIMIT = 220;

/**
 * Splits text into sentences. With `complete: false` (the reply is still
 * streaming) the unfinished last sentence is left out.
 */
export function splitSentences(text: string, complete: boolean) {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    pushSentence(sentences, text.slice(start, end));
    start = end;
  }
  let rest = text.slice(start);
  // A very long unfinished sentence: speak up to its last comma already.
  if (!complete && rest.length > SOFT_LIMIT) {
    const comma = rest.lastIndexOf(", ", SOFT_LIMIT);
    if (comma > 40) {
      pushSentence(sentences, rest.slice(0, comma + 1));
      rest = rest.slice(comma + 1);
    }
  }
  if (complete) {
    pushSentence(sentences, rest);
  }
  return sentences;
}

function pushSentence(sentences: string[], raw: string) {
  const sentence = raw.trim();
  if (/[\p{L}\p{N}]/u.test(sentence)) {
    sentences.push(sentence);
  }
}

/* ------------------------------------------------------------ backchannel */

/**
 * Short listening sounds the assistant makes while the student pauses
 * mid-thought, like a person on a call ("mm-hmm"). Sounds a recogniser
 * hears back from the speaker are removed from the student's words.
 */
export const BACKCHANNELS: Record<CallLanguage, readonly string[]> = {
  // Hum sounds only: removing a heard-back "okay" or "right" could delete
  // words the student really said.
  "en-IN": ["Mm-hmm.", "Mhm.", "Uh-huh."],
  "si-LK": ["හ්ම්.", "ඔව්.", "හරි."],
  "ta-LK": ["ம்ம்.", "சரி.", "ஆமா."],
};

/** What a recogniser may write when it hears a backchannel. */
const ECHO_PATTERNS: Record<CallLanguage, RegExp> = {
  "en-IN": /(^|\s)(m+-?h+m+|mhm+|hmm+|mm+|uh-?huh)[.!?,]*(?=\s|$)/i,
  "si-LK": /(^|\s)(හ්ම්|හ්ම|ඔව්|හරි)[.!?,]*(?=\s|$)/,
  "ta-LK": /(^|\s)(ம்ம்|சரி|ஆமா)[.!?,]*(?=\s|$)/,
};

/**
 * Removes up to `count` backchannel echoes from the student's words, from
 * the end backwards (echoes come after the speech they answered).
 */
export function removeBackchannelEchoes(
  text: string,
  lang: CallLanguage,
  count: number
) {
  let result = text;
  const pattern = ECHO_PATTERNS[lang];
  for (let removed = 0; removed < count; removed += 1) {
    const words = result.split(/\s+/);
    let index = -1;
    for (let position = words.length - 1; position >= 0; position -= 1) {
      if (pattern.test(` ${words[position]}`)) {
        index = position;
        break;
      }
    }
    if (index === -1) {
      break;
    }
    words.splice(index, 1);
    result = words.join(" ");
  }
  return result.replace(/\s+/g, " ").trim();
}
