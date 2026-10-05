import "server-only";

import { generateText } from "ai";
import { titleModel } from "./models";
import { getTitleModel } from "./providers";

const SUGGESTION_COUNT = 3;
const MAX_SUGGESTION_CHARS = 90;
const ANSWER_EXCERPT_CHARS = 2500;
const QUESTION_EXCERPT_CHARS = 1000;
const TIMEOUT_MS = 8000;

const suggestionsPrompt = `You write follow-up suggestions for DZD AI, a study assistant for Sri Lankan students (O/L, A/L, Grade 5 Scholarship and university).

Given the student's last message and DZD AI's answer, write exactly ${SUGGESTION_COUNT} short messages the STUDENT could send next.

Rules:
- Write from the student's point of view, as requests or questions (e.g. "Give me a practice question on this", "Explain step 2 again").
- Make each one specific to the topic just discussed, and make them different from each other: for example, go deeper, practise with a question, or explore a related topic or past paper.
- Keep each under 60 characters.
- Use the same language and script as the student's message (Sinhala, Tamil or English). If the student wrote Singlish, use simple English.
- Never suggest anything unsafe or off-topic for a student.
- Output only the ${SUGGESTION_COUNT} suggestions, one per line, with no numbering, bullets, quotes or emojis.`;

// A list marker ("1.", "2)", "-", "*", "•") followed by space, then quotes.
const LIST_MARKER = /^\s*(?:\d{1,2}[.)]|[-*•·])\s+/;
const WRAPPING_QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;

export function parseSuggestions(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .replace(LIST_MARKER, "")
      .trim()
      .replace(WRAPPING_QUOTES, "")
      .trim();
    const key = line.toLowerCase().replace(/[\s?.!]+$/, "");
    if (line.length < 3 || line.length > MAX_SUGGESTION_CHARS) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
    if (result.length === SUGGESTION_COUNT) {
      break;
    }
  }
  return result;
}

/**
 * Generates follow-up suggestions for the end of an answer. Uses the fast
 * Z.AI title model with thinking off. Never throws: returns [] on timeout,
 * abort or any provider error so the chat reply is unaffected.
 */
export async function generateFollowUpSuggestions({
  question,
  answer,
  abortSignal,
}: {
  question: string;
  answer: string;
  abortSignal?: AbortSignal;
}): Promise<string[]> {
  if (!answer.trim()) {
    return [];
  }

  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  try {
    const { text } = await generateText({
      abortSignal: signal,
      instructions: suggestionsPrompt,
      maxOutputTokens: 200,
      maxRetries: 0,
      model: getTitleModel(),
      prompt: `Student's message:\n${question.slice(0, QUESTION_EXCERPT_CHARS) || "(no text, e.g. an image)"}\n\nDZD AI's answer:\n${answer.slice(0, ANSWER_EXCERPT_CHARS)}`,
      ...(titleModel.provider === "zai" && {
        providerOptions: { zai: { thinking: { type: "disabled" } } },
      }),
    });
    return parseSuggestions(text);
  } catch {
    return [];
  }
}
