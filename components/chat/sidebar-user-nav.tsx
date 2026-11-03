"use client";

import { ChevronUp, TrashIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { User } from "next-auth";
import { signOut, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useCallback, useState } from "react";
import {
  type StudentUser,
  signOutStudent,
  useStudentSession,
} from "@/components/student-session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useEmbedIdentity } from "@/hooks/use-android-embed";
import { guestRegex } from "@/lib/constants";
import { LoaderIcon } from "./icons";
import { toast } from "./toast";

function emailToHue(email: string): number {
  let hash = 0;
  for (const char of email) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function initialsOf(name: string | null, email: string | null) {
  const source = (name || email || "").trim();
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("");
  return letters.toUpperCase() || "S";
}

/** Profile photo, or a circle with initials when there is none / it fails. */
function StudentAvatar({ student }: { student: StudentUser }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = student.avatar_url;
  const handleError = useCallback(() => setFailedUrl(url), [url]);

  if (url && failedUrl !== url) {
    return (
      // biome-ignore lint/performance/noImgElement: external avatar host (Google); next/image would proxy it
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError swaps in the initials fallback
      <img
        alt=""
        className="size-7 shrink-0 rounded-full object-cover ring-1 ring-sidebar-border/50"
        height={28}
        onError={handleError}
        referrerPolicy="no-referrer"
        src={url}
        width={28}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full font-semibold text-[11px] text-white ring-1 ring-sidebar-border/50"
      style={{
        background: `linear-gradient(135deg, oklch(0.45 0.1 ${emailToHue(student.email ?? student.name ?? "")}), oklch(0.32 0.07 ${emailToHue(student.email ?? student.name ?? "") + 40}))`,
      }}
    >
      {initialsOf(student.name, student.email)}
    </div>
  );
}

function StudentLabel({ student }: { student: StudentUser }) {
  const subtitle =
    student.stream_or_degree || student.target_exam || student.email;
  return (
    <>
      <StudentAvatar student={student} />
      <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
        <span
          className="truncate font-medium text-[13px] text-sidebar-foreground"
          data-testid="user-email"
        >
          {student.name || student.email || "Student"}
        </span>
        {subtitle ? (
          <span className="truncate text-[11px] text-sidebar-foreground/60">
            {subtitle}
          </span>
        ) : null}
      </div>
      {student.exp_tier ? (
        <span className="shrink-0 rounded-full bg-sidebar-accent px-1.5 py-0.5 font-medium text-[10px] text-sidebar-foreground/80">
          {student.exp_tier}
        </span>
      ) : null}
    </>
  );
}

export function SidebarUserNav({
  user,
  onDeleteAll,
}: {
  user: User;
  /** Opens the "Delete all chats?" confirmation (owned by AppSidebar). */
  onDeleteAll?: () => void;
}) {
  const router = useRouter();
  const { data, status } = useSession();
  const { setTheme, resolvedTheme } = useTheme();

  const isGuest = guestRegex.test(data?.user?.email ?? "");
  // Inside the Android app, show the app's display name instead of "Guest".
  const embedName = useEmbedIdentity()?.name;
  // App SSO accounts show their name (website accounts keep showing email).
  const appName = data?.user?.appSession ? data.user.name : null;
  // Student verified through the Android app's handshake (display only).
  const { user: student } = useStudentSession();
  const handleThemeSelect = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const handleAuthClick = useCallback(() => {
    if (status === "loading") {
      toast({
        description: "Checking authentication status, please try again!",
        type: "error",
      });

      return;
    }

    if (student) {
      // App sign-in: drop the app token cookie, then the site session.
      signOutStudent().finally(() => signOut({ redirectTo: "/" }));
    } else if (isGuest) {
      router.push("/login");
    } else {
      signOut({
        redirectTo: "/",
      });
    }
  }, [isGuest, router, status, student]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {status === "loading" && !student ? (
              <SidebarMenuButton className="h-10 justify-between rounded-lg bg-transparent text-sidebar-foreground/50 transition-colors duration-150 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
                <div className="flex flex-row items-center gap-2">
                  <div className="size-6 animate-pulse rounded-full bg-sidebar-foreground/10" />
                  <span className="animate-pulse rounded-md bg-sidebar-foreground/10 text-transparent text-[13px]">
                    Loading...
                  </span>
                </div>
                <div className="animate-spin text-sidebar-foreground/50">
                  <LoaderIcon />
                </div>
              </SidebarMenuButton>
            ) : student ? (
              <SidebarMenuButton
                className="h-11 gap-2 rounded-lg bg-transparent px-2 text-sidebar-foreground/80 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                data-testid="user-nav-button"
              >
                <StudentLabel student={student} />
                <ChevronUp className="size-3.5 shrink-0 text-sidebar-foreground/50" />
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                className="h-8 px-2 rounded-lg bg-transparent text-sidebar-foreground/70 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                data-testid="user-nav-button"
              >
                <div
                  className="size-5 shrink-0 rounded-full ring-1 ring-sidebar-border/50"
                  style={{
                    background: `linear-gradient(135deg, oklch(0.35 0.08 ${emailToHue(user.email ?? "")}), oklch(0.25 0.05 ${emailToHue(user.email ?? "") + 40}))`,
                  }}
                />
                <span className="truncate text-[13px]" data-testid="user-email">
                  {isGuest ? embedName || "Guest" : appName || user?.email}
                </span>
                <ChevronUp className="ml-auto size-3.5 text-sidebar-foreground/50" />
              </SidebarMenuButton>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width) rounded-lg border border-border/60 bg-card/95 backdrop-blur-xl shadow-[var(--shadow-float)]"
            data-testid="user-nav-menu"
            side="top"
          >
            <DropdownMenuItem
              className="cursor-pointer text-[13px]"
              data-testid="user-nav-item-theme"
              onSelect={handleThemeSelect}
            >
              {`Toggle ${resolvedTheme === "light" ? "dark" : "light"} mode`}
            </DropdownMenuItem>
            {onDeleteAll ? (
              <DropdownMenuItem
                className="cursor-pointer text-[13px]"
                data-testid="user-nav-item-delete-all"
                onSelect={onDeleteAll}
                variant="destructive"
              >
                <TrashIcon className="size-3.5" />
                Delete all chats
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild data-testid="user-nav-item-auth">
              <button
                className="w-full cursor-pointer text-[13px]"
                onClick={handleAuthClick}
                type="button"
              >
                {isGuest && !student ? "Login to your account" : "Sign out"}
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
