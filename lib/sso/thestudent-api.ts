import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";
import { getSsoConfig } from "./config";

/**
 * Server-to-server calls to TheStudent PHP API, signed with
 * ASSISTANT_SSO_SECRET. Never called from the browser.
 *
 *   canonical = "POST\n" + pathAndQuery + "\n" + timestamp + "\n" + nonce
 *               + "\n" + sha256Hex(rawBody)
 *   X-TheStudent-Signature = hex(HMAC_SHA256(canonical, secret))
 *
 * Nothing sensitive is ever logged or thrown: errors carry a short reason
 * code only (no URL, body, code, verifier or state).
 */

const ENDPOINT = "/api/assistant_session.php";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type Action = "exchange" | "validate";

export class TheStudentApiError extends Error {
  /** Short, log-safe reason, e.g. "http_401", "timeout", "bad_response". */
  readonly reason: string;
  /** True for definitive rejections (4xx), false for transient failures. */
  readonly definitive: boolean;

  constructor(
    reason: string,
    { definitive, ...options }: ErrorOptions & { definitive: boolean }
  ) {
    super(`TheStudent API request failed: ${reason}`, options);
    this.name = "TheStudentApiError";
    this.reason = reason;
    this.definitive = definitive;
  }
}

const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** 32 chars of [A-Za-z0-9_-]; fresh for every request. */
const createNonce = () => randomBytes(24).toString("base64url");

/** Exported for tests. */
export function signRequest({
  body,
  nonce,
  pathAndQuery,
  secret,
  timestamp,
}: {
  body: string;
  nonce: string;
  pathAndQuery: string;
  secret: string;
  timestamp: string;
}) {
  const canonical = `POST\n${pathAndQuery}\n${timestamp}\n${nonce}\n${sha256Hex(body)}`;
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new TheStudentApiError("response_too_large", { definitive: false });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TheStudentApiError("bad_json", {
      cause: error,
      definitive: response.ok,
    });
  }
}

async function callApi(action: Action, payload: object): Promise<unknown> {
  const { apiBase, secret } = getSsoConfig();
  const pathAndQuery = `${ENDPOINT}?action=${action}`;
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = createNonce();
  const signature = signRequest({
    body,
    nonce,
    pathAndQuery,
    secret,
    timestamp,
  });

  let response: Response;
  try {
    response = await fetch(`${apiBase}${pathAndQuery}`, {
      body,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-TheStudent-Nonce": nonce,
        "X-TheStudent-Signature": signature,
        "X-TheStudent-Timestamp": timestamp,
      },
      method: "POST",
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

  if (!response.ok) {
    // Drain without reading it into logs or errors.
    await response.body?.cancel().catch(() => undefined);
    const definitive =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429;
    throw new TheStudentApiError(`http_${response.status}`, { definitive });
  }
  return readJson(response);
}

/* ------------------------------------------------------------------------ */

export type AppAccount = {
  /** Opaque numeric users.id from TheStudent: the ONLY account key. */
  sub: string;
  /** Display only. */
  name: string | null;
  /** Display only. Never used to look up or link accounts. */
  email: string | null;
};

const SUB_PATTERN = /^[1-9]\d{0,19}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

function readSub(value: unknown): string | null {
  const sub =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  return typeof sub === "string" && SUB_PATTERN.test(sub) ? sub : null;
}

function readName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return name || null;
}

function readEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/** Accepts `{ sub, name, email }` at the top level or under `user` / `data`. */
function unwrap(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.ok === false || record.success === false || record.error) {
    return null;
  }
  for (const key of ["user", "data"] as const) {
    const nested = record[key];
    if (
      record.sub === undefined &&
      nested &&
      typeof nested === "object" &&
      (nested as Record<string, unknown>).sub !== undefined
    ) {
      return nested as Record<string, unknown>;
    }
  }
  return record;
}

/** Redeems the app's one-time code. Throws TheStudentApiError on failure. */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  state: string;
}): Promise<AppAccount> {
  const data = unwrap(
    await callApi("exchange", {
      code: input.code,
      code_verifier: input.codeVerifier,
      state: input.state,
    })
  );
  const sub = readSub(data?.sub);
  if (!(data && sub)) {
    throw new TheStudentApiError("bad_response", { definitive: true });
  }
  return { email: readEmail(data.email), name: readName(data.name), sub };
}

/** `true` only when the API answers `active: true` for this account. */
export async function validateAccount(sub: string): Promise<boolean> {
  // `sub` is a numeric users.id: send it as a JSON number when it fits.
  const numeric = Number(sub);
  const data = unwrap(
    await callApi("validate", {
      sub: Number.isSafeInteger(numeric) ? numeric : sub,
    })
  );
  return data?.active === true;
}
