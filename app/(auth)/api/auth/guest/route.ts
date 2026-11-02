import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { signIn } from "@/app/(auth)/auth";
import { isDevelopmentEnvironment } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawRedirect = searchParams.get("redirectUrl") || "/";
  const redirectUrl =
    rawRedirect.startsWith("/") &&
    !rawRedirect.startsWith("//") &&
    !rawRedirect.startsWith("/\\")
      ? rawRedirect
      : "/";

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  if (token) {
    // Already signed in: go where the caller wanted (keeps the Android
    // app's ?app=android&theme=…&q=…), never back into the auth routes.
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const target =
      searchParams.has("redirectUrl") &&
      !redirectUrl.startsWith(`${base}/api/auth`)
        ? redirectUrl
        : `${base}/`;
    return NextResponse.redirect(new URL(target, request.url));
  }

  return signIn("guest", { redirect: true, redirectTo: redirectUrl });
}
