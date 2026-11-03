import "server-only";

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

/**
 * Server-side TheStudent helpers. Never import this module from client code:
 * it handles session tokens and verifies PHP's Ed25519 web assertions.
 */

export const DEFAULT_THESTUDENT_API_BASE = "https://app.quizontal.site";
export const DEFAULT_ASSISTANT_WEB_ORIGIN =
  "https://chatbot-liart-rho-81.vercel.app";

/** Bearer tokens issued by auth.php: hex, 32-256 chars (normally 64). */
export const TOKEN_PATTERN = /^[A-Fa-f0-9]{32,256}$/;

const DEFAULT_ASSERTION_PUBKEY_SPKI =
  "MCowBQYDK2VwAyEAo/qLSdwO0uNQnrh8EYmxYM1vwnQmvnatklK0bwXcWFM=";
const MAX_ASSERTION_BYTES = 32 * 1024;
const MAX_ASSERTION_LIFETIME_SECONDS = 10 * 60;
const ASSERTION_EXPIRY_LEEWAY_SECONDS = 30;
const ASSERTION_IAT_LEEWAY_SECONDS = 60;
const API_TIMEOUT_MS = 10_000;

function httpsOrigin(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") {
      return url.origin;
    }
  } catch {
    // Fall through to the safe default.
  }
  console.error(`[thestudent] ${name} is not a valid https URL; using default`);
  return fallback;
}

function endpoint(action: string, token?: string): string {
  const base = httpsOrigin("THESTUDENT_API_BASE", DEFAULT_THESTUDENT_API_BASE);
  const url = `${base}/api/auth.php?action=${action}`;
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
}

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: httpsOrigin("ASSISTANT_WEB_ORIGIN", DEFAULT_ASSISTANT_WEB_ORIGIN),
    "User-Agent":
      process.env.THESTUDENT_API_USER_AGENT?.trim() || "TheStudentWeb/1.0",
    "X-TheStudent-Client": "web-assistant",
  };
  const key = process.env.THESTUDENT_WEB_CLIENT_KEY?.trim();
  if (key) {
    headers["X-TheStudent-Key"] = key;
  }
  return headers;
}

function tokenHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-TheStudent-Token": token,
  };
}

export type TheStudentSubject = {
  bucket: string | null;
  code: string;
  examLevel: string | null;
  label: string;
  position: number | null;
};

/** The student profile kept by the chatbot, derived only from signed PHP data. */
export type TheStudentProfile = {
  academicComplete: boolean | null;
  authProvider: string | null;
  avatarUrl: string | null;
  degreeProgramme: string | null;
  email: string;
  examLevel: string | null;
  examYear: number | null;
  expDailyCap: number | null;
  expRank: number | null;
  expTier: string | null;
  expToday: number | null;
  expTotal: number | null;
  institution: string | null;
  isVerified: boolean | null;
  medium: string | null;
  name: string | null;
  phone: string | null;
  profileCompleted: boolean | null;
  role: string | null;
  streamCode: string | null;
  streamOrDegree: string | null;
  studyYear: string | null;
  subjects: TheStudentSubject[];
  targetExam: string | null;
  university: string | null;
  id: number;
};

