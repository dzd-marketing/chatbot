import { tool } from "ai";
import { z } from "zod";

/**
 * Interactive study tools. The quiz or flashcards are the tool input; the
 * chat shows them as interactive cards (components/chat/quiz.tsx and
 * flashcards.tsx), so the model must not repeat them in its text.
 */

export const quizQuestionSchema = z.object({
  answer: z
    .number()
    .int()
    .min(0)
    .max(5)
    .describe("Index (0-based) of the correct option."),
  explanation: z
    .string()
    .min(1)
    .max(800)
    .describe(
      "Why the answer is correct (and common mistakes), 1-3 sentences."
    ),
  options: z.array(z.string().min(1).max(300)).min(2).max(6),
  question: z.string().min(1).max(1000),
});

export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

export const createQuiz = tool({
  description:
    "Create an interactive multiple-choice quiz. The student answers one question at a time, sees right/wrong with your explanation, and gets a score at the end. Don't write the questions or answers in your reply; just introduce the quiz in one sentence. Markdown and LaTeX ($...$) work in questions, options and explanations.",
  execute: ({ questions, title }) => {
    const invalid = questions.findIndex(
      (question) => question.answer >= question.options.length
    );
    if (invalid !== -1) {
      return {
        error: `Question ${invalid + 1}: the answer index is outside its options. Fix it and call createQuiz again.`,
      };
    }
    return { questionCount: questions.length, title };
  },
  inputSchema: z.object({
    questions: z.array(quizQuestionSchema).min(1).max(30),
    title: z
      .string()
      .min(1)
      .max(120)
      .describe("e.g. 'Organic Chemistry – Alkenes'"),
  }),
});

export const flashcardSchema = z.object({
  back: z
    .string()
    .min(1)
    .max(800)
    .describe("Answer, definition or explanation."),
  front: z.string().min(1).max(300).describe("Term, question or prompt."),
});

export type Flashcard = z.infer<typeof flashcardSchema>;

export const createFlashcards = tool({
  description:
    "Create a deck of interactive flashcards (front: term or question, back: answer). The student flips cards and marks which ones they know. Don't write the cards in your reply; just introduce the deck in one sentence. Markdown and LaTeX ($...$) work on both sides.",
  execute: ({ cards, title }) => ({ cardCount: cards.length, title }),
  inputSchema: z.object({
    cards: z.array(flashcardSchema).min(1).max(60),
    title: z.string().min(1).max(120).describe("e.g. 'Physics – SI units'"),
  }),
});
