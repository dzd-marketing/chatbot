"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { getChatHistoryPaginationKey } from "@/components/chat/sidebar-history";

/**
 * The TheStudent student signed in through the Android app, for display.
 *
 * - On mount: GET /api/app-session restores a session from the HttpOnly
 *   cookie (no cookie, as in a normal browser: answered at once, no change).
 * - The app sends ONE same-origin handshake after the page loads:
 *     window.postMessage({ type: "THESTUDENT_AUTH_HANDSHAKE", token }, origin)
 *   The token goes straight to POST /api/app-session and is not kept in JS,
 *   localStorage or a readable cookie.
 */

export type StudentUser = {
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  stream_or_degree: string | null;
  target_exam: string | null;
  exam_level: string | null;
  exp_tier: string | null;
};

type StudentSessionState = {
  status: "loading" | "authenticated" | "unauthenticated";
  user: StudentUser | null;
};

type SessionResponse = {
  authenticated?: boolean;
  user?: StudentUser | null;
  accountChanged?: boolean;
};

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const ENDPOINT = `${BASE_PATH}/api/app-session`;
const HANDSHAKE_TYPE = "THESTUDENT_AUTH_HANDSHAKE";
const TOKEN_PATTERN = /^[A-Fa-f0-9]{32,256}$/;

const StudentSessionContext = createContext<StudentSessionState>({
  status: "unauthenticated",
  user: null,
});

export function useStudentSession() {
  return useContext(StudentSessionContext);
}

/** Pulls the token out of a handshake message, or null for anything else. */
function readHandshakeToken(raw: unknown): string | null {
  let value = raw;
  if (typeof value === "string") {
    if (value.length > 1024) {
      return null;
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; token?: unknown };
  return data.type === HANDSHAKE_TYPE &&
    typeof data.token === "string" &&
    TOKEN_PATTERN.test(data.token)
    ? data.token
    : null;
}

export function StudentSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StudentSessionState>({
    status: "loading",
    user: null,
  });
  const { update } = useSession();
  const { mutate } = useSWRConfig();
  const router = useRouter();

  const statusRef = useRef<StudentSessionState["status"]>("loading");

  const setStudent = useCallback((next: StudentSessionState) => {
    statusRef.current = next.status;
    setState(next);
  }, []);

  const apply = useCallback(
    async (response: Response) => {
      // 503: verification temporarily unavailable; keep what we show.
      if (response.status === 503) {
        if (statusRef.current === "loading") {
          setStudent({ status: "unauthenticated", user: null });
        }
        return;
      }
      const data = (await response.json()) as SessionResponse;
      const wasAuthenticated = statusRef.current === "authenticated";
      if (data.authenticated && data.user) {
        setStudent({ status: "authenticated", user: data.user });
      } else {
        setStudent({ status: "unauthenticated", user: null });
        if (wasAuthenticated) {
          // The token stopped working: refresh the site session too (its
          // server check signs out an app session whose cookie is gone).
          update().catch(() => undefined);
        }
      }
      if (data.accountChanged) {
        // Signed in as the student now: refresh the site session, the chat
        // list and server-rendered parts, without reloading the page.
        await update().catch(() => undefined);
        mutate(unstable_serialize(getChatHistoryPaginationKey));
        if (window.location.pathname.startsWith(`${BASE_PATH}/chat/`)) {
          router.push("/");
        } else {
          router.refresh();
        }
      }
    },
    [mutate, router, setStudent, update]
  );

  // Effects below run once; they always call the latest `apply`.
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);

  // Restore an existing session from the HttpOnly cookie.
  useEffect(() => {
    fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin" })
      .then((response) => applyRef.current(response))
      .catch(() => {
        if (statusRef.current === "loading") {
          setStudent({ status: "unauthenticated", user: null });
        }
      });
  }, [setStudent]);

  // The Android app's one-time handshake.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window) {
        return;
      }
      const token = readHandshakeToken(event.data);
      if (!token) {
        return;
      }
      fetch(ENDPOINT, {
        body: JSON.stringify({ token }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
        .then((response) => applyRef.current(response))
        .catch(() => {
          // Offline: the restore on the next load will try again.
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const value = useMemo(() => state, [state]);
  return (
    <StudentSessionContext.Provider value={value}>
      {children}
    </StudentSessionContext.Provider>
  );
}

/** Ends an app session (both cookies). Used by the sidebar's Sign out. */
export async function signOutStudent() {
  await fetch(ENDPOINT, {
    cache: "no-store",
    credentials: "same-origin",
    method: "DELETE",
  }).catch(() => undefined);
}
