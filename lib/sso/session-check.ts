import "server-only";

import { cookies } from "next/headers";
import { SsoConfigError, STUDENT_SESSION_COOKIE } from "./config";
import { STUDENT_TOKEN_PATTERN, verifyStudentToken } from "./student-profile";
import { TheStudentApiError, validateAccount } from "./thestudent-api";

/**
 * Re-checks an app session with TheStudent API: SSO sessions with the
 * signed action=validate call, handshake sessions with action=me using the
 * token in the HttpOnly thestudent_session cookie.
 *
 * - At most once per CHECK_INTERVAL per account; the last good check time
 *   lives in the (encrypted, HttpOnly) session token and in a per-instance
 *   cache, because Server Components can't rewrite the cookie.
 * - `active !== true`, a 4xx answer or missing SSO config: signed out.
 * - Timeouts / 5xx: kept for now and retried shortly, but a session that
 *   can't be verified for MAX_UNVERIFIED is signed out (fails closed).
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const MAX_UNVERIFIED_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;

type CacheEntry = { checkedAt: number; retryAt: number };
const cache = new Map<string, CacheEntry>();

export type SessionCheck =
  | { active: false }
  | { active: true; checkedAt: number };

async function checkWith(
  cacheKey: string,
  tokenCheckedAt: number | undefined,
  validate: () => Promise<boolean>
): Promise<SessionCheck> {
  const now = Date.now();
  const entry = cache.get(cacheKey);
  const lastGood = Math.max(tokenCheckedAt ?? 0, entry?.checkedAt ?? 0);

  if (now - lastGood < CHECK_INTERVAL_MS) {
    return { active: true, checkedAt: lastGood };
  }
  const stillTrusted = now - lastGood < MAX_UNVERIFIED_MS;
  if (entry && entry.retryAt > now) {
    return stillTrusted
      ? { active: true, checkedAt: lastGood }
      : { active: false };
  }

  try {
    const active = await validate();
    if (!active) {
      cache.delete(cacheKey);
      return { active: false };
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      cache.clear();
    }
    cache.set(cacheKey, { checkedAt: now, retryAt: 0 });
    return { active: true, checkedAt: now };
  } catch (error) {
    if (error instanceof SsoConfigError) {
      console.error(`[app-auth] SSO config invalid: ${error.message}`);
      return { active: false };
    }
    if (error instanceof TheStudentApiError && error.definitive) {
      console.warn(`[app-auth] session check rejected (${error.reason})`);
      cache.delete(cacheKey);
      return { active: false };
    }
    const reason =
      error instanceof TheStudentApiError ? error.reason : "unexpected";
    console.warn(`[app-auth] session check unavailable (${reason})`);
    cache.set(cacheKey, {
      checkedAt: entry?.checkedAt ?? 0,
      retryAt: now + RETRY_AFTER_FAILURE_MS,
    });
    return stillTrusted
      ? { active: true, checkedAt: lastGood }
      : { active: false };
  }
}

/** SSO session (from /api/app-auth): signed action=validate. */
export function checkAppSession(
  sub: string,
  tokenCheckedAt: number | undefined
): Promise<SessionCheck> {
  return checkWith(`sso:${sub}`, tokenCheckedAt, () => validateAccount(sub));
}

/**
 * Handshake session (from /api/app-session): it lives only as long as the
 * HttpOnly token cookie exists, and the token must still belong to `sub`.
 */
export async function checkStudentTokenSession(
  sub: string,
  tokenCheckedAt: number | undefined
): Promise<SessionCheck> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(STUDENT_SESSION_COOKIE)?.value;
  } catch {
    // Outside a request (no cookies to read): keep the last result.
    return tokenCheckedAt
      ? { active: true, checkedAt: tokenCheckedAt }
      : { active: false };
  }
  if (!(token && STUDENT_TOKEN_PATTERN.test(token))) {
    return { active: false };
  }
  return checkWith(`token:${sub}`, tokenCheckedAt, async () => {
    const verified = await verifyStudentToken(token);
    return verified.sub === sub;
  });
}
