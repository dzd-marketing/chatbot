import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isDevelopmentEnvironment } from "./lib/constants";

const PUBLIC_PATHS = new Set(["/terms", "/privacy"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Legal pages are public: no session needed to read them.
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  // Sign-up is gone: the old page sends people to the login screen.
  if (pathname === "/register") {
    return NextResponse.redirect(new URL(`${base}/login`, request.url));
  }

  // Login is required, and only TheStudent sessions count (old guest/local
  // sessions don't). PHP's signed assertion is verified at login, and the
  // session is bounded by the PHP token's expires_at.
  const signedIn =
    typeof token?.tsId === "number" &&
    typeof token.tsExpiresAt === "number" &&
    Date.now() < token.tsExpiresAt;

  if (pathname === "/login") {
    return signedIn
      ? NextResponse.redirect(new URL(`${base}/`, request.url))
      : NextResponse.next();
  }

  if (!signedIn) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL(`${base}/login`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    // Static metadata assets (icons, social preview images) and the logos in
    // public/brand must stay public so browsers, the sign-in page and
    // link-preview crawlers can fetch them without a session.
    "/((?!_next/static|_next/image|brand/|favicon.ico|icon.png|apple-icon.png|opengraph-image|twitter-image|sitemap.xml|robots.txt).*)",
  ],
};
