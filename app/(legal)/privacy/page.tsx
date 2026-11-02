import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/legal/legal-placeholder";

// Placeholder until the Privacy Policy is published on TheStudent's website.
// See lib/legal.ts.
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Privacy Policy",
};

export default function PrivacyPage() {
  return (
    <LegalPlaceholder
      description="We're preparing TheStudent's Privacy Policy, which will explain how your data is handled. It will be published here soon."
      title="Privacy Policy"
    />
  );
}
