import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { generateFollowUpSuggestions } from "@/lib/ai/suggestions";
import { fallbackTitleFromText, titleTextFromParts } from "@/lib/chat/title";
import { isTestEnvironment } from "@/lib/constants";
import {
  getChatById,
  getMessagesByChatId,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import { convertToUIMessages, getTextFromMessage } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../../actions";

const requestSchema = z.object({
  assistantMessageId: z.uuid(),
  chatId: z.uuid(),
  generateSuggestions: z.boolean().optional().default(true),
  voice: z.boolean().optional().default(false),
});

function readSuggestions(message: { parts: unknown[] }): string[] | null {
  const part = message.parts.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "type" in candidate &&
      candidate.type === "data-suggestions"
  );
  if (
    !part ||
    typeof part !== "object" ||
    !("data" in part) ||
    !Array.isArray(part.data) ||
    !part.data.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return part.data;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const parsedBody = requestSchema.safeParse(body);
  if (!parsedBody.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const {
    assistantMessageId,
    chatId,
    generateSuggestions: shouldGenerateSuggestions,
    voice,
  } = parsedBody.data;
  const chat = await getChatById({ id: chatId });
  if (!chat || chat.userId !== session.user.id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const uiMessages = convertToUIMessages(
    await getMessagesByChatId({ id: chatId })
  );
  const assistantIndex = uiMessages.findIndex(
    (message) =>
      message.id === assistantMessageId && message.role === "assistant"
  );
  if (assistantIndex < 0) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const assistantMessage = uiMessages[assistantIndex];
  const existingSuggestions = readSuggestions(assistantMessage);
  const previousUserMessage = uiMessages
    .slice(0, assistantIndex)
    .findLast((message) => message.role === "user");

  const firstUserMessage = uiMessages.find(
    (message) => message.role === "user"
  );
  const fallbackTitle = firstUserMessage
    ? fallbackTitleFromText(titleTextFromParts(firstUserMessage.parts))
    : null;
  const shouldGenerateTitle = Boolean(
    firstUserMessage && fallbackTitle && chat.title === fallbackTitle
  );

  const suggestionsPromise = (async () => {
    if (
      existingSuggestions ||
      voice ||
      !shouldGenerateSuggestions ||
      isTestEnvironment
    ) {
      return existingSuggestions ?? [];
    }

    const suggestions = await generateFollowUpSuggestions({
      abortSignal: request.signal,
      answer: getTextFromMessage(assistantMessage),
      question: previousUserMessage
        ? getTextFromMessage(previousUserMessage)
        : "",
    });
    if (suggestions.length === 0) {
      return [];
    }

    await updateMessage({
      id: assistantMessage.id,
      parts: [
        ...assistantMessage.parts,
        { data: suggestions, type: "data-suggestions" },
      ],
    });
    return suggestions;
  })();

  const titlePromise =
    shouldGenerateTitle && firstUserMessage
      ? generateTitleFromUserMessage({ message: firstUserMessage }).then(
          async (title) => {
            if (title !== chat.title) {
              await updateChatTitleById({ chatId, title });
              return title;
            }
            return null;
          }
        )
      : Promise.resolve(null);

  const [suggestions, updatedTitle] = await Promise.all([
    suggestionsPromise,
    titlePromise,
  ]);

  return Response.json({
    assistantMessageId,
    suggestions,
    ...(updatedTitle ? { title: updatedTitle } : {}),
  });
}
