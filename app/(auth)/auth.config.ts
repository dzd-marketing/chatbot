import type { NextAuthConfig } from "next-auth";

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Session lifetime (Auth.js' default, now explicit so app SSO matches it). */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const authConfig = {
  basePath: "/api/auth",
  callbacks: {},
  pages: {
    newUser: `${base}/`,
    signIn: `${base}/login`,
  },
  providers: [],
  session: { maxAge: SESSION_MAX_AGE_SECONDS },
  trustHost: true,
} satisfies NextAuthConfig;
