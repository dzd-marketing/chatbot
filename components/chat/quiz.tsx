"use client";

import {
  CheckIcon,
  DownloadIcon,
  ListChecksIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { QuizQuestion } from "@/lib/ai/tools/study";
import { downloadWord } from "@/lib/export/download";
import { cn } from "@/lib/utils";
import { StudyText } from "./study-text";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** The quiz with answer key, for downloading as Word. */
function quizMarkdown(title: string, questions: QuizQuestion[]) {
  const body = questions
    .map(
      (question, index) =>
        `**${index + 1}. ${question.question}**\n\n${question.options
          .map((option, optionIndex) => `${LETTERS[optionIndex]}) ${option}  `)
          .join("\n")}`
    )
    .join("\n\n");
  const key = questions
    .map(
      (question, index) =>
        `${index + 1}. **${LETTERS[question.answer]}** – ${question.explanation}`
    )
    .join("\n");
  return `# ${title}\n\n${body}\n\n---\n\n## Answers\n\n${key}\n`;
}

function scoreMessage(percent: number) {
  if (percent === 100) {
    return "Perfect score! Excellent work.";
  }
  if (percent >= 80) {
    return "Great job! You know this well.";
  }
  if (percent >= 50) {
    return "Good effort. Review the ones you missed and try again.";
  }
  return "Keep going! Go through the explanations and retry.";
}

export function QuizSkeleton({
  title,
  count,
}: {
  title?: string;
  count: number;
}) {
  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-2.5 border-border/40 border-b px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <ListChecksIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm">
            {title || "Creating your quiz"}
          </div>
          <div className="text-muted-foreground text-xs">
            {count > 0 ? `Writing question ${count}…` : "Getting ready…"}
          </div>
        </div>
      </div>
      <div className="space-y-2.5 p-4">
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted-foreground/12" />
        {[0, 1, 2, 3].map((item) => (
          <div
            className="h-10 animate-pulse rounded-xl bg-muted-foreground/8"
            key={item}
          />
        ))}
      </div>
    </div>
  );
}

