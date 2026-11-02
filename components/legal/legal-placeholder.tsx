import { ArrowLeftIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { DzdLogoMark } from "@/components/chat/icons";

/**
 * Temporary "coming soon" page for legal documents that aren't published yet.
 * See lib/legal.ts for switching the links to the real website pages.
 */
export function LegalPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <DzdLogoMark className="mb-8" size={40} title="TheStudent" />

        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/50 px-3 py-1 text-[11.5px] text-muted-foreground">
          <FileTextIcon aria-hidden="true" className="size-3" />
          Coming soon
        </span>

        <h1 className="text-balance font-semibold text-2xl tracking-tight text-foreground md:text-3xl">
          {title}
        </h1>

        <p className="mt-3 text-balance text-muted-foreground text-sm leading-relaxed">
          {description}
        </p>

        <Link
          className="mt-8 inline-flex h-9 items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-4 text-[13px] text-muted-foreground transition-colors hover:border-brand/60 hover:text-foreground"
          href="/"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          Back to TheStudent AI
        </Link>
      </div>
    </main>
  );
}
