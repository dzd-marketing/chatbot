import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AndroidEmbed } from "@/components/android-embed";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EMBED_DETECT_SCRIPT } from "@/lib/android-embed";

import "./globals.css";
import { SessionProvider } from "next-auth/react";

const APP_NAME = "TheStudent";
const APP_DESCRIPTION =
  "TheStudent AI is the study assistant from TheStudent for G.C.E. A/L, O/L, Grade 5 Scholarship and university students: clear, step-by-step explanations in English, Sinhala and Tamil.";

// Use Vercel's built-in system env vars for absolute OG/Twitter image URLs
// instead of hard-coding a domain. Falls back to localhost for local dev.
function getSiteUrl() {
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercelHost) {
    return `https://${vercelHost}`;
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export const metadata: Metadata = {
  appleWebApp: { title: APP_NAME },
  applicationName: APP_NAME,
  description: APP_DESCRIPTION,
  metadataBase: new URL(getSiteUrl()),
  openGraph: {
    description: APP_DESCRIPTION,
    siteName: APP_NAME,
    title: `${APP_NAME} · Study with TheStudent AI`,
    type: "website",
  },
  title: {
    default: `${APP_NAME} · Study with TheStudent AI`,
    template: `%s · ${APP_NAME}`,
  },
  twitter: {
    card: "summary_large_image",
    description: APP_DESCRIPTION,
    title: `${APP_NAME} · Study with TheStudent AI`,
  },
};

export const viewport = {
  maximumScale: 1,
};

const geist = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

// Neutral browser-chrome colors that match the app's light/dark backgrounds.
const LIGHT_THEME_COLOR = "#fafafa";
const DARK_THEME_COLOR = "#151515";
const THEME_COLOR_SCRIPT = `\
(function() {
  var html = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  function updateThemeColor() {
    var isDark = html.classList.contains('dark');
    meta.setAttribute('content', isDark ? '${DARK_THEME_COLOR}' : '${LIGHT_THEME_COLOR}');
  }
  var observer = new MutationObserver(updateThemeColor);
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  updateThemeColor();
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${geist.variable} ${geistMono.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: "Static, runs before paint"
          dangerouslySetInnerHTML={{
            __html: EMBED_DETECT_SCRIPT,
          }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: "Required"
          dangerouslySetInnerHTML={{
            __html: THEME_COLOR_SCRIPT,
          }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          <SessionProvider
            basePath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth`}
          >
            <TooltipProvider>{children}</TooltipProvider>
            <AndroidEmbed />
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
