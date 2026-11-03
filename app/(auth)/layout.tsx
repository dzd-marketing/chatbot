import Link from "next/link";
import { BrandLogo } from "@/components/chat/icons";
import { HANDSHAKE_CAPTURE_SCRIPT } from "@/lib/thestudent/android";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh w-full flex-col overflow-hidden bg-background">
      {/* Catches the Android app's login handshake before React loads. */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static, first-party script
        dangerouslySetInnerHTML={{ __html: HANDSHAKE_CAPTURE_SCRIPT }}
      />
      {/* Soft brand glow + faint grid, purely decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-[520px] max-w-3xl rounded-full bg-brand/15 blur-[120px] dark:bg-brand/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40 [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]"
      />

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 py-12">
        <div className="flex w-full max-w-[400px] flex-col items-center gap-8">
          <BrandLogo height={40} priority />
          {children}
        </div>
      </main>

      <footer className="relative z-10 px-5 pb-6 text-center text-[12px] text-muted-foreground">
        {"By continuing, you agree to our "}
        <Link
          className="cursor-pointer text-foreground/80 underline-offset-4 hover:underline"
          href="/terms"
        >
          Terms
        </Link>
        {" and "}
        <Link
          className="cursor-pointer text-foreground/80 underline-offset-4 hover:underline"
          href="/privacy"
        >
          Privacy Policy
        </Link>
        .
      </footer>
    </div>
  );
}
