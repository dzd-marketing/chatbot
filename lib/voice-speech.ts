/**
 * Helpers for voice conversations (components/chat/voice-call.tsx): which
 * of the device's built-in voices to speak with, turning a reply into
 * speakable text, and cutting a streaming reply into sentences so speaking
 * can start before the whole reply has arrived.
 */

import { plainCharacters } from "./voice-pronounce";

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

const ENTITIES: Record<string, string> = {
  "#39": "'",
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/**
 * Plain text for a text-to-speech voice: no markdown, links, code, emoji or
 * LaTeX, with a few symbols said in words.
 */
export function toSpeakable(markdown: string) {
  return (
    plainCharacters(markdown)
      // HTML entities ("&amp;") would be read letter by letter.
      .replace(
        /&(amp|lt|gt|quot|apos|nbsp|#39);/g,
        (_m, name: string) => ENTITIES[name] ?? " "
      )
      .replace(/&#(\d{2,5});/g, (_m, code: string) =>
        String.fromCodePoint(Number(code))
      )
      // Code blocks are not read out.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      // Display and inline maths: keep the content without the markup.
      .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
      .replace(/\$([^$\n]+)\$/g, "$1")
      .replace(/\\\(|\\\)|\\\[|\\\]/g, " ")
      // Chemistry and text inside maths: \\ce{CO2} -> CO2.
      .replace(
        /\\(?:ce|pu|text|textrm|textbf|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g,
        "$1"
      )
      .replace(/\\[,;:!]|\\q?quad\b/g, " ")
      // Reaction arrows: "->[light]" -> "with light gives".
      .replace(/\s*-+>\s*\[([^\]]+)\]\s*/g, " with $1 gives ")
      .replace(
        /\s*(?:<=>|<->|\\rightleftharpoons|⇌)\s*/g,
        " is in balance with "
      )
      .replace(/\s*(?:-+>|\\(?:long)?rightarrow\b|\\to\b|→|⟶)\s*/g, " gives ")
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
      .replace(/[{}]/g, "")
      .replace(/\^2\b/g, " squared")
      .replace(/\^3\b/g, " cubed")
      .replace(/[²³]/g, (match) => SUPERSCRIPTS[match] ?? match)
      // Stage directions ("[laughs]", "*smiles*") would be read out.
      .replace(
        /[[(*]\s*(?:laughs?|laughing|chuckles?|giggles?|sighs?|smiles?|grins?|gasps?|whispers?|pauses?|excited(?:ly)?|clears throat|winks?|nods?)\s*[\])*]/gi,
        " "
      )
      // Links and images: keep the label, drop the address.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      // Headings, quotes, list markers, tables, emphasis.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+•]\s+/gm, "")
      .replace(/^\s*\d{1,2}[.)]\s+/gm, "")
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

type MessageLike = {
  role: string;
  parts: readonly ({ type: string } & { text?: unknown })[];
};

/**
 * The first `words` words of the last reply as it was spoken: what the
 * student heard before interrupting (undefined if they didn't).
 */
export function heardOfLastReply(
  messages: readonly MessageLike[],
  words: number | undefined
) {
  if (words === undefined) {
    return;
  }
  const reply = messages.findLast((message) => message.role === "assistant");
  const text = toSpeakable(
    (reply?.parts ?? [])
      .map((part) =>
        part.type === "text" && typeof part.text === "string" ? part.text : ""
      )
      .filter(Boolean)
      .join("\n\n")
  );
  return text.split(/\s+/).filter(Boolean).slice(0, words).join(" ");
}

/* --------------------------------------------------------------- sentences */

/** Sentence ends: . ! ? … plus the Sinhala/Tamil full stop "।" when used. */
const SENTENCE_END = /[.!?…।]+["'”’)\]]*(?=\s|$)/g;
/**
 * A full stop that may not end the sentence yet while the reply streams:
 * "3." (maybe "3.14"), "Mr.", "e.g.".
 */
const MAYBE_UNFINISHED =
  /(?:\d|\b(?:Mr|Mrs|Ms|Dr|St|No|vs|etc|approx|e\.g|i\.e))\.$/i;
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
    // Still streaming: "3." may be the start of "3.14", wait for more.
    // Other sentence ends are spoken at once, e.g. "Give me a sec, I'll
    // check online." while the search runs.
    if (!complete && end === text.length && MAYBE_UNFINISHED.test(text)) {
      break;
    }
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

/* ------------------------------------------------------- spoken length */

/**
 * How much of a reply is spoken before the rest is left to the chat. Voice
 * replies are written short (see the speaking skills), so this only cuts
 * replies that ran long; short sentences don't count against it much.
 */
const SPOKEN_WORD_LIMIT = 50;
const SPOKEN_SENTENCE_LIMIT = 5;
/** A closing question ("Want me to go on?") may go a little over. */
const QUESTION_GRACE_WORDS = 15;

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Said when a long reply is cut short in speech (the chat has more):
 * friendly and varied, like a friend would say it.
 */
export const MORE_IN_CHAT: Record<CallLanguage, readonly string[]> = {
  "en-IN": [
    "I've put the rest in the chat, so have a look when you're ready.",
    "There's a bit more in the chat if you want it.",
    "That's the main idea. The full thing is in the chat for you.",
    "I'll stop there. Check the chat if you want the rest, okay?",
    "The rest is waiting in the chat whenever you need it.",
  ],
  "si-LK": [
    "ඉතුරු ටික මම chat එකේ දැම්මා, බලන්නකෝ.",
    "තව ටිකක් chat එකේ තියෙනවා, ඕන නම් බලන්න.",
    "ප්‍රධාන අදහස ඒක තමයි. සම්පූර්ණ එක chat එකේ තියෙනවා.",
  ],
  "ta-LK": [
    "மீதியை chat-இல் போட்டிருக்கேன், பாருங்க.",
    "இன்னும் கொஞ்சம் chat-இல் இருக்கு, வேணும்னா பாருங்க.",
    "முக்கியமான விஷயம் இதுதான். முழுசா chat-இல் இருக்கு.",
  ],
};

/** The same pick for the same reply, so it doesn't change as it streams. */
export function pickFor<T>(options: readonly T[], seed: string): T {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  }
  return options[hash % options.length];
}

/**
 * What is spoken of a reply: whole sentences up to about 40 words and three
 * sentences (always at least one), then a pointer to the chat if there is
 * more. The result
 * only ever grows as the reply streams in, so speaking can start early.
 * `capped` means the spoken part is final even if the reply isn't.
 */
export function spokenPart(
  text: string,
  complete: boolean,
  lang: CallLanguage
) {
  const sentences = splitSentences(text, complete);
  let words = 0;
  let end = 0;
  let searchFrom = 0;
  for (const [index, sentence] of sentences.entries()) {
    const at = text.indexOf(sentence, searchFrom);
    const sentenceWords = countWords(sentence);
    // Usually the reply's last sentence (it may still be streaming).
    const closingQuestion =
      sentence.endsWith("?") &&
      sentenceWords <= QUESTION_GRACE_WORDS &&
      words + sentenceWords <= SPOKEN_WORD_LIMIT + QUESTION_GRACE_WORDS;
    if (
      index > 0 &&
      !closingQuestion &&
      (words + sentenceWords > SPOKEN_WORD_LIMIT ||
        index >= SPOKEN_SENTENCE_LIMIT)
    ) {
      const spoken = text.slice(0, end).trim();
      return {
        capped: true,
        text: `${spoken} ${pickFor(MORE_IN_CHAT[lang], spoken)}`,
      };
    }
    words += sentenceWords;
    end = (at === -1 ? searchFrom : at) + sentence.length;
    searchFrom = end;
  }
  return { capped: false, text };
}

/* ------------------------------------------------------------ backchannel */

/**
 * Listening sounds the assistant makes while the student talks, the way a
 * person on a call does:
 * - `continue`: short "go on" sounds on a small pause mid-thought;
 * - `acknowledge`: after the student has made a longer point;
 * - `encourage`: when they hesitate ("umm…") and pause, to say it's fine.
 */
export type BackchannelKind = "continue" | "acknowledge" | "encourage";

export const BACKCHANNELS: Record<
  CallLanguage,
  Record<BackchannelKind, readonly string[]>
> = {
  "en-IN": {
    acknowledge: ["Okay.", "Right.", "I see.", "Got it."],
    continue: ["Mm-hmm.", "Mhm.", "Uh-huh.", "Yeah."],
    encourage: ["Take your time.", "Mm-hmm, go on."],
  },
  "si-LK": {
    acknowledge: ["හරි.", "ආ හරි.", "ඔව් ඔව්."],
    continue: ["හ්ම්.", "ඔව්.", "හ්ම් හ්ම්."],
    encourage: ["හ්ම්, කියන්න.", "කමක් නෑ, කියන්න."],
  },
  "ta-LK": {
    acknowledge: ["சரி.", "ஓ சரி.", "புரியுது."],
    continue: ["ம்ம்.", "ஆமா.", "ம்ம் ம்ம்."],
    encourage: ["ம்ம், சொல்லுங்க.", "பரவாயில்ல, சொல்லுங்க."],
  },
};

/** Hesitation sounds as recognisers write them. */
const FILLER =
  /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+|mm+|ම්+|හ්ම්|අ+|ඒ+|ම්ම්|ம்+|அ+|ஆ+|ஏ+)$/i;
/** Words that mean the sentence isn't finished yet. */
const CONTINUING: Record<CallLanguage, RegExp> = {
  "en-IN":
    /^(and|but|so|because|or|then|like|the|a|an|to|of|in|is|was|if|that|which|when|with|for|about|my|i|we|it's|also|actually|basically)$/i,
  "si-LK": /^(සහ|හා|ඒත්|නමුත්|ඉතින්|නිසා|වගේ|කියලා|එතකොට|ඊට|පස්සේ|හරි|එහෙම|ඒ|මේ|මම|අපි)$/,
  "ta-LK": /^(மற்றும்|ஆனா|ஆனால்|அப்புறம்|அதனால|அதனால்|ஏன்னா|மாதிரி|என்று|அது|இது|நான்|நாம)$/,
};
/** Question words at the end of a sentence (the student wants an answer). */
const QUESTION_END: Record<CallLanguage, RegExp> = {
  "en-IN": /^(right|okay|why|how|what|correct|yes|no)$/i,
  "si-LK": /(ද|නේද|මොකක්ද|කොහොමද|ඇයි|කවදාද|කොහෙද|කීයද|පුළුවන්ද)$/,
  "ta-LK": /^(என்ன|ஏன்|எப்படி|எப்போ|எங்கே|யார்|எவ்வளவு|சரியா|தெரியுமா|முடியுமா)$/,
};
const QUESTION_START =
  /^((so|and|but|okay|ok|then|also|wait|um+|uh+)[\s,]+)*(what|why|how|when|where|which|who|whose|can|could|would|will|is|are|am|was|were|do|does|did|should|shall|tell|explain)\b/i;

const lastWords = (text: string, count: number) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .slice(-count)
    .map((word) => word.replace(/[.,!?;:…"'“”]+/g, ""));

/** The student trails off with "umm" or "hmm". */
export function endsWithFiller(text: string) {
  const [last] = lastWords(text, 1);
  return last !== undefined && FILLER.test(last);
}

/** The student is mid-sentence ("…and", "…because", "…umm"). */
export function soundsUnfinished(text: string, lang: CallLanguage) {
  const [last] = lastWords(text, 1);
  return (
    last !== undefined && (FILLER.test(last) || CONTINUING[lang].test(last))
  );
}

/** The student has asked something and is waiting for the answer. */
export function soundsLikeQuestion(text: string, lang: CallLanguage) {
  const trimmed = text.trim();
  if (/[?？]$/.test(trimmed)) {
    return true;
  }
  const [last] = lastWords(trimmed, 1);
  if (last && QUESTION_END[lang].test(last) && lang !== "en-IN") {
    return true;
  }
  if (lang === "en-IN") {
    // The current sentence starts like a question.
    const sentence = trimmed.split(/[.!?]\s+/).at(-1) ?? trimmed;
    return QUESTION_START.test(sentence) && countWords(sentence) >= 3;
  }
  return false;
}

/** Normalises a word for echo matching (case, punctuation, hum spelling). */
function echoKey(word: string) {
  const plain = word.toLowerCase().replace(/[.,!?;:…"'“”]+/g, "");
  if (/^(m+-?h*m+|mhm+|hmm+|uh-?huh|mm+)$/.test(plain)) {
    return "~hum";
  }
  return plain;
}

export type PlayedBackchannel = {
  phrase: string;
  /** Words the student had said when it played. */
  atWord: number;
};

/**
 * Removes the assistant's own listening sounds where the microphone heard
 * them back: only right after the point each one played, so the student's
 * own "okay" elsewhere stays.
 */
export function removeBackchannelEchoes(
  text: string,
  played: readonly PlayedBackchannel[]
) {
  const words = text.split(/\s+/).filter(Boolean);
  // Latest first, so earlier positions stay valid.
  for (const { phrase, atWord } of [...played].reverse()) {
    const target = phrase.split(/\s+/).map(echoKey).filter(Boolean);
    if (target.length === 0) {
      continue;
    }
    const from = Math.max(0, atWord - 1);
    const to = Math.min(words.length - target.length, atWord + 6);
    for (let start = from; start <= to; start += 1) {
      const matches = target.every(
        (key, offset) => echoKey(words[start + offset] ?? "") === key
      );
      if (matches) {
        words.splice(start, target.length);
        break;
      }
    }
  }
  return words.join(" ");
}
