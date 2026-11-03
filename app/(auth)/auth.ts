import NextAuth, { type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { upsertTheStudentUser } from "@/lib/db/queries";
import {
  studentLine,
  type TheStudentProfile,
  TOKEN_PATTERN,
  verifyToken,
} from "@/lib/thestudent/api";
import { authConfig } from "./auth.config";

export type UserType = "guest" | "regular";

/** How often a signed-in session re-checks its token with auth.php. */
const RECHECK_MS = 10 * 60 * 1000;
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
    tsCheckedAt?: number;
    tsExpiresAt?: number | null;
    /** TheStudent users.id */
    tsId?: number;
    /** TheStudent bearer token. Lives only in this encrypted HttpOnly cookie. */
    tsToken?: string;
    type: UserType;
  }
}

function applyProfile(
  token: {
    name?: string | null;
    email?: string | null;
    picture?: string | null;
    studentLine?: string | null;
  },
  profile: TheStudentProfile
) {
  token.name = profile.name;
  token.email = profile.email;
  token.picture = profile.avatarUrl;
  token.studentLine = studentLine(profile);
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  callbacks: {
    async jwt({ token, user }) {
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
        token.tsCheckedAt = Date.now();
        return token;
      }

      // Only TheStudent sessions are valid (old guest/local sessions end).
      if (!(token.tsId && token.tsToken)) {
        return null;
      }
      if (token.tsExpiresAt && Date.now() >= token.tsExpiresAt) {
        return null;
      }
      if (Date.now() - (token.tsCheckedAt ?? 0) < RECHECK_MS) {
        return token;
      }

      const result = await verifyToken(token.tsToken);
      if (result.ok) {
        if (result.profile.id !== token.tsId) {
          return null;
        }
        applyProfile(token, result.profile);
        token.tsExpiresAt = result.expiresAt;
        token.tsCheckedAt = Date.now();
        return token;
      }
      // Revoked/expired token ends the session; a network blip does not.
      return result.definitive ? null : token;
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
    // Both login flows end here with a TheStudent bearer token, which is
    // trusted only after auth.php confirms it (action=me, or the result of
    // web_login a moment earlier, cached by token hash).
    Credentials({
      async authorize(credentials) {
        const token = String(credentials?.token ?? "");
        if (!TOKEN_PATTERN.test(token)) {
          return null;
        }
        const result = await verifyToken(token);
        if (!result.ok) {
          return null;
        }
        const { profile } = result;
        const id = await upsertTheStudentUser(profile);
        return {
          email: profile.email,
          id,
          image: profile.avatarUrl,
          name: profile.name,
          studentLine: studentLine(profile),
          tsExpiresAt: result.expiresAt,
          tsId: profile.id,
          tsToken: token,
          type: "regular",
        };
      },
      credentials: { token: {} },
      id: "thestudent",
    }),
  ],
  session: { maxAge: SESSION_MAX_AGE, strategy: "jwt" },
});
