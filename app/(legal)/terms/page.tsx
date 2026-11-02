import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/legal/legal-placeholder";

// Placeholder until the Terms are published on TheStudent's website.
// See lib/legal.ts.
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Terms of Service",
};

export default function TermsPage() {
  return (
    <LegalPlaceholder
      description="We're preparing TheStudent's Terms of Service. They will be published here soon."
      title="Terms of Service"
    />
  );
}
