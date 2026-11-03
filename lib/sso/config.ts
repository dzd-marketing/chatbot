/**
 * App <-> web SSO configuration, read ONLY from server-side environment
 * variables. Nothing here may be imported into client code: none of these
 * variables are NEXT_PUBLIC_, so they are never inlined into a JS bundle.
 *
 * Kept dependency-free (no "server-only", no path aliases) so next.config.ts
 * can also import it and fail a production build when the config is wrong.
 *
 *   ASSISTANT_SSO_SECRET     64 hex chars, byte-identical to the PHP server's
 *   THESTUDENT_API_BASE      https origin of the PHP API, no trailing slash
 *   ASSISTANT_WEB_ORIGIN     https origin of this site, no trailing slash
 *   ASSISTANT_EXCHANGE_PATH  path the app POSTs the one-time code to
 */

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
  const value = env[name];
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

  const exchangePath = env.ASSISTANT_EXCHANGE_PATH;
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

let cached: SsoConfig | null = null;

/** Validated config, cached after the first success. Throws when invalid. */
export function getSsoConfig(): SsoConfig {
  if (!cached) {
    cached = parseSsoConfig();
  }
  return cached;
}
