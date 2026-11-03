import { NextResponse } from "next/server";
import { signIn } from "@/app/(auth)/auth";
import { TOKEN_PATTERN, verifyToken } from "@/lib/thestudent/api";
import { isSameOrigin, NO_STORE } from "@/lib/thestudent/same-origin";

/**
 * 1-tap login from TheStudent Android app. The page reads the app's bearer
 * token from window.TheStudentAndroid and posts it here; auth.php
 * (action=me) decides whether it is valid. Body: {"token":"<hex>"}.
 */
export async function POST(request: Request) {
  const reply = (status: number, message?: string) =>
    NextResponse.json(
      message ? { message, ok: status === 200 } : { ok: status === 200 },
      { headers: NO_STORE, status }
    );

  if (!isSameOrigin(request)) {
    return reply(403, "Forbidden.");
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return reply(415, "Unsupported request.");
  }

  let token = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    token = typeof body?.token === "string" ? body.token : "";
  } catch {
    // handled below
  }
  if (!TOKEN_PATTERN.test(token)) {
    return reply(400, "Invalid app session.");
  }

  const result = await verifyToken(token);
  if (!result.ok) {
    return result.definitive
      ? reply(
          401,
          "Your TheStudent app session has expired. Sign in again in the app, or use your email and password."
        )
      : reply(
          503,
          "TheStudent is not reachable right now. Please try again in a moment."
        );
  }

  try {
    await signIn("thestudent", { redirect: false, token });
  } catch {
    return reply(500, "Could not start your session. Please try again.");
  }
  return reply(200);
}
