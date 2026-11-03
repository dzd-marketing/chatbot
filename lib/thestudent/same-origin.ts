import "server-only";

/** Headers for every auth route response. */
export const NO_STORE = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * True when the request comes from a page on this same site: the Origin
 * header must match the host the request was sent to.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}
