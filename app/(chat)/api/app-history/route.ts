import { auth } from "@/app/(auth)/auth";
import { getRecentChatsForApp } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { getWebOrigin } from "@/lib/sso/config";

/**
 * Chat history for the Android app's native drawer (embed mode).
 *
 * Scoped ONLY by the HttpOnly session cookie: no user id, email or any
 * other identifier is accepted from the client. Returns at most 50 chats
 * with just an id, a title and the last-activity time, plus the configured
 * production origin so the page only hands history to the app bridge when
 * it is actually running there.
 */

const MAX_CHATS = 50;
const CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

function cleanTitle(title: string) {
  const clean = title
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || "New chat";
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const rows = await getRecentChatsForApp({
    limit: MAX_CHATS,
    userId: session.user.id,
  });

  const chats = rows
    .filter((row) => CHAT_ID.test(row.id))
    .map((row) => ({
      id: row.id,
      title: cleanTitle(row.title),
      updatedAt: row.updatedAt.toISOString(),
    }));

  return Response.json(
    { chats, origin: getWebOrigin() },
    {
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    }
  );
}
