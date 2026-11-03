import { type NextRequest, NextResponse } from "next/server";
import { encode, getToken } from "next-auth/jwt";
import { SESSION_MAX_AGE_SECONDS } from "@/app/(auth)/auth.config";
import { isDevelopmentEnvironment } from "@/lib/constants";
import { upsertAppUser } from "@/lib/db/queries";
import {
  getWebOrigin,
  SECURE_SESSION_COOKIE,
  SsoConfigError,
  STUDENT_SESSION_COOKIE,
} from "@/lib/sso/config";
import {
  type PublicStudent,
  STUDENT_TOKEN_PATTERN,
  verifyStudentToken,
} from "@/lib/sso/student-profile";
import { TheStudentApiError } from "@/lib/sso/thestudent-api";

/**
 * Android app handshake session.
 *
 *   POST   { token }  verify the app's session token with TheStudent API
 *                     (action=me), keep it ONLY in the HttpOnly
 *                     `thestudent_session` cookie, and sign the student in
 *                     to this site (account keyed by TheStudent users.id).
 *   GET              restore: re-verify the cookie's token.
 *   DELETE           sign out: clear both cookies.
 *
 * Not /api/auth/session: that path belongs to Auth.js (useSession), and
 * replacing it would break every login on the site.
 *
 * The token is never logged, echoed or returned. Responses carry display
 * fields only (name, email, avatar, stream/exam, tier).
 */

const MAX_BODY_BYTES = 2048;
const TOKEN_MAX_AGE_SECONDS = 2_592_000;

type Body = {
  authenticated: boolean;
  user: PublicStudent | null;
  /** True when this call switched the site session to another account. */
  accountChanged?: boolean;
};

function json(body: Body, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  maxAge,
  path: "/",
  sameSite: "lax" as const,
  secure: true,
});

function clearStudentCookie(response: NextResponse) {
  response.cookies.set(STUDENT_SESSION_COOKIE, "", cookieOptions(0));
}

/** POST/DELETE must come from this site's own pages (login-CSRF guard). */
function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  const allowed = new Set([new URL(request.url).origin]);
  const webOrigin = getWebOrigin();
  if (webOrigin) {
    allowed.add(webOrigin);
  }
  return allowed.has(origin);
}

/** The current site session's app account, if any (no callbacks run). */
async function currentAppSub(request: Request) {
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });
  return typeof token?.appSub === "string" ? token.appSub : null;
}

/**
 * A new site session token for the student, or null when the current
 * session already belongs to the same TheStudent account.
 */
async function newSiteSession(
  request: Request,
  sub: string,
  user: PublicStudent
): Promise<string | null> {
  if ((await currentAppSub(request)) === sub) {
    return null;
  }
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new SsoConfigError("AUTH_SECRET is missing.");
  }
  const { id } = await upsertAppUser({ name: user.name, sub });
  return encode({
    maxAge: SESSION_MAX_AGE_SECONDS,
    salt: SECURE_SESSION_COOKIE,
    secret,
    token: {
      appAuth: "token",
      appCheckedAt: Date.now(),
      appSub: sub,
      email: user.email,
      id,
      name: user.name,
      sub: id,
      type: "regular",
    },
  });
}

function failureReason(error: unknown) {
  if (error instanceof TheStudentApiError) {
    return error.reason;
  }
  return error instanceof SsoConfigError ? "config" : "unexpected";
}

/** Verifies `token` and builds the response (shared by GET and POST). */
async function respondForToken(
  request: Request,
  token: string,
  setTokenCookie: boolean
) {
  try {
    const { sub, user } = await verifyStudentToken(token);
    const sessionToken = await newSiteSession(request, sub, user);
    const response = json({
      accountChanged: sessionToken !== null,
      authenticated: true,
      user,
    });
    if (sessionToken) {
      response.cookies.set(
        SECURE_SESSION_COOKIE,
        sessionToken,
        cookieOptions(SESSION_MAX_AGE_SECONDS)
      );
    }
    if (setTokenCookie) {
      response.cookies.set(
        STUDENT_SESSION_COOKIE,
        token,
        cookieOptions(TOKEN_MAX_AGE_SECONDS)
      );
    }
    return response;
  } catch (error) {
    const reason = failureReason(error);
    if (error instanceof TheStudentApiError && error.definitive) {
      // Invalid or expired: forget the token. A site session that came
      // from it is signed out on its next check (the cookie is gone).
      console.warn(`[app-session] token rejected (${reason})`);
      const response = json({ authenticated: false, user: null }, 401);
      clearStudentCookie(response);
      return response;
    }
    // Temporary problem (or bad config): keep the cookie, try again later.
    console.warn(`[app-session] verification unavailable (${reason})`);
    return json({ authenticated: false, user: null }, 503);
  }
}

export function GET(request: NextRequest) {
  const token = request.cookies.get(STUDENT_SESSION_COOKIE)?.value;

  if (!token) {
    return json({ authenticated: false, user: null });
  }
  if (!STUDENT_TOKEN_PATTERN.test(token)) {
    const response = json({ authenticated: false, user: null }, 401);
    clearStudentCookie(response);
    return response;
  }
  return respondForToken(request, token, false);
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return json({ authenticated: false, user: null }, 403);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json({ authenticated: false, user: null }, 400);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ authenticated: false, user: null }, 400);
  }
  let token: unknown;
  try {
    ({ token } = JSON.parse(raw) as { token?: unknown });
  } catch {
    return json({ authenticated: false, user: null }, 400);
  }
  if (typeof token !== "string" || !STUDENT_TOKEN_PATTERN.test(token)) {
    return json({ authenticated: false, user: null }, 400);
  }
  return respondForToken(request, token, true);
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return json({ authenticated: false, user: null }, 403);
  }
  const response = json({ authenticated: false, user: null });
  clearStudentCookie(response);
  // End a site session that came from the app; website logins are left to
  // the normal sign-out.
  const sessionToken = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });
  if (sessionToken?.appAuth === "token") {
    response.cookies.set(SECURE_SESSION_COOKIE, "", cookieOptions(0));
  }
  return response;
}
