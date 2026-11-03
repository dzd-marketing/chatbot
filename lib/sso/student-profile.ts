import "server-only";

import { createHash } from "node:crypto";
import { getApiBase } from "./config";
import { TheStudentApiError } from "./thestudent-api";

/**
 * Verifies the Android app's session token with TheStudent API
 * (GET <THESTUDENT_API_BASE>/api/auth.php?action=me, Bearer token) and
 * reduces the answer to the few display fields the website shows.
 *
 * The token is never logged, thrown or returned. Successful lookups are
 * cached briefly per instance (keyed by the token's SHA-256, never the raw
 * token) so a page load's restore + handshake costs one API call.
 */

export const STUDENT_TOKEN_PATTERN = /^[A-Fa-f0-9]{32,256}$/;

const ME_PATH = "/api/auth.php?action=me";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

/** What the browser may see: display fields only (no phone, ids, school). */
export type PublicStudent = {
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  stream_or_degree: string | null;
  target_exam: string | null;
  exam_level: string | null;
  exp_tier: string | null;
};

export type VerifiedStudent = {
  /** TheStudent users.id: the only account key (same as the SSO `sub`). */
  sub: string;
  user: PublicStudent;
};

const SUB_PATTERN = /^[1-9]\d{0,19}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const clean = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return clean || null;
}

function email(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const clean = value.trim().toLowerCase();
  return clean.length <= 254 && EMAIL_PATTERN.test(clean) ? clean : null;
}

/** https image URLs only (no javascript:, data:, http:). */
function avatar(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || value.length > 2048) {
      continue;
    }
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) {
        return url.href;
      }
    } catch {
      // Not a URL: try the next one.
    }
  }
  return null;
}

function subOf(value: unknown): string | null {
  const sub =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  return typeof sub === "string" && SUB_PATTERN.test(sub) ? sub : null;
}

function parseMe(data: unknown): VerifiedStudent | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.status !== "success" || !record.user) {
    return null;
  }
  if (typeof record.user !== "object") {
    return null;
  }
  const user = record.user as Record<string, unknown>;
  const sub = subOf(user.id);
  if (!sub) {
    return null;
  }
  return {
    sub,
    user: {
      avatar_url: avatar(user.avatar_url, user.profile_picture),
      email: email(user.email),
      exam_level: text(user.exam_level, 20),
      exp_tier: text(user.exp_tier, 30),
      name: text(user.name, 80),
      stream_or_degree: text(user.stream_or_degree, 80),
      target_exam: text(user.target_exam, 80),
    },
  };
}

type CacheEntry = { at: number; value: VerifiedStudent };
const cache = new Map<string, CacheEntry>();

const tokenKey = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Returns the verified student, or throws TheStudentApiError:
 * `definitive` for an invalid/expired token (401/403/bad answer),
 * otherwise a transient failure (timeout, 5xx) that should not sign out.
 */
export async function verifyStudentToken(
  token: string
): Promise<VerifiedStudent> {
  if (!STUDENT_TOKEN_PATTERN.test(token)) {
    throw new TheStudentApiError("bad_token_format", { definitive: true });
  }
  const key = tokenKey(token);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const apiBase = getApiBase();
  let response: Response;
  try {
    response = await fetch(`${apiBase}${ME_PATH}`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "network";
    throw new TheStudentApiError(reason, { cause: error, definitive: false });
  }

  if (response.status === 401 || response.status === 403) {
    cache.delete(key);
    await response.body?.cancel().catch(() => undefined);
    throw new TheStudentApiError(`http_${response.status}`, {
      definitive: true,
    });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new TheStudentApiError(`http_${response.status}`, {
      definitive: false,
    });
  }

  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) {
    throw new TheStudentApiError("response_too_large", { definitive: false });
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TheStudentApiError("bad_json", {
      cause: error,
      definitive: false,
    });
  }
  const verified = parseMe(data);
  if (!verified) {
    cache.delete(key);
    throw new TheStudentApiError("not_success", { definitive: true });
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.clear();
  }
  cache.set(key, { at: Date.now(), value: verified });
  return verified;
}