function str(value: unknown, max = 200): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function finiteInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 0 || value === 1) {
    return value === 1;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function httpsUrl(value: unknown): string | null {
  const raw = str(value, 2048);
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Parse and normalize a user object that has already been signature-verified. */
export function theStudentProfileFromUser(
  raw: unknown
): TheStudentProfile | null {
  const user = asRecord(raw);
  if (!user) {
    return null;
  }
  const id = finiteInteger(user.id);
  const email = str(user.email, 255);
  if (!id || id <= 0 || !email) {
    return null;
  }

  const exp = asRecord(user.exp);
  const subjects: TheStudentSubject[] = [];
  if (Array.isArray(user.subjects)) {
    for (const rawSubject of user.subjects.slice(0, 20)) {
      const subject = asRecord(rawSubject);
      if (!subject) {
        continue;
      }
      const code = str(subject.code, 64);
      const label = str(subject.label, 120);
      if (code && label) {
        subjects.push({
          bucket: str(subject.bucket, 64),
          code,
          examLevel: str(subject.exam_level ?? subject.level, 32),
          label,
          position: finiteInteger(subject.position),
        });
      }
    }
  }

  return {
    academicComplete: bool(user.academic_completed ?? user.academic_complete),
    authProvider: str(user.auth_provider, 40),
    avatarUrl: httpsUrl(user.avatar_url) ?? httpsUrl(user.profile_picture),
    degreeProgramme: str(user.degree_programme),
    email,
    examLevel: str(user.exam_level, 32),
    examYear: finiteInteger(user.exam_year),
    expDailyCap: finiteInteger(user.exp_daily_cap ?? exp?.daily_cap),
    expRank: finiteInteger(exp?.rank),
    expTier: str(user.exp_tier ?? exp?.tier, 40),
    expToday: finiteInteger(user.exp_today ?? exp?.today),
    expTotal: finiteInteger(user.exp_total ?? exp?.total),
    id,
    institution: str(user.institution),
    isVerified: bool(user.is_email_verified ?? user.is_verified),
    medium: str(user.medium, 40),
    name: str(user.full_name ?? user.name, 120),
    phone: str(user.phone, 40),
    profileCompleted: bool(user.profile_completed),
    role: str(user.role, 40),
    streamCode: str(user.stream_code, 64),
    streamOrDegree: str(user.stream_or_degree),
    studyYear: str(user.study_year, 32),
    subjects,
    targetExam: str(user.target_exam),
    university: str(user.university),
  };
}

/** "2026-12-03 14:22:10" (server time, assumed UTC) -> epoch ms. */
export function parseTheStudentExpiry(value: unknown): number | null {
  const raw = str(value, 40);
  if (!raw) {
    return null;
  }
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(" ", "T")}Z`
      : raw
  );
  return Number.isFinite(ms) ? ms : null;
}

export type TheStudentWebAssertionClaims = {
  aud: string;
  exp: number;
  expires_at: string;
  iat: number;
  iss: string;
  token_hash: string;
  user: Record<string, unknown>;
};

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    return null;
  }
  const unpadded = value.replace(/[=]+$/, "");
  const decoded = Buffer.from(unpadded, "base64url");
  return decoded.toString("base64url") === unpadded ? decoded : null;
}

/**
 * Verify auth.php v3.6.7's Ed25519 assertion. The signature covers the exact
 * ASCII payload segment, not the decoded JSON. When rawToken is supplied, the
 * signed token_hash is required and compared in constant time.
 */
export function verifyTheStudentWebAssertion(
  assertion: string,
  rawToken?: string
): TheStudentWebAssertionClaims | null {
  const compact = assertion.trim();
  if (!compact || compact.length > MAX_ASSERTION_BYTES) {
    return null;
  }
  const parts = compact.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) {
    return null;
  }

  const payloadBytes = decodeBase64Url(payloadB64);
  const signatureBytes = decodeBase64Url(signatureB64);
  if (!payloadBytes || !signatureBytes || signatureBytes.length !== 64) {
    return null;
  }

  let claims: Record<string, unknown>;
  try {
    const encodedKey =
      process.env.THESTUDENT_ASSERTION_PUBKEY_SPKI?.trim() ||
      DEFAULT_ASSERTION_PUBKEY_SPKI;
    const publicKeyBytes = Buffer.from(encodedKey, "base64");
    if (!encodedKey || publicKeyBytes.toString("base64") !== encodedKey) {
      return null;
    }
    const publicKey = createPublicKey({
      format: "der",
      key: publicKeyBytes,
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return null;
    }
    if (
      !verifySignature(
        null,
        Buffer.from(payloadB64, "utf8"),
        publicKey,
        signatureBytes
      )
    ) {
      return null;
    }
    claims = asRecord(JSON.parse(payloadBytes.toString("utf8"))) ?? {};
  } catch {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expectedAudience = httpsOrigin(
    "ASSISTANT_WEB_ORIGIN",
    DEFAULT_ASSISTANT_WEB_ORIGIN
  );
  if (claims.iss !== DEFAULT_THESTUDENT_API_BASE) {
    return null;
  }
  if (claims.aud !== expectedAudience) {
    return null;
  }
  if (
    typeof claims.iat !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > nowSeconds + ASSERTION_IAT_LEEWAY_SECONDS
  ) {
    return null;
  }
  if (
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    nowSeconds > claims.exp + ASSERTION_EXPIRY_LEEWAY_SECONDS ||
    claims.exp < claims.iat ||
    claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS
  ) {
    return null;
  }
  const tokenExpiresAt = parseTheStudentExpiry(claims.expires_at);
  if (
    typeof claims.expires_at !== "string" ||
    !tokenExpiresAt ||
    tokenExpiresAt <= Date.now()
  ) {
    return null;
  }

  const tokenHash = claims.token_hash;
  if (typeof tokenHash !== "string" || !/^[a-fA-F0-9]{64}$/.test(tokenHash)) {
    return null;
  }
  if (rawToken !== undefined) {
    const normalizedToken = rawToken.trim();
    if (!TOKEN_PATTERN.test(normalizedToken)) {
      return null;
    }
    const expectedHash = createHash("sha256").update(normalizedToken).digest();
    const actualHash = Buffer.from(tokenHash, "hex");
    if (
      actualHash.length !== expectedHash.length ||
      !timingSafeEqual(actualHash, expectedHash)
    ) {
      return null;
    }
  }

  const user = asRecord(claims.user);
  if (!theStudentProfileFromUser(user)) {
    return null;
  }

  return claims as TheStudentWebAssertionClaims;
}

/**
 * Best-effort revocation. The local encrypted session is cleared even if the
 * external API is temporarily unreachable.
 */
export async function revokeToken(token: string): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) {
    return;
  }
  try {
    const response = await fetch(endpoint("logout", token), {
      body: "{}",
      cache: "no-store",
      headers: { ...baseHeaders(), ...tokenHeaders(token) },
      method: "POST",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[thestudent] logout failed (${response.status})`);
    }
  } catch {
    console.warn("[thestudent] logout unreachable");
  }
}

/** One line under the student's name in the sidebar. */
export function studentLine(profile: TheStudentProfile): string {
  return profile.streamOrDegree ?? profile.targetExam ?? profile.email;
}
