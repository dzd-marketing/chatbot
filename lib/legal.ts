/**
 * Legal page links shown on the welcome screen ("By using TheStudent AI, you
 * agree to our Terms and Privacy Policy").
 *
 * PLACEHOLDERS: these point to the in-app placeholder pages at /terms and
 * /privacy until the real pages exist on TheStudent's website. When they
 * are published, replace the two values with the full website URLs, e.g.
 *   TERMS_URL   = "https://your-website.example/terms"
 *   PRIVACY_URL = "https://your-website.example/privacy-policy"
 * The placeholder pages (app/(legal)/...) can then be deleted, along with
 * the matching entries in proxy.ts.
 */
export const TERMS_URL = "/terms";
export const PRIVACY_URL = "/privacy";

/** External (website) links open in a new tab; in-app placeholders don't. */
export const isExternalUrl = (url: string) => /^https?:\/\//.test(url);
