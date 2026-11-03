import NextAuth, { type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { upsertTheStudentUser } from "@/lib/db/queries";
import {
  parseTheStudentExpiry,
  studentLine,
  TOKEN_PATTERN,
  theStudentProfileFromUser,
  verifyTheStudentWebAssertion,
} from "@/lib/thestudent/api";
import { authConfig } from "./auth.config";

export type UserType = "guest" | "regular";

/** Session cookie lifetime: 30 days (Max-Age=2592000). */
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
      /** stream_or_degree, else target_exam, else email. */
      studentLine?: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    email?: string | null;
    id?: string;
    studentLine?: string | null;
    tsExpiresAt?: number | null;
    tsId?: number;
    tsToken?: string;
    type: UserType;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id: string;
    studentLine?: string | null;
    tsExpiresAt?: number | null;
    /** TheStudent users.id */
    tsId?: number;
    /** TheStudent bearer token. Lives only in this encrypted HttpOnly cookie. */
    tsToken?: string;
    type: UserType;
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.type = user.type;
        token.name = user.name;
        token.email = user.email;
        token.picture = user.image;
        token.studentLine = user.studentLine;
        token.tsId = user.tsId;
        token.tsToken = user.tsToken;
        token.tsExpiresAt = user.tsExpiresAt;
        return token;
      }

      // The signed PHP assertion authenticates the login. Keep the session
      // bounded by the PHP token expiry; do not make blocked server-side calls.
      if (!(token.tsId && token.tsToken && token.tsExpiresAt)) {
        return null;
      }
      return Date.now() >= token.tsExpiresAt ? null : token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.type = token.type;
        session.user.name = token.name ?? null;
        session.user.email = token.email ?? "";
        session.user.image = token.picture ?? null;
        session.user.studentLine = token.studentLine ?? null;
      }
      return session;
    },
  },
  // Error names only: Auth.js' default logger prints failed queries with
  // their parameters (students' emails and names).
  logger: {
    error(error) {
      // AuthError.type survives minification ("CallbackRouteError", ...).
      const type = (error as { type?: string }).type ?? "AuthError";
      console.error(`[auth] ${type}`);
    },
    warn(code) {
      console.warn(`[auth] ${code}`);
    },
  },
  providers: [
    // Browser login flows submit the PHP-signed assertion. The profile is
    // never trusted from the request body; it comes only from signed claims.
    Credentials({
      async authorize(credentials) {
        const token = String(credentials?.token ?? "");
        const assertion = String(credentials?.web_assertion ?? "");
        if (!TOKEN_PATTERN.test(token)) {
          return null;
        }

        const claims = verifyTheStudentWebAssertion(assertion, token);
        const profile = claims && theStudentProfileFromUser(claims.user);
        const expiresAt = claims && parseTheStudentExpiry(claims.expires_at);
        if (!claims || !profile || !expiresAt || Date.now() >= expiresAt) {
          return null;
        }

        const id = await upsertTheStudentUser(profile);
        return {
          email: profile.email,
          id,
          image: profile.avatarUrl,
          name: profile.name,
          studentLine: studentLine(profile),
          tsExpiresAt: expiresAt,
          tsId: profile.id,
          tsToken: token,
          type: "regular",
        };
      },
      credentials: { token: {}, web_assertion: {} },
      id: "thestudent",
    }),
  ],
  session: { maxAge: SESSION_MAX_AGE, strategy: "jwt" },
});
