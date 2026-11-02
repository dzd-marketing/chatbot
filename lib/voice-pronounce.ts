/**
 * English text as it should be *said*, for the custom voice (Kyutai Pocket
 * TTS). The voice model has no text normalisation of its own: digits,
 * symbols, slashes and acronyms make it guess, mispronounce ("A/L" came
 * out as "A I L L") or skip words. This turns them into plain words:
 * "A/L" -> "A Level", "Rs. 1,500" -> "one thousand five hundred rupees",
 * "45%" -> "forty-five percent",
 * "2026" -> "twenty twenty-six", "10:30 am" -> "ten thirty a m".
 *
 * Only what is spoken changes; the chat keeps the original text.
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const SCALES: [number, string][] = [
  [1_000_000_000_000, "trillion"],
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1000, "thousand"],
];

function underHundred(n: number) {
  if (n < 20) {
    return ONES[n];
  }
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 ? `${tens}-${ONES[n % 10]}` : tens;
}

function underThousand(n: number) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) {
    return underHundred(rest);
  }
  const head = `${ONES[hundreds]} hundred`;
  return rest ? `${head} and ${underHundred(rest)}` : head;
}

/** 1534 -> "one thousand five hundred and thirty-four". */
export function numberToWords(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (value < 0) {
    return `minus ${numberToWords(-value)}`;
  }
  let n = Math.floor(value);
  if (n === 0) {
    return "zero";
  }
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) {
      parts.push(`${underThousand(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n) {
    // "one thousand and five", like people say it.
    parts.push(
      parts.length && n < 100 ? `and ${underHundred(n)}` : underThousand(n)
    );
  }
  return parts.join(" ");
}

const ORDINAL_WORDS: Record<string, string> = {
  eight: "eighth",
  five: "fifth",
  nine: "ninth",
  one: "first",
  three: "third",
  twelve: "twelfth",
  two: "second",
};

/** 21 -> "twenty-first". */
export function ordinalToWords(value: number) {
  const words = numberToWords(value);
  return words.replace(/(\w+)$/, (last) => {
    if (ORDINAL_WORDS[last]) {
      return ORDINAL_WORDS[last];
    }
    if (last.endsWith("y")) {
      return `${last.slice(0, -1)}ieth`;
    }
    return `${last}th`;
  });
}

/** 2026 -> "twenty twenty-six", 2005 -> "two thousand and five". */
function yearToWords(year: number) {
  if (year >= 2000 && year < 2010) {
    return numberToWords(year);
  }
  const head = Math.floor(year / 100);
  const tail = year % 100;
  if (tail === 0) {
    return `${numberToWords(head)} hundred`;
  }
  const tailWords = tail < 10 ? `oh ${ONES[tail]}` : underHundred(tail);
  return `${numberToWords(head)} ${tailWords}`;
}

const digitsToWords = (digits: string) =>
  [...digits].map((digit) => ONES[Number(digit)] ?? digit).join(" ");

/** "3.14" -> "three point one four"; "1,500" -> "one thousand five hundred". */
function plainNumber(raw: string) {
  const [whole, fraction] = raw.replace(/,/g, "").split(".");
  // Long digit strings (phone numbers, codes) are read digit by digit.
  if (whole.length > 12 || (whole.length >= 7 && !raw.includes(","))) {
    return digitsToWords(whole);
  }
  const words = numberToWords(Number(whole));
  return fraction ? `${words} point ${digitsToWords(fraction)}` : words;
}

/* ------------------------------------------------------------------ units */

/** [singular, plural] spoken after a number. */
const UNITS: Record<string, [string, string]> = {
  "%": ["percent", "percent"],
  cm: ["centimetre", "centimetres"],
  GB: ["gigabyte", "gigabytes"],
  GHz: ["gigahertz", "gigahertz"],
  g: ["gram", "grams"],
  Hz: ["hertz", "hertz"],
  h: ["hour", "hours"],
  hrs: ["hours", "hours"],
  J: ["joule", "joules"],
  KB: ["kilobyte", "kilobytes"],
  kg: ["kilogram", "kilograms"],
  kHz: ["kilohertz", "kilohertz"],
  kJ: ["kilojoule", "kilojoules"],
  km: ["kilometre", "kilometres"],
  "km/h": ["kilometre per hour", "kilometres per hour"],
  kmph: ["kilometre per hour", "kilometres per hour"],
  kW: ["kilowatt", "kilowatts"],
  L: ["litre", "litres"],
  MB: ["megabyte", "megabytes"],
  MHz: ["megahertz", "megahertz"],
  m: ["metre", "metres"],
  "m/s": ["metre per second", "metres per second"],
  "m/s2": ["metre per second squared", "metres per second squared"],
  "m/s²": ["metre per second squared", "metres per second squared"],
  mg: ["milligram", "milligrams"],
  min: ["minute", "minutes"],
  mins: ["minutes", "minutes"],
  mL: ["millilitre", "millilitres"],
  ml: ["millilitre", "millilitres"],
  mm: ["millimetre", "millimetres"],
  mol: ["mole", "moles"],
  mph: ["mile per hour", "miles per hour"],
  N: ["newton", "newtons"],
  Pa: ["pascal", "pascals"],
  TB: ["terabyte", "terabytes"],
  V: ["volt", "volts"],
  W: ["watt", "watts"],
  "°": ["degree", "degrees"],
  "°C": ["degree Celsius", "degrees Celsius"],
  "°F": ["degree Fahrenheit", "degrees Fahrenheit"],
  Ω: ["ohm", "ohms"],
};
const UNIT_PATTERN = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length)
  .map((unit) => unit.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
  .join("|");

/* --------------------------------------------------------------- acronyms */

/** Said as a word, not letter by letter. */
const SAID_AS_WORDS = new Set([
  "AIDS",
  "ASEAN",
  "COVID",
  "FIFA",
  "LASER",
  "NASA",
  "NATO",
  "OPEC",
  "PIN",
  "RADAR",
  "RAM",
  "ROM",
  "SAARC",
  "SIM",
  "UNESCO",
  "UNICEF",
]);
/** Ordinary words sometimes written in capitals for emphasis. */
const CAPITALISED_WORDS = new Set([
  "ALL",
  "AND",
  "ANY",
  "ARE",
  "BUT",
  "CAN",
  "DO",
  "FOR",
  "GO",
  "HOW",
  "IF",
  "IS",
  "NEW",
  "NO",
  "NOT",
  "NOW",
  "OF",
  "ON",
  "OR",
  "SO",
  "THE",
  "TO",
  "UP",
  "WHY",
  "YES",
  "YOU",
]);
const SPOKEN_ACRONYMS: Record<string, string> = {
  AI: "A I",
  FAQ: "F A Q",
  GCE: "G C E",
  ICT: "I C T",
  MCQ: "M C Q",
  MCQs: "M C Qs",
  OK: "okay",
  PhD: "P H D",
  pH: "P H",
};

/* -------------------------------------------------------------- the rules */

type Rule = [RegExp, string | ((...match: string[]) => string)];

/** A number: 1,500 / 3.14 / 42 (not "1,2,3", which is a list). */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

const unitWords = (amount: string, unit: string) => {
  const forms = UNITS[unit];
  const negative = amount.startsWith("-");
  const value = amount.replace(/^-/, "");
  const said = `${negative ? "minus " : ""}${plainNumber(value)}`;
  return `${said} ${value === "1" ? forms[0] : forms[1]}`;
};

const withScale = (amount: string, scale?: string) =>
  `${plainNumber(amount)}${scale ? ` ${scale.trim().replace(/^k$/i, "thousand")}` : ""}`;

/** "6 p.m." may also end the sentence: keep its full stop. */
const endDot = (match: string) => (match.endsWith(".") ? "." : "");

/**
 * Unicode look-alikes the voice can't read, written by some models (for
 * example "step‑by‑step" with non-breaking hyphens, U+2011) -> plain
 * characters. Zero-width joiners stay: Sinhala and Tamil letters need them.
 */
const LOOK_ALIKES: [RegExp, string][] = [
  [/[\u00AD\u200B\u2060\uFEFF]/g, ""],
  // A thin or no-break space between digit groups is a thousands separator.
  [/(\d)[\u00A0\u2009\u202F](?=\d{3}(?!\d))/g, "$1,"],
  [/[\u2010\u2011\u2043\uFE63\uFF0D]/g, "-"],
  [/[\u2012\u2015]/g, "–"],
  [/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " "],
  [/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"'],
  [/\u2044/g, "/"],
  [/\u2026/g, "..."],
  [/½/g, " 1/2"],
  [/⅓/g, " 1/3"],
  [/⅔/g, " 2/3"],
  [/¼/g, " 1/4"],
  [/¾/g, " 3/4"],
];

/** Replaces look-alike Unicode punctuation and spaces with plain ones. */
export function plainCharacters(text: string) {
  let plain = text;
  for (const [pattern, replacement] of LOOK_ALIKES) {
    plain = plain.replace(pattern, replacement);
  }
  return plain;
}

const RULES: Rule[] = [
  // Sri Lankan exams.
  [
    /\b([AO])\s?\/\s?L(s)?\b/g,
    (_m, level, plural) => `${level} Level${plural ? "s" : ""}`,
  ],
  [
    /\b([AO])-[Ll]evel(s)?\b/g,
    (_m, level, plural) => `${level} Level${plural ?? ""}`,
  ],
  [/\bG\.\s?C\.\s?E\.?/g, "G C E"],
  // Abbreviations.
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\betc\./gi, "and so on."],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\.?(?=\s)/gi, "about"],
  [/\bDr\.(?=\s)/g, "Doctor"],
  [/\bMr\.(?=\s)/g, "Mister"],
  [/\bMrs\.(?=\s)/g, "Missus"],
  [/\bMs\.(?=\s)/g, "Miz"],
  [/\b[Nn]o\.\s?(?=\d)/g, "number "],
  [/\band\/or\b/gi, "and or"],
  // Money.
  [
    new RegExp(
      String.raw`\b(?:Rs\.?|LKR)\s?(${NUM})(\s?(?:million|billion|lakhs?|k)\b)?`,
      "gi"
    ),
    (_m, amount, scale) => `${withScale(amount, scale)} rupees`,
  ],
  [
    new RegExp(String.raw`\$(${NUM})(\s?(?:million|billion|k)\b)?`, "g"),
    (_m, amount, scale) => `${withScale(amount, scale)} dollars`,
  ],
  // Times: 10:30, 9:05 am, 10:00 pm.
  [
    /\b(\d{1,2}):(\d{2})(?:\s?([ap])\.?\s?m\.?)?(?=\W|$)/gi,
    (match, hour, minute, half) => {
      const h = numberToWords(Number(hour));
      const min = Number(minute);
      let said = `${h} ${min < 10 ? `oh ${ONES[min]}` : underHundred(min)}`;
      if (min === 0) {
        said = half ? h : `${h} o'clock`;
      }
      return half ? `${said} ${half.toLowerCase()} m${endDot(match)}` : said;
    },
  ],
  [
    /\b(\d{1,2})\s?([ap])\.?m\.?(?=\W|$)/gi,
    (match, hour, half) =>
      `${numberToWords(Number(hour))} ${half.toLowerCase()} m${endDot(match)}`,
  ],
  // Chemical formulas: CO2 -> "C O two", 6H2O -> "six H two O".
  [
    /\b(\d{0,2})((?:[A-Z][a-z]?\d{0,3}){1,8})\b/g,
    (match, coefficient: string, formula: string) => {
      if (!(coefficient || /\d/.test(formula))) {
        return match;
      }
      const elements = formula.replace(
        /([A-Z][a-z]?)(\d*)/g,
        (_m, element: string, count: string) =>
          ` ${element}${count ? ` ${numberToWords(Number(count))}` : ""}`
      );
      return `${coefficient ? numberToWords(Number(coefficient)) : ""}${elements}`.trim();
    },
  ],
  // Ranges: 10-20, 1990–2000 (with spaces around "-" it's a minus).
  [
    new RegExp(String.raw`\b(${NUM})(?:-|\s?[–—]\s?)(${NUM})\b`, "g"),
    "$1 to $2",
  ],
  // Ordinals: 1st, 22nd, 3rd, 4th.
  [/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n) => ordinalToWords(Number(n))],
  // Common fractions.
  [/\b1\/2\b/g, "one half"],
  [/\b1\/3\b/g, "one third"],
  [/\b2\/3\b/g, "two thirds"],
  [/\b1\/4\b/g, "one quarter"],
  [/\b3\/4\b/g, "three quarters"],
  [
    /\b(\d+)\/(\d+)\b/g,
    (_m, a, b) => `${plainNumber(a)} over ${plainNumber(b)}`,
  ],
  // A number with a unit: 5 km, 45%, 30°C, 9.8 m/s².
  [
    new RegExp(
      String.raw`(-?(?:${NUM}))\s?(${UNIT_PATTERN})(?![\p{L}\d])`,
      "gu"
    ),
    (_m, amount, unit) => unitWords(amount, unit),
  ],
  // Years on their own: "in 2026", "since 1948".
  [
    /\b(1[1-9]\d{2}|20\d{2})\b(?![,.]\d)/g,
    (_m, year) => yearToWords(Number(year)),
  ],
  // Negative numbers.
  [/(^|[\s(=])-(\d)/g, "$1minus $2"],
  // Maths and other symbols.
  [/(\d)\s?[x×]\s?(?=\d)/g, "$1 times "],
  [/\s?×\s?/g, " times "],
  [/\s?÷\s?/g, " divided by "],
  [/\s?≈\s?/g, " is about "],
  [/\s?≠\s?/g, " is not equal to "],
  [/\s?≤\s?/g, " is less than or equal to "],
  [/\s?≥\s?/g, " is greater than or equal to "],
  [/\s?=\s?/g, " equals "],
  [/(\w)\s?\+\s?(?=\w)/g, "$1 plus "],
  [/(\w)\s?−\s?(?=\w)/g, "$1 minus "],
  [/(\w)\s-\s(?=\d)/g, "$1 minus "],
  [/(\w)\s<\s(?=\w)/g, "$1 is less than "],
  [/(\w)\s>\s(?=\w)/g, "$1 is greater than "],
  [/\s?&\s?/g, " and "],
  [/@/g, " at "],
  [/#(?=\d)/g, "number "],
  [/~(?=\s?\d)/g, "about "],
  [/√\s?(\d+)/g, "the square root of $1"],
  [/π/g, "pi"],
  // Any number left: 1,500 -> one thousand five hundred.
  [new RegExp(NUM, "g"), (m) => plainNumber(m)],
  // Acronyms in capitals, said letter by letter (ICT -> I C T).
  [
    /\b[A-Za-z]*[A-Z][A-Za-z]*\b/g,
    (word) => {
      if (SPOKEN_ACRONYMS[word]) {
        return SPOKEN_ACRONYMS[word];
      }
      const isAcronym = /^[A-Z]{2,5}s?$/.test(word);
      const letters = word.endsWith("s") ? word.slice(0, -1) : word;
      if (
        !isAcronym ||
        SAID_AS_WORDS.has(letters) ||
        CAPITALISED_WORDS.has(word)
      ) {
        return word;
      }
      return `${[...letters].join(" ")}${word.endsWith("s") ? "s" : ""}`;
    },
  ],
  // Hyphenated words as separate words: "step-by-step" -> "step by step".
  [/(\p{L})-(?=\p{L})/gu, "$1 "],
  // Dashes, brackets and slashes read as pauses ("x/y" -> "x or y").
  [/\s*[—–]\s*/g, ", "],
  [/\s+-\s+/g, ", "],
  [/\s*[([{]\s*/g, ", "],
  [/\s*[)\]}]\s*(?=[.!?,;:]|$)/g, ""],
  [/\s*[)\]}]\s*/g, ", "],
  [/(\p{L})\s?\/\s?(?=\p{L})/gu, "$1 or "],
  [/\//g, " "],
  [/[*_#~^|<>]/g, " "],
  // Tidy up the punctuation the rules leave behind.
  [/\s+([,.!?;:])/g, "$1"],
  [/,\s*,+/g, ","],
  [/([.!?]),/g, "$1"],
  [/^\s*,\s*/g, ""],
  [/\s{2,}/g, " "],
];

/** English text ready for the voice. */
export function forSpeech(text: string) {
  let spoken = plainCharacters(text);
  for (const [pattern, replacement] of RULES) {
    spoken =
      typeof replacement === "string"
        ? spoken.replace(pattern, replacement)
        : spoken.replace(pattern, replacement as (...m: string[]) => string);
  }
  return spoken.trim();
}
