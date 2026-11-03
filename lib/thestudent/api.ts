import "server-only";

import { createHash } from "node:crypto";

/**
 * Server-side client for TheStudent PHP API (auth.php). Never import this
 * from client code: it holds the optional web client key and handles
 * students' bearer tokens. Tokens, passwords and response bodies are never
 * logged; only short reason codes are.
 *
 *   THESTUDENT_API_BASE         https origin of the PHP API (optional)
 *   ASSISTANT_WEB_ORIGIN        https origin of this site (optional)
 *   THESTUDENT_WEB_CLIENT_KEY   sent as X-TheStudent-Key when set (optional)
 *   THESTUDENT_API_USER_AGENT   User-Agent for auth.php calls (optional)
 */

export const DEFAULT_THESTUDENT_API_BASE = "https://app.quizontal.site";
export const DEFAULT_ASSISTANT_WEB_ORIGIN =
  "https://chatbot-liart-rho-81.vercel.app";

/** Bearer tokens issued by auth.php: hex, 32-256 chars (normally 64). */
export const TOKEN_PATTERN = /^[A-Fa-f0-9]{32,256}$/;

const TIMEOUT_MS = 10_000;
const VERIFY_CACHE_MS = 60_000;
const VERIFY_CACHE_MAX = 500;

const UNREACHABLE =
  "TheStudent is not reachable right now. Please try again in a moment.";

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
    // fall through
  }
  console.error(`[thestudent] ${name} is not a valid https URL; using default`);
  return fallback;
}

function endpoint(action: string, token?: string): string {
  const base = httpsOrigin("THESTUDENT_API_BASE", DEFAULT_THESTUDENT_API_BASE);
  const url = `${base}/api/auth.php?action=${action}`;
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
}

/**
 * The server's Apache (DirectAdmin, PHP-FPM) strips the Authorization
 * header, so auth.php (v3.6.3+) also reads X-TheStudent-Token and &token=.
 * Every token call sends all three. Request URLs are never logged here.
 */
function tokenHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-TheStudent-Token": token,
  };
}

/**
 * Identify server-to-server requests truthfully. The firewall must allow the
 * Vercel egress IP; pretending this is Android/OkHttp cannot bypass an IP rule.
 */
const DEFAULT_API_USER_AGENT = "TheStudentWeb/1.0";

/** Sent on EVERY auth.php call (web_login, me, logout). */
function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: httpsOrigin("ASSISTANT_WEB_ORIGIN", DEFAULT_ASSISTANT_WEB_ORIGIN),
    "User-Agent":
      process.env.THESTUDENT_API_USER_AGENT?.trim() || DEFAULT_API_USER_AGENT,
    "X-TheStudent-Client": "web-assistant",
  };
  const key = process.env.THESTUDENT_WEB_CLIENT_KEY?.trim();
  if (key) {
    headers["X-TheStudent-Key"] = key;
  }
  return headers;
}

export type TheStudentSubject = { code: string; label: string };

/** The subset of the auth.php user this site keeps. */
export type TheStudentProfile = {
  id: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  targetExam: string | null;
  streamOrDegree: string | null;
  institution: string | null;
  examLevel: string | null;
  medium: string | null;
  subjects: TheStudentSubject[];
  expTier: string | null;
  role: string | null;
};

function str(value: unknown, max = 200): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
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

function toProfile(raw: unknown): TheStudentProfile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const u = raw as Record<string, unknown>;
  const id = typeof u.id === "string" ? Number(u.id) : u.id;
  const email = str(u.email, 255);
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  if (!email) {
    return null;
  }
  const subjects: TheStudentSubject[] = [];
  if (Array.isArray(u.subjects)) {
    for (const s of u.subjects.slice(0, 20)) {
      const code = str((s as Record<string, unknown>)?.code, 64);
      const label = str((s as Record<string, unknown>)?.label, 120);
      if (code && label) {
        subjects.push({ code, label });
      }
    }
  }
  return {
    avatarUrl: httpsUrl(u.avatar_url) ?? httpsUrl(u.profile_picture),
    email,
    examLevel: str(u.exam_level, 32),
    expTier: str(u.exp_tier, 40),
    id,
    institution: str(u.institution),
    medium: str(u.medium, 40),
    name: str(u.name, 120),
    role: str(u.role, 40),
    streamOrDegree: str(u.stream_or_degree),
    subjects,
    targetExam: str(u.target_exam),
  };
}

