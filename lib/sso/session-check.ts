import "server-only";

import { SsoConfigError } from "./config";
import { TheStudentApiError, validateAccount } from "./thestudent-api";

/**
 * Re-checks an app SSO session with TheStudent API (action=validate).
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

export async function checkAppSession(
  sub: string,
  tokenCheckedAt: number | undefined
): Promise<SessionCheck> {
  const now = Date.now();
  const entry = cache.get(sub);
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
    const active = await validateAccount(sub);
    if (!active) {
      cache.delete(sub);
      return { active: false };
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      cache.clear();
    }
    cache.set(sub, { checkedAt: now, retryAt: 0 });
    return { active: true, checkedAt: now };
  } catch (error) {
    if (error instanceof SsoConfigError) {
      console.error(`[app-auth] SSO config invalid: ${error.message}`);
      return { active: false };
    }
    if (error instanceof TheStudentApiError && error.definitive) {
      console.warn(`[app-auth] session check rejected (${error.reason})`);
      cache.delete(sub);
      return { active: false };
    }
    const reason =
      error instanceof TheStudentApiError ? error.reason : "unexpected";
    console.warn(`[app-auth] session check unavailable (${reason})`);
    cache.set(sub, {
      checkedAt: entry?.checkedAt ?? 0,
      retryAt: now + RETRY_AFTER_FAILURE_MS,
    });
    return stillTrusted
      ? { active: true, checkedAt: lastGood }
      : { active: false };
  }
}
