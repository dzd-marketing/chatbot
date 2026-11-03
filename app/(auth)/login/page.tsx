"use client";

import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "lucide-react";
import Form from "next/form";
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useFormStatus } from "react-dom";

import { BrandMark, LoaderIcon } from "@/components/chat/icons";
import {
  describeAppBridge,
  HANDSHAKE_EVENT,
  LOGGED_OUT_FLAG,
  looksLikeAppWebView,
  readAppToken,
  waitForAppToken,
} from "@/lib/thestudent/android";
import { type LoginActionState, login } from "../actions";

const FIELD =
  "h-11 w-full rounded-xl border border-border/70 bg-background/60 pr-3 pl-10 text-[14px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus:border-brand/60 focus:ring-4 focus:ring-brand/10";

const NOT_IN_APP =
  "Please open this screen inside TheStudent Android App to use 1-tap app login, or sign in above with your TheStudent email and password.";

function goToChat() {
  try {
    sessionStorage.removeItem(LOGGED_OUT_FLAG);
  } catch {
    // storage unavailable
  }
  // Full navigation so every part of the app picks up the new session.
  window.location.replace("/");
}

function LoginButton({ done }: { done: boolean }) {
  const { pending } = useFormStatus();
  const busy = pending || done;

  return (
    <button
      aria-disabled={busy}
      className="relative flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-brand font-medium text-[14px] text-brand-foreground shadow-sm transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:cursor-default disabled:opacity-80"
      disabled={busy}
      type="submit"
    >
      {busy ? (
        <span className="animate-spin">
          <LoaderIcon />
        </span>
      ) : (
        "Log in"
      )}
      <output aria-live="polite" className="sr-only">
        {busy ? "Logging in" : ""}
      </output>
    </button>
  );
}

export default function Page() {
  const [email, setEmail] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);
  const [appBusy, setAppBusy] = useState(false);
  const [appMessage, setAppMessage] = useState<string | null>(null);
  const [appDetails, setAppDetails] = useState<string | null>(null);
  const appBusyRef = useRef(false);

  const [state, formAction] = useActionState<LoginActionState, FormData>(
    login,
    { status: "idle" }
  );

  useEffect(() => {
    if (state.status === "success") {
      setDone(true);
      goToChat();
    }
  }, [state]);

  /** Sends the app's token to the server, which verifies it with auth.php. */
  const loginWithToken = useCallback(
    async (token: string, { quiet }: { quiet: boolean }) => {
      if (appBusyRef.current) {
        return;
      }
      appBusyRef.current = true;
      setAppBusy(true);
      setAppMessage(null);
      setAppDetails(null);
      try {
        const response = await fetch("/api/auth/login-token", {
          body: JSON.stringify({ token }),
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (response.ok) {
          setDone(true);
          goToChat();
          return;
        }
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        if (!quiet) {
          setAppMessage(data.message ?? "App login failed. Please try again.");
        }
      } catch {
        if (!quiet) {
          setAppMessage("Network error. Please check your connection.");
        }
      }
      appBusyRef.current = false;
      setAppBusy(false);
    },
    []
  );

  // Inside the Android app: sign in automatically with the app's session,
  // unless the student just logged out of this site.
  useEffect(() => {
    let blocked = false;
    try {
      blocked = sessionStorage.getItem(LOGGED_OUT_FLAG) === "1";
    } catch {
      // storage unavailable
    }
    if (blocked) {
      return;
    }

    const token = readAppToken();
    if (token) {
      loginWithToken(token, { quiet: true });
    }

    // A handshake that arrives later (the capture script fires this event).
    const onHandshake = () => {
      const late = readAppToken();
      if (late) {
        loginWithToken(late, { quiet: true });
      }
    };
    window.addEventListener(HANDSHAKE_EVENT, onHandshake);
    return () => window.removeEventListener(HANDSHAKE_EVENT, onHandshake);
  }, [loginWithToken]);

  const handleAppLogin = useCallback(async () => {
    if (appBusyRef.current) {
      return;
    }
    setAppMessage(null);
    setAppDetails(null);
    setAppBusy(true);
    // The app may still be about to send its handshake: give it a moment.
    const token = await waitForAppToken(1500);
    setAppBusy(false);
    if (!token) {
      setAppMessage(NOT_IN_APP);
      // Inside a WebView, say exactly what was missing (for the app dev).
      setAppDetails(looksLikeAppWebView() ? describeAppBridge() : null);
      return;
    }
    loginWithToken(token, { quiet: false });
  }, [loginWithToken]);

  const handleSubmit = useCallback(
    (formData: FormData) => {
      setEmail(String(formData.get("email") ?? ""));
      setAppMessage(null);
      formAction(formData);
    },
    [formAction]
  );

  const togglePassword = useCallback(() => setShowPassword((v) => !v), []);

  const error =
    state.status === "failed" || state.status === "invalid_data"
      ? state.message
      : undefined;

  return (
    <div className="w-full rounded-2xl border border-border/60 bg-card/70 p-6 shadow-[var(--shadow-float)] backdrop-blur-xl sm:p-8">
      <div className="mb-6 flex flex-col gap-1.5 text-center">
        <h1 className="font-semibold text-[22px] text-foreground tracking-tight">
          Welcome back
        </h1>
        <p className="text-[14px] text-muted-foreground">
          Log in with your TheStudent account
        </p>
      </div>

      <Form action={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            className="font-medium text-[13px] text-foreground/80"
            htmlFor="email"
          >
            Email
          </label>
          <div className="relative">
            <MailIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3.5 size-4 text-muted-foreground" />
            <input
              autoComplete="email"
              className={FIELD}
              defaultValue={email}
              id="email"
              name="email"
              placeholder="you@example.com"
              required
              type="email"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            className="font-medium text-[13px] text-foreground/80"
            htmlFor="password"
          >
            Password
          </label>
          <div className="relative">
            <LockIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3.5 size-4 text-muted-foreground" />
            <input
              autoComplete="current-password"
              className={`${FIELD} pr-11`}
              id="password"
              name="password"
              placeholder="Enter your password"
              required
              type={showPassword ? "text" : "password"}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="-translate-y-1/2 absolute top-1/2 right-2 flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={togglePassword}
              type="button"
            >
              {showPassword ? (
                <EyeOffIcon className="size-4" />
              ) : (
                <EyeIcon className="size-4" />
              )}
            </button>
          </div>
        </div>

        {error ? (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <LoginButton done={done} />
      </Form>

      <div className="my-5 flex items-center gap-3 text-[12px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <button
        aria-disabled={appBusy || done}
        className="flex h-11 w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl border border-border/70 bg-background/60 font-medium text-[14px] text-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-80"
        disabled={appBusy || done}
        onClick={handleAppLogin}
        type="button"
      >
        {appBusy ? (
          <span className="animate-spin">
            <LoaderIcon />
          </span>
        ) : (
          <BrandMark size={20} />
        )}
        Login with TheStudent Android App
      </button>

      {appMessage ? (
        <p
          className="mt-3 rounded-lg bg-muted px-3 py-2 text-center text-[13px] text-muted-foreground"
          role="alert"
        >
          {appMessage}
          {appDetails ? (
            <span className="mt-2 block break-words font-mono text-[11px] text-muted-foreground/80">
              {`Details: ${appDetails}`}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
