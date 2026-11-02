import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";

const PUBLIC_PATHS = new Set(["/terms", "/privacy"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Legal pages are public: no guest session needed to read them.
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  if (!token) {
    // Keep the query string: the Android app's first launch carries
    // ?app=android&theme=…&q=… and must survive the guest sign-in hop.
    const { pathname: path, search } = new URL(request.url);
    const redirectUrl = encodeURIComponent(`${path}${search}`);

    return NextResponse.redirect(
      new URL(`${base}/api/auth/guest?redirectUrl=${redirectUrl}`, request.url)
    );
  }

  const isGuest = guestRegex.test(token?.email ?? "");

  if (token && !isGuest && ["/login", "/register"].includes(pathname)) {
    return NextResponse.redirect(new URL(`${base}/`, request.url));
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
