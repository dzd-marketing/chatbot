"use client";

import { ChevronUp, TrashIcon } from "lucide-react";
import type { User } from "next-auth";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useCallback, useState } from "react";
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
import { LOGGED_OUT_FLAG } from "@/lib/thestudent/android";
import { LoaderIcon } from "./icons";
import { toast } from "./toast";

function emailToHue(email: string): number {
  let hash = 0;
  for (const char of email) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts.at(0)?.at(0) ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.at(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** Profile photo, or coloured initials when there's none / it fails. */
function StudentAvatar({ user }: { user: User }) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);
  const label = user.name || user.email || "";
  const hue = emailToHue(user.email ?? label);

  if (user.image && !failed) {
    return (
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError only swaps in the initials
      // biome-ignore lint/performance/noImgElement: remote avatar from any host
      <img
        alt=""
        className="size-8 shrink-0 rounded-full object-cover ring-1 ring-sidebar-border/50"
        height={32}
        onError={onError}
        referrerPolicy="no-referrer"
        src={user.image}
        width={32}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full font-semibold text-[12px] text-white ring-1 ring-sidebar-border/50"
      style={{
        background: `linear-gradient(135deg, oklch(0.55 0.12 ${hue}), oklch(0.42 0.1 ${hue + 40}))`,
      }}
    >
      {initialsOf(label)}
    </span>
  );
}

async function logOut() {
  try {
    sessionStorage.setItem(LOGGED_OUT_FLAG, "1");
  } catch {
    // storage unavailable
  }
  try {
    await fetch("/api/auth/logout", {
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
    });
  } catch {
    // the login screen is shown either way
  }
  window.location.replace("/login");
}

export function SidebarUserNav({
  user,
  onDeleteAll,
}: {
  user: User;
  /** Opens the "Delete all chats?" confirmation (owned by AppSidebar). */
  onDeleteAll?: () => void;
}) {
  const { status } = useSession();
  const { setTheme, resolvedTheme } = useTheme();

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

    logOut();
  }, [status]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {status === "loading" ? (
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
            ) : (
              <SidebarMenuButton
                className="h-12 gap-2.5 rounded-lg bg-transparent px-2 text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                data-testid="user-nav-button"
              >
                <StudentAvatar user={user} />
                <span className="flex min-w-0 flex-col text-left leading-tight">
                  <span
                    className="truncate font-medium text-[13px]"
                    data-testid="user-email"
                  >
                    {user.name || user.email}
                  </span>
                  <span className="truncate text-[11.5px] text-sidebar-foreground/60">
                    {user.studentLine || user.email}
                  </span>
                </span>
                <ChevronUp className="ml-auto size-3.5 shrink-0 text-sidebar-foreground/50" />
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
                Log out
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
