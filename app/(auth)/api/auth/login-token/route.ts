import { NextResponse } from "next/server";
import { signIn } from "@/app/(auth)/auth";
import {
  TOKEN_PATTERN,
  theStudentProfileFromUser,
  verifyTheStudentWebAssertion,
} from "@/lib/thestudent/api";
import { isSameOrigin, NO_STORE } from "@/lib/thestudent/same-origin";

/** Exchange a PHP-signed login assertion for the encrypted HttpOnly session. */
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
  let assertion = "";
  try {
    const body = (await request.json()) as {
      token?: unknown;
      web_assertion?: unknown;
    };
    token = typeof body?.token === "string" ? body.token : "";
    assertion =
      typeof body?.web_assertion === "string" ? body.web_assertion : "";
  } catch {
    // handled below
  }

  if (!TOKEN_PATTERN.test(token)) {
    return reply(400, "Invalid TheStudent session.");
  }
  const claims = verifyTheStudentWebAssertion(assertion, token);
  if (!claims || !theStudentProfileFromUser(claims.user)) {
    return reply(
      401,
      "Could not verify your TheStudent session. Please sign in again."
    );
  }

  try {
    await signIn("thestudent", {
      redirect: false,
      token,
      web_assertion: assertion,
    });
  } catch {
    return reply(500, "Could not start your session. Please try again.");
  }
  return reply(200);
}