function PureQuiz({
  title,
  questions: allQuestions,
}: {
  title: string;
  questions: QuizQuestion[];
}) {
  // Skip any question whose answer doesn't match its options.
  const questions = useMemo(
    () =>
      allQuestions.filter(
        (item) => item.answer >= 0 && item.answer < item.options.length
      ),
    [allQuestions]
  );

  /** Which questions this round covers (all, or the ones missed). */
  const [round, setRound] = useState<number[]>(() =>
    questions.map((_, index) => index)
  );
  const [position, setPosition] = useState(0);
  /** Chosen option per question index, for this round. */
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [finished, setFinished] = useState(false);

  const questionIndex = round[position];
  const question = questions[questionIndex];
  const chosen = answers[questionIndex];
  const answered = chosen !== undefined;

  const correctCount = round.filter(
    (index) => answers[index] === questions[index]?.answer
  ).length;
  const wrong = round.filter(
    (index) => answers[index] !== questions[index]?.answer
  );

  const choose = useCallback(
    (option: number) => {
      if (answered) {
        return;
      }
      setAnswers((current) => ({ ...current, [questionIndex]: option }));
    },
    [answered, questionIndex]
  );

  const next = useCallback(() => {
    if (position + 1 >= round.length) {
      setFinished(true);
    } else {
      setPosition(position + 1);
    }
  }, [position, round.length]);

  const startRound = useCallback((indexes: number[]) => {
    setRound(indexes);
    setPosition(0);
    setAnswers({});
    setFinished(false);
  }, []);

  const restart = useCallback(
    () => startRound(questions.map((_, index) => index)),
    [questions, startRound]
  );
  const retryWrong = useCallback(() => startRound(wrong), [startRound, wrong]);

  const download = useCallback(async () => {
    try {
      await downloadWord(title, quizMarkdown(title, questions));
    } catch {
      toast.error("Couldn't create the Word file. Please try again.");
    }
  }, [questions, title]);

  if (questions.length === 0) {
    return null;
  }

  const progress = finished
    ? 100
    : ((position + (answered ? 1 : 0)) / round.length) * 100;

  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border/50 bg-card shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <ListChecksIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[15px]">{title}</div>
          <div className="text-muted-foreground text-xs">
            {finished
              ? "Results"
              : `Question ${position + 1} of ${round.length}${round.length < questions.length ? " · retry" : ""}`}
          </div>
        </div>
        <button
          aria-label="Download quiz as Word"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground embed:hidden"
          onClick={download}
          title="Download quiz with answers (Word)"
          type="button"
        >
          <DownloadIcon className="size-4" />
        </button>
      </div>

      <div className="h-1 bg-muted">
        <div
          className="h-full rounded-r-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {finished ? (
        <div className="flex flex-col items-center px-5 py-7 text-center">
          <div className="font-bold text-4xl tracking-tight">
            {correctCount}
            <span className="text-muted-foreground text-2xl">
              /{round.length}
            </span>
          </div>
          <div className="mt-1 font-medium text-primary text-sm">
            {Math.round((correctCount / round.length) * 100)}%
          </div>
          <p className="mt-3 max-w-xs text-muted-foreground text-sm">
            {scoreMessage(Math.round((correctCount / round.length) * 100))}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {wrong.length > 0 ? (
              <button
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90"
                onClick={retryWrong}
                type="button"
              >
                <RotateCcwIcon className="size-3.5" />
                Retry {wrong.length} wrong
              </button>
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/60 px-4 font-medium text-sm transition-colors hover:bg-muted"
              onClick={restart}
              type="button"
            >
              Restart quiz
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pt-4 pb-4">
          <StudyText className="font-medium text-[15px] leading-relaxed">
            {question.question}
          </StudyText>

          <div className="mt-3.5 flex flex-col gap-2">
            {question.options.map((option, optionIndex) => {
              const isCorrect = optionIndex === question.answer;
              const isChosen = optionIndex === chosen;
              let state: "idle" | "correct" | "wrong" | "muted" = "idle";
              if (answered) {
                if (isCorrect) {
                  state = "correct";
                } else if (isChosen) {
                  state = "wrong";
                } else {
                  state = "muted";
                }
              }
              return (
                <QuizOption
                  index={optionIndex}
                  // biome-ignore lint/suspicious/noArrayIndexKey: options are fixed per question
                  key={`${questionIndex}-${optionIndex}`}
                  onChoose={choose}
                  state={state}
                  text={option}
                />
              );
            })}
          </div>

          {answered ? (
            <div
              className={cn(
                "mt-3.5 rounded-xl border px-3.5 py-3 text-sm",
                chosen === question.answer
                  ? "border-emerald-500/30 bg-emerald-500/8"
                  : "border-red-500/30 bg-red-500/8"
              )}
            >
              <div
                className={cn(
                  "mb-1 font-semibold",
                  chosen === question.answer
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-red-700 dark:text-red-400"
                )}
              >
                {chosen === question.answer
                  ? "Correct!"
                  : `Not quite. The answer is ${LETTERS[question.answer]}.`}
              </div>
              <StudyText className="text-foreground/85 text-sm leading-relaxed">
                {question.explanation}
              </StudyText>
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {correctCount} correct so far
            </span>
            <button
              className="inline-flex h-9 items-center rounded-xl bg-primary px-5 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              disabled={!answered}
              onClick={next}
              type="button"
            >
              {position + 1 >= round.length ? "See results" : "Next"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PureQuizOption({
  index,
  text,
  state,
  onChoose,
}: {
  index: number;
  text: string;
  state: "idle" | "correct" | "wrong" | "muted";
  onChoose: (index: number) => void;
}) {
  const handleClick = useCallback(() => onChoose(index), [index, onChoose]);
  return (
    <button
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors",
        state === "idle" &&
          "border-border/60 hover:border-primary/50 hover:bg-primary/5",
        state === "correct" &&
          "border-emerald-500/60 bg-emerald-500/10 text-foreground",
        state === "wrong" && "border-red-500/60 bg-red-500/10 text-foreground",
        state === "muted" && "border-border/40 opacity-55"
      )}
      disabled={state !== "idle"}
      onClick={handleClick}
      type="button"
    >
      <span
        className={cn(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-lg font-semibold text-xs",
          state === "correct" && "bg-emerald-600 text-white",
          state === "wrong" && "bg-red-600 text-white",
          (state === "idle" || state === "muted") &&
            "bg-muted text-muted-foreground"
        )}
      >
        {state === "correct" ? <CheckIcon className="size-3.5" /> : null}
        {state === "wrong" ? <XIcon className="size-3.5" /> : null}
        {state === "idle" || state === "muted" ? LETTERS[index] : null}
      </span>
      <StudyText className="min-w-0 flex-1 leading-relaxed [&_p]:my-0">
        {text}
      </StudyText>
    </button>
  );
}

const QuizOption = memo(PureQuizOption);

export const Quiz = memo(PureQuiz);
