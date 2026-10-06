"use client";

import { MessageResponse } from "../ai-elements/message";

/** Markdown + LaTeX for quiz and flashcard text, without the word animation. */
export function StudyText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <MessageResponse className={className} isAnimating={false}>
      {children}
    </MessageResponse>
  );
}
