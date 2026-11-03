import { NextResponse } from "next/server";

const DEFAULT_API_BASE = "https://app.quizontal.site";
const DEFAULT_WEB_ORIGIN = "https://chatbot-liart-rho-81.vercel.app";
const REQUEST_TIMEOUT_MS = 10_000;

type VersionResponse = {
  api_version?: unknown;
  php_version?: unknown;
  status?: unknown;
};

function httpsOrigin(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(value?.trim() || fallback);
    if (url.protocol === "https:") {
      return url.origin;
    }
  } catch {
    // Use the known HTTPS default for an invalid override.
  }
  return fallback;
}

/** Temporary authenticated probe; remove after verifying Vercel egress. */
export async function GET() {
  const startedAt = Date.now();
  const apiBase = httpsOrigin(process.env.THESTUDENT_API_BASE, DEFAULT_API_BASE);
  const endpoint = new URL("/api/auth.php", apiBase);
  endpoint.searchParams.set("action", "version");

  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: httpsOrigin(
      process.env.ASSISTANT_WEB_ORIGIN,
      DEFAULT_WEB_ORIGIN
    ),
    "User-Agent":
      process.env.THESTUDENT_API_USER_AGENT?.trim() || "TheStudentWeb/1.0",
    "X-TheStudent-Client": "web-assistant",
  });
  const clientKey = process.env.THESTUDENT_WEB_CLIENT_KEY?.trim();
  if (clientKey) {
    headers.set("X-TheStudent-Key", clientKey);
  }

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // The PHP version endpoint currently includes diagnostic request history.
    // Only return these safe version fields; never relay the raw response.
    let payload: VersionResponse | null = null;
    try {
      const value: unknown = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value)) {
        payload = value as VersionResponse;
      }
    } catch {
      // A non-JSON response (for example, an HTML firewall page) is still a
      // successful network connection; the HTTP status below identifies it.
    }

    return NextResponse.json(
      {
        reachable: true,
        phpAccepted: response.ok,
        upstreamHttpStatus: response.status,
        apiStatus:
          typeof payload?.status === "string" ? payload.status : null,
        apiVersion:
          typeof payload?.api_version === "string"
            ? payload.api_version
            : null,
        phpVersion:
          typeof payload?.php_version === "string"
            ? payload.php_version
            : null,
        elapsedMs: Date.now() - startedAt,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      {
        reachable: false,
        error: timedOut ? "upstream_timeout" : "upstream_connection_failed",
        elapsedMs: Date.now() - startedAt,
      },
      {
        headers: { "Cache-Control": "no-store, max-age=0" },
        status: 502,
      }
    );
  }
}
