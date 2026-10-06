import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Download links for files shown in download cards. The file comes through
 * /api/files/download so it downloads right in the chat. Links are signed
 * with AUTH_SECRET, so the route only serves files DZD AI actually shared
 * (it can't be used as an open proxy or redirect).
 */

const secret = () => process.env.AUTH_SECRET ?? "";

function signature(url: string, name: string) {
  return createHmac("sha256", secret())
    .update(`dzd-download\n${url}\n${name}`)
    .digest("base64url");
}

/** A relative link to /api/files/download, or undefined without a secret. */
export function signedDownloadPath(url: string, name: string) {
  if (!secret()) {
    return;
  }
  const params = new URLSearchParams({
    n: name,
    s: signature(url, name),
    u: url,
  });
  return `/api/files/download?${params.toString()}`;
}

export function verifyDownload(params: URLSearchParams) {
  const url = params.get("u") ?? "";
  const name = params.get("n") ?? "";
  const given = Buffer.from(params.get("s") ?? "");
  const expected = Buffer.from(signature(url, name));
  if (
    !(url && secret()) ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  ) {
    return null;
  }
  return { name, url };
}
