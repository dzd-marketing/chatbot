"use client";

import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "lucide-react";
import Form from "next/form";
import { useActionState, useCallback, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import { BrandMark, LoaderIcon } from "@/components/chat/icons";
import { type LoginActionState, login } from "../actions";

const FIELD =
  "h-11 w-full rounded-xl border border-border/70 bg-background/60 pr-3 pl-10 text-[14px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus:border-brand/60 focus:ring-4 focus:ring-brand/10";

const ERRORS: Partial<Record<LoginActionState["status"], string>> = {
  failed: "Incorrect email or password.",
  invalid_data: "Enter a valid email and a password of at least 6 characters.",
};

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

  const [state, formAction] = useActionState<LoginActionState, FormData>(
    login,
    { status: "idle" }
  );

  useEffect(() => {
    if (state.status === "success") {
      setDone(true);
      // Full navigation so every part of the app picks up the new session.
      window.location.replace("/");
    }
  }, [state]);

  const handleSubmit = useCallback(
    (formData: FormData) => {
      setEmail(String(formData.get("email") ?? ""));
      formAction(formData);
    },
    [formAction]
  );

  const togglePassword = useCallback(() => setShowPassword((v) => !v), []);

  const error = ERRORS[state.status];

  return (
    <div className="w-full rounded-2xl border border-border/60 bg-card/70 p-6 shadow-[var(--shadow-float)] backdrop-blur-xl sm:p-8">
      <div className="mb-6 flex flex-col gap-1.5 text-center">
        <h1 className="font-semibold text-[22px] text-foreground tracking-tight">
          Welcome back
        </h1>
        <p className="text-[14px] text-muted-foreground">
          Log in to continue to TheStudent AI
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
              autoFocus
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
              minLength={6}
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
        className="flex h-11 w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl border border-border/70 bg-background/60 font-medium text-[14px] text-foreground transition-colors hover:bg-muted"
        type="button"
      >
        <BrandMark size={20} />
        Continue with TheStudent app
      </button>
    </div>
  );
}
