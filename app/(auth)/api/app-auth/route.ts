import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { SESSION_MAX_AGE_SECONDS } from "@/app/(auth)/auth.config";
import { upsertAppUser } from "@/lib/db/queries";
import {
  getSsoConfig,
  SECURE_SESSION_COOKIE,
  type SsoConfig,
  SsoConfigError,
} from "@/lib/sso/config";
import { exchangeCode, TheStudentApiError } from "@/lib/sso/thestudent-api";

/**
 * TheStudent app -> website SSO.
 *
 * The Android app POSTs (application/x-www-form-urlencoded):
 *   code, code_verifier, state, app=android, theme=dark|light [, q]
 * The one-time code is redeemed server-to-server with TheStudent API, the
 * account is found/created by its opaque `sub` only, and a fresh Auth.js
 * session is issued in exactly one HttpOnly cookie. Then 303 to
 *   <ASSISTANT_WEB_ORIGIN>/?app=android&theme=<theme>[&q=…]
 * On any failure after validation: clear the session cookie and 303 to
 *   /?app=android&auth=guest
 *
 * The code, verifier and state never appear in a URL, cookie, log, response
 * body or client-side JS.
 */

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_QUESTION_LENGTH = 2000;
const MAX_COOKIE_VALUE_LENGTH = 3800;

const OPAQUE_VALUE = /^[A-Za-z0-9._~-]{8,1024}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

type Theme = "dark" | "light";

function withSecurityHeaders<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

function plain(status: number, message: string, headers?: HeadersInit) {
  return withSecurityHeaders(
    new NextResponse(message, {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
      status,
    })
  );
}

/** Builds `<origin>/?…` keeping the parameter order given. */
function homeUrl(
  config: SsoConfig | null,
  params: [key: string, value: string | undefined][]
) {
  const search = new URLSearchParams();
  for (const [key, value] of params) {
    if (value) {
      search.set(key, value);
    }
  }
  return `${config?.webOrigin ?? ""}${BASE_PATH}/?${search.toString()}`;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    secure: true,
  };
}

function failure(
  config: SsoConfig | null,
  reason: string,
  theme: Theme,
  question: string | undefined
) {
  console.warn(`[app-auth] sign-in failed (${reason})`);
  const response = withSecurityHeaders(
    new NextResponse(null, {
      headers: {
        Location: homeUrl(config, [
          ["app", "android"],
          ["auth", "guest"],
          ["theme", theme],
          ["q", question],
        ]),
      },
      status: 303,
    })
  );
  // Clear any existing session, so a failed hand-off never leaves the
  // previous person signed in.
  response.cookies.set(
    config?.sessionCookieName ?? SECURE_SESSION_COOKIE,
    "",
    cookieOptions(0)
  );
  return response;
}

/** Exactly one value per field; anything else is invalid. */
function single(form: URLSearchParams, name: string) {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function readQuestion(form: URLSearchParams, url: URL) {
  const raw = form.get("q") ?? url.searchParams.get("q");
  const question = raw?.trim().slice(0, MAX_QUESTION_LENGTH);
  return question || undefined;
}

export function GET() {
  return plain(405, "Method Not Allowed", { Allow: "POST" });
}

export async function POST(request: Request) {
  // 1. Validate the form.
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    return plain(400, "Bad Request");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return plain(400, "Bad Request");
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return plain(400, "Bad Request");
  }
  const form = new URLSearchParams(rawBody);
  const code = single(form, "code");
  const codeVerifier = single(form, "code_verifier");
  const state = single(form, "state");
  const app = single(form, "app");
  const theme = single(form, "theme");

  if (
    !(code && OPAQUE_VALUE.test(code)) ||
    !(codeVerifier && PKCE_VERIFIER.test(codeVerifier)) ||
    !(state && OPAQUE_VALUE.test(state)) ||
    app !== "android" ||
    (theme !== "dark" && theme !== "light")
  ) {
    return plain(400, "Bad Request");
  }
  const question = readQuestion(form, new URL(request.url));

  let config: SsoConfig;
  try {
    config = getSsoConfig();
  } catch (error) {
    const detail =
      error instanceof SsoConfigError ? error.message : "unknown error";
    console.error(`[app-auth] SSO config invalid: ${detail}`);
    return failure(null, "config", theme, question);
  }

  // Login-CSRF guard: a form on another website sends its own Origin. The
  // app's WebView POST sends no Origin or "null", which is allowed.
  const origin = request.headers.get("origin");
  if (origin && origin !== "null" && origin !== config.webOrigin) {
    console.warn("[app-auth] rejected cross-site POST");
    return plain(403, "Forbidden");
  }

  try {
    // 2. Redeem the code server-to-server.
    const account = await exchangeCode({ code, codeVerifier, state });

    // 3. Find or create by `sub` only; issue a brand-new session token.
    const { id } = await upsertAppUser({
      name: account.name,
      sub: account.sub,
    });
    const sessionToken = await encode({
      maxAge: SESSION_MAX_AGE_SECONDS,
      salt: config.sessionCookieName,
      secret: process.env.AUTH_SECRET ?? "",
      token: {
        appCheckedAt: Date.now(),
        appSub: account.sub,
        email: account.email,
        id,
        name: account.name,
        sub: id,
        type: "regular",
      },
    });
    if (sessionToken.length > MAX_COOKIE_VALUE_LENGTH) {
      return failure(config, "session_too_large", theme, question);
    }

    // 4. Back to the embedded chat.
    const response = withSecurityHeaders(
      new NextResponse(null, {
        headers: {
          Location: homeUrl(config, [
            ["app", "android"],
            ["theme", theme],
            ["q", question],
          ]),
        },
        status: 303,
      })
    );
    response.cookies.set(
      config.sessionCookieName,
      sessionToken,
      cookieOptions(SESSION_MAX_AGE_SECONDS)
    );
    return response;
  } catch (error) {
    const reason =
      error instanceof TheStudentApiError
        ? `exchange_${error.reason}`
        : error instanceof SsoConfigError
          ? "config"
          : "session";
    return failure(config, reason, theme, question);
  }
}
