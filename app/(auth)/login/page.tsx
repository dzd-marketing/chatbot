"use client";

import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { BrandMark, LoaderIcon } from "@/components/chat/icons";
import {
  describeAppBridge,
  HANDSHAKE_EVENT,
  LOGGED_OUT_FLAG,
  looksLikeAppWebView,
  readAppToken,
  waitForAppToken,
} from "@/lib/thestudent/android";

const THESTUDENT_AUTH_URL = "https://app.quizontal.site/api/auth.php";
const FIELD =
  "h-11 w-full rounded-xl border border-border/70 bg-background/60 pr-3 pl-10 text-[14px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus:border-brand/60 focus:ring-4 focus:ring-brand/10";
const NOT_IN_APP =
  "Please open this screen inside TheStudent Android App to use 1-tap app login, or sign in above with your TheStudent email and password.";

async function readApiResponse(
  response: Response
): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await response.json();
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function responseMessage(
  data: Record<string, unknown>,
  fallback: string
): string {
  return typeof data.message === "string" && data.message.trim()
    ? data.message.trim().slice(0, 240)
    : fallback;
}

function hasUser(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function goToChat() {
  try {
    sessionStorage.removeItem(LOGGED_OUT_FLAG);
  } catch {
    // Storage unavailable.
  }
  // Full navigation so every part of the app picks up the new session.
  window.location.replace("/");
}

function LoginButton({ busy }: { busy: boolean }) {
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
  const [formBusy, setFormBusy] = useState(false);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [appMessage, setAppMessage] = useState<string | null>(null);
  const [appDetails, setAppDetails] = useState<string | null>(null);
  const appBusyRef = useRef(false);
  const formBusyRef = useRef(false);

  const establishSession = useCallback(
    async (token: string, webAssertion: string) => {
      let response: Response;
      try {
        response = await fetch("/api/auth/login-token", {
          body: JSON.stringify({ token, web_assertion: webAssertion }),
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      } catch (cause) {
        throw new Error("Could not start your session. Please try again.", {
          cause,
        });
      }
      const data = await readApiResponse(response);
      if (!response.ok) {
        throw new Error(
          responseMessage(
            data,
            "Could not start your session. Please try again."
          )
        );
      }
      setDone(true);
      goToChat();
    },
    []
  );

  /** The browser verifies with PHP directly; only the signed assertion is trusted by Next.js. */
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
        // No custom headers: this GET remains a CORS-simple request.
        let verifyResponse: Response;
        try {
          verifyResponse = await fetch(
            `${THESTUDENT_AUTH_URL}?action=me&token=${encodeURIComponent(token)}`,
            { cache: "no-store", credentials: "omit" }
          );
        } catch (cause) {
          throw new Error(
            "TheStudent could not be reached. Please try again.",
            {
              cause,
            }
          );
        }
        const verifyData = await readApiResponse(verifyResponse);
        const webAssertion =
          typeof verifyData.web_assertion === "string"
            ? verifyData.web_assertion
            : "";
        if (
          !verifyResponse.ok ||
          verifyData.status !== "success" ||
          !hasUser(verifyData.user) ||
          !webAssertion
        ) {
          const fallbackMessage =
            verifyResponse.status === 401
              ? "Your TheStudent app session has expired. Sign in again in the app, or use your email and password."
              : "TheStudent could not verify this app session. Please try again.";
          throw new Error(responseMessage(verifyData, fallbackMessage));
        }
        await establishSession(token, webAssertion);
      } catch (error) {
        if (!quiet) {
          setAppMessage(
            error instanceof Error && error.message
              ? error.message
              : "TheStudent could not be reached. Please try again."
          );
        }
      }
      appBusyRef.current = false;
      setAppBusy(false);
    },
    [establishSession]
  );

  // Inside the Android app: sign in automatically with the app's session,
  // unless the student just logged out of this site.
  useEffect(() => {
    let blocked = false;
    try {
      blocked = sessionStorage.getItem(LOGGED_OUT_FLAG) === "1";
    } catch {
      // Storage unavailable.
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
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (formBusyRef.current || done) {
        return;
      }
      formBusyRef.current = true;
      setFormBusy(true);
      setFormMessage(null);
      setAppMessage(null);

      const formData = new FormData(event.currentTarget);
      const submittedEmail = String(formData.get("email") ?? "").trim();
      const password = String(formData.get("password") ?? "");
      setEmail(submittedEmail);

      try {
        let loginResponse: Response;
        try {
          // JSON POST may CORS-preflight; auth.php v3.6.7 must allow OPTIONS.
          loginResponse = await fetch(
            `${THESTUDENT_AUTH_URL}?action=web_login`,
            {
              body: JSON.stringify({
                client: "web",
                email: submittedEmail,
                password,
              }),
              cache: "no-store",
              credentials: "omit",
              headers: { "Content-Type": "application/json" },
              method: "POST",
            }
          );
        } catch (cause) {
          throw new Error(
            "TheStudent could not be reached. Please check your connection and try again.",
            { cause }
          );
        }

        const loginData = await readApiResponse(loginResponse);
        const token =
          typeof loginData.token === "string" ? loginData.token : "";
        const webAssertion =
          typeof loginData.web_assertion === "string"
            ? loginData.web_assertion
            : "";
        if (
          !loginResponse.ok ||
          loginData.status !== "success" ||
          !token ||
          !hasUser(loginData.user) ||
          !webAssertion
        ) {
          const fallbackMessage =
            loginResponse.status === 403 && loginData.status !== "error"
              ? "TheStudent could not be reached. Please try again."
              : "Invalid email or password.";
          throw new Error(responseMessage(loginData, fallbackMessage));
        }
        await establishSession(token, webAssertion);
      } catch (error) {
        setFormMessage(
          error instanceof Error && error.message
            ? error.message
            : "Could not log you in. Please try again."
        );
      } finally {
        formBusyRef.current = false;
        setFormBusy(false);
      }
    },
    [done, establishSession]
  );

  const togglePassword = useCallback(() => setShowPassword((v) => !v), []);

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

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
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

        {formMessage ? (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
            role="alert"
          >
            {formMessage}
          </p>
        ) : null}

        <LoginButton busy={formBusy || done} />
      </form>

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
