"use server";

import { generateText, type UIMessage } from "ai";
import { auth } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { titlePrompt } from "@/lib/ai/prompts";
import { getTitleModel } from "@/lib/ai/providers";
import {
  fallbackTitleFromText,
  normalizeGeneratedTitle,
  titleTextFromParts,
} from "@/lib/chat/title";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  updateChatVisibilityById,
} from "@/lib/db/queries";

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  const sourceText = titleTextFromParts(message.parts);
  const fallbackTitle = fallbackTitleFromText(sourceText);

  try {
    const { text } = await generateText({
      instructions: titlePrompt,
      // The router handles busy models, so the SDK doesn't retry on top.
      maxRetries: 0,
      model: getTitleModel(),
      prompt: sourceText,
    });
    return normalizeGeneratedTitle(text, sourceText);
  } catch {
    return fallbackTitle;
  }
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const [message] = await getMessageById({ id });
  if (!message) {
    throw new Error("Message not found");
  }

  const chat = await getChatById({ id: message.chatId });
  if (!chat || chat.userId !== session.user.id) {
    throw new Error("Unauthorized");
  }

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const chat = await getChatById({ id: chatId });
  if (!chat || chat.userId !== session.user.id) {
    throw new Error("Unauthorized");
  }

  await updateChatVisibilityById({ chatId, visibility });
}
