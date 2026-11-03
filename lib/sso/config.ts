/**
 * App <-> web SSO configuration, read ONLY from server-side environment
 * variables. Nothing here may be imported into client code: none of these
 * variables are NEXT_PUBLIC_, so they are never inlined into a JS bundle.
 *
 * Kept dependency-free (no "server-only", no path aliases) so next.config.ts
 * can also import it and fail a production build when the config is wrong.
 *
 *   ASSISTANT_SSO_SECRET     64 hex chars, byte-identical to the PHP server's
 *                            (no default: without it the one-time-code
 *                            sign-in is off; the token handshake still works)
 *   THESTUDENT_API_BASE      https origin of the PHP API, no trailing slash
 *                            (default: DEFAULT_THESTUDENT_API_BASE)
 *   ASSISTANT_WEB_ORIGIN     https origin of this site, no trailing slash
 *                            (default: DEFAULT_ASSISTANT_WEB_ORIGIN)
 *   ASSISTANT_EXCHANGE_PATH  path the app POSTs the one-time code to
 *                            (default: /api/app-auth)
 *
 * A variable that IS set but malformed (http://, trailing slash, a path) is
 * an error, never silently replaced by the default.
 */

/** Used when THESTUDENT_API_BASE is not set (e.g. not configured on Vercel). */
export const DEFAULT_THESTUDENT_API_BASE = "https://app.quizontal.site";
/** Used when ASSISTANT_WEB_ORIGIN is not set. Must match the app's pin. */
export const DEFAULT_ASSISTANT_WEB_ORIGIN =
  "https://chatbot-liart-rho-81.vercel.app";

const ORIGIN_DEFAULTS: Record<string, string> = {
  ASSISTANT_WEB_ORIGIN: DEFAULT_ASSISTANT_WEB_ORIGIN,
  THESTUDENT_API_BASE: DEFAULT_THESTUDENT_API_BASE,
};

/** Auth.js session cookie on https (ASSISTANT_WEB_ORIGIN must be https). */
export const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

/** The file-based route that handles the code exchange. */
export const APP_AUTH_ROUTE_PATH = "/api/app-auth";

export type SsoConfig = {
  /** Used as-is (the 64 ASCII hex characters) as the HMAC-SHA256 key. */
  secret: string;
  apiBase: string;
  webOrigin: string;
  exchangePath: string;
  /** Auth.js session cookie name, derived from webOrigin (https => __Secure-). */
  sessionCookieName: string;
};

export class SsoConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SsoConfigError";
  }
}

const HEX_SECRET = /^[0-9a-f]{64}$/i;

/** Accepts only a bare `https://host[:port]` origin (no path, slash, query). */
function readHttpsOrigin(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() || ORIGIN_DEFAULTS[name];
  if (!value) {
    throw new SsoConfigError(`${name} is missing.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new SsoConfigError(`${name} is not a valid URL.`, { cause: error });
  }
  if (parsed.protocol !== "https:") {
    throw new SsoConfigError(`${name} must use https://.`);
  }
  if (parsed.origin !== value) {
    throw new SsoConfigError(
      `${name} must be a bare lowercase https origin with no path, query or trailing slash.`
    );
  }
  return value;
}

/** Validates the SSO environment. Throws SsoConfigError (never echoes values). */
export function parseSsoConfig(
  env: NodeJS.ProcessEnv = process.env
): SsoConfig {
  const secret = env.ASSISTANT_SSO_SECRET;
  if (!secret) {
    throw new SsoConfigError("ASSISTANT_SSO_SECRET is missing.");
  }
  if (!HEX_SECRET.test(secret)) {
    throw new SsoConfigError(
      "ASSISTANT_SSO_SECRET must be exactly 64 hexadecimal characters."
    );
  }

  const apiBase = readHttpsOrigin(env, "THESTUDENT_API_BASE");
  const webOrigin = readHttpsOrigin(env, "ASSISTANT_WEB_ORIGIN");

  const exchangePath =
    env.ASSISTANT_EXCHANGE_PATH?.trim() || APP_AUTH_ROUTE_PATH;
  if (!exchangePath) {
    throw new SsoConfigError("ASSISTANT_EXCHANGE_PATH is missing.");
  }
  if (exchangePath !== APP_AUTH_ROUTE_PATH) {
    throw new SsoConfigError(
      `ASSISTANT_EXCHANGE_PATH must be ${APP_AUTH_ROUTE_PATH} (the route this site serves).`
    );
  }

  if (!env.AUTH_SECRET) {
    throw new SsoConfigError("AUTH_SECRET is missing.");
  }

  return {
    apiBase,
    exchangePath,
    secret,
    // webOrigin is validated as https, so Auth.js uses its secure cookie name.
    sessionCookieName: SECURE_SESSION_COOKIE,
    webOrigin,
  };
}

/** HttpOnly cookie holding the app's verified session token (handshake). */
export const STUDENT_SESSION_COOKIE = "thestudent_session";

/** Validated THESTUDENT_API_BASE. Throws SsoConfigError when invalid. */
export function getApiBase(env: NodeJS.ProcessEnv = process.env) {
  return readHttpsOrigin(env, "THESTUDENT_API_BASE");
}

/**
 * Just the validated ASSISTANT_WEB_ORIGIN (or null when missing/invalid), for
 * features that need the production origin but not the SSO secret.
 */
export function getWebOrigin(env: NodeJS.ProcessEnv = process.env) {
  try {
    return readHttpsOrigin(env, "ASSISTANT_WEB_ORIGIN");
  } catch {
    return null;
  }
}

/**
 * Production build check (next.config.ts): fails the build for malformed
 * values; a missing ASSISTANT_SSO_SECRET only warns (the one-time-code
 * sign-in stays off, everything else works).
 */
export function checkSsoEnvForBuild(env: NodeJS.ProcessEnv = process.env) {
  readHttpsOrigin(env, "THESTUDENT_API_BASE");
  readHttpsOrigin(env, "ASSISTANT_WEB_ORIGIN");
  if (!env.ASSISTANT_SSO_SECRET) {
    console.warn(
      "[app-auth] ASSISTANT_SSO_SECRET is not set: the one-time-code app sign-in (/api/app-auth) is off. The token handshake still works."
    );
    return;
  }
  parseSsoConfig(env);
}

let cached: SsoConfig | null = null;

/** Validated config, cached after the first success. Throws when invalid. */
export function getSsoConfig(): SsoConfig {
  if (!cached) {
    cached = parseSsoConfig();
  }
  return cached;
}
