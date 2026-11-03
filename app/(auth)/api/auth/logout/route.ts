import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { signOut } from "@/app/(auth)/auth";
import { isDevelopmentEnvironment } from "@/lib/constants";
import { revokeToken } from "@/lib/thestudent/api";
import { isSameOrigin, NO_STORE } from "@/lib/thestudent/same-origin";

/**
 * Log out: revokes the TheStudent token (auth.php?action=logout, best
 * effort) and clears this site's session cookie.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false }, { headers: NO_STORE, status: 403 });
  }

  const jwt = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });
  if (jwt?.tsToken) {
    await revokeToken(jwt.tsToken);
  }

  await signOut({ redirect: false });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
