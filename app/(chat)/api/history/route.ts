import type { NextRequest } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { fallbackTitleFromText, titleTextFromParts } from "@/lib/chat/title";
import {
  deleteAllChatsByUserId,
  getChatsByUserId,
  getFirstUserMessagesByChatIds,
  updateChatTitleById,
} from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const limit = Math.min(
    Math.max(Number.parseInt(searchParams.get("limit") || "10", 10), 1),
    50
  );
  const startingAfter = searchParams.get("starting_after");
  const endingBefore = searchParams.get("ending_before");

  if (startingAfter && endingBefore) {
    return new ChatbotError(
      "bad_request:api",
      "Only one of starting_after or ending_before can be provided."
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chats = await getChatsByUserId({
    endingBefore,
    id: session.user.id,
    limit,
    startingAfter,
  });

  const untitledChats = chats.chats.filter(
    (chat) => chat.title.trim().toLowerCase() === "new chat"
  );
  if (untitledChats.length > 0) {
    try {
      const firstUserMessages = await getFirstUserMessagesByChatIds({
        chatIds: untitledChats.map((chat) => chat.id),
      });
      const titlesByChatId = new Map(
        firstUserMessages.map(({ chatId, parts }) => [
          chatId,
          fallbackTitleFromText(titleTextFromParts(parts)),
        ])
      );

      await Promise.all(
        untitledChats.map(async (chat) => {
          const title = titlesByChatId.get(chat.id);
          if (!title) {
            return;
          }
          await updateChatTitleById({ chatId: chat.id, title });
          chat.title = title;
        })
      );
    } catch {
      // A failed title repair must not make chat history unavailable.
    }
  }

  return Response.json(chats);
}

export async function DELETE() {
  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const result = await deleteAllChatsByUserId({ userId: session.user.id });

  return Response.json(result, { status: 200 });
}