/** "2026-12-03 14:22:10" (server time, assumed UTC) -> epoch ms. */
function parseExpiry(value: unknown): number | null {
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await response.json();
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ---- verified-token cache (keyed by a hash, never the token itself) ----

type Verified = { profile: TheStudentProfile; expiresAt: number | null };
const verifiedCache = new Map<string, Verified & { at: number }>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function remember(token: string, verified: Verified) {
  if (verifiedCache.size >= VERIFY_CACHE_MAX) {
    const oldest = verifiedCache.keys().next().value;
    if (oldest) {
      verifiedCache.delete(oldest);
    }
  }
  verifiedCache.set(tokenKey(token), { ...verified, at: Date.now() });
}

export function forgetToken(token: string) {
  verifiedCache.delete(tokenKey(token));
}

// ---- web_login ----

export type WebLoginResult =
  | { ok: true; token: string; profile: TheStudentProfile }
  | { ok: false; message: string };

export async function webLogin(
  email: string,
  password: string
): Promise<WebLoginResult> {
  let response: Response;
  try {
    response = await fetch(endpoint("web_login"), {
      body: JSON.stringify({ client: "web", email, password }),
      cache: "no-store",
      headers: baseHeaders(),
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn("[thestudent] web_login unreachable");
    return { message: UNREACHABLE, ok: false };
  }

  const data = await readJson(response);
  if (!response.ok || data.status !== "success") {
    console.warn(`[thestudent] web_login rejected (${response.status})`);
    const firewallBlock = response.status === 403 && data.status !== "error";
    const message =
      str(data.message, 200) ??
      (response.status >= 500 || firewallBlock
        ? UNREACHABLE
        : "Could not log you in.");
    return { message, ok: false };
  }

  const token = typeof data.token === "string" ? data.token : "";
  const profile = toProfile(data.user);
  if (!(TOKEN_PATTERN.test(token) && profile)) {
    console.warn("[thestudent] web_login returned an unexpected payload");
    return { message: UNREACHABLE, ok: false };
  }

  remember(token, { expiresAt: parseExpiry(data.expires_at), profile });
  return { ok: true, profile, token };
}

// ---- me (token verification) ----

export type VerifyResult =
  | ({ ok: true } & Verified)
  /** Definitive: auth.php returned 401 or a JSON auth error (403). */
  | { ok: false; definitive: boolean };

export async function verifyToken(token: string): Promise<VerifyResult> {
  if (!TOKEN_PATTERN.test(token)) {
    return { definitive: true, ok: false };
  }
  const cached = verifiedCache.get(tokenKey(token));
  if (cached && Date.now() - cached.at < VERIFY_CACHE_MS) {
    return { expiresAt: cached.expiresAt, ok: true, profile: cached.profile };
  }

  let response: Response;
  try {
    response = await fetch(endpoint("me", token), {
      cache: "no-store",
      headers: { ...baseHeaders(), ...tokenHeaders(token) },
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn("[thestudent] me unreachable");
    return { definitive: false, ok: false };
  }

  if (response.status === 401) {
    console.warn("[thestudent] me rejected the token (401)");
    forgetToken(token);
    return { definitive: true, ok: false };
  }
  if (response.status === 403) {
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    const data = await readJson(response);
    // The host's firewall returns an HTML 403 before PHP executes. Only
    // treat a JSON auth.php error as a definitive token rejection.
    if (contentType.includes("application/json") && data.status === "error") {
      console.warn("[thestudent] me rejected the token (403)");
      forgetToken(token);
      return { definitive: true, ok: false };
    }
    console.warn("[thestudent] me blocked before auth.php (403)");
    return { definitive: false, ok: false };
  }
  const data = await readJson(response);
  const profile =
    response.ok && data.status === "success" && toProfile(data.user);
  if (!profile) {
    console.warn(`[thestudent] me failed (${response.status})`);
    return { definitive: false, ok: false };
  }

  const verified = { expiresAt: parseExpiry(data.expires_at), profile };
  remember(token, verified);
  return { ok: true, ...verified };
}

// ---- logout ----

export async function revokeToken(token: string): Promise<void> {
  forgetToken(token);
  if (!TOKEN_PATTERN.test(token)) {
    return;
  }
  try {
    const response = await fetch(endpoint("logout", token), {
      body: "{}",
      cache: "no-store",
      headers: {
        ...baseHeaders(),
        ...tokenHeaders(token),
      },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
