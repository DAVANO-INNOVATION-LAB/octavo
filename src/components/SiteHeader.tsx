import Link from "next/link";
import { Bell, LogIn, LogOut, PenTool, Settings2, Share2 } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { unreadCount } from "@/lib/notify";
import { logoutAction } from "@/app/actions";
import { SearchButton } from "./SearchDialog";
import { ThemeMenu } from "./ThemeMenu";
import { SeasonalDecor } from "./SeasonalDecor";

export async function SiteHeader() {
  const user = await currentUser();
  const unread = user ? unreadCount(user.id) : 0;
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <SeasonalDecor />
      <div className="relative mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="wordmark shrink-0 text-[1.35rem] leading-none">
          octavo<span className="text-accent">.</span>
        </Link>
        <div className="ml-auto flex items-center gap-0.5 sm:gap-2">
          <Link
            href="/whiteboard"
            className="flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink sm:px-2.5"
          >
            <PenTool size={14} />
            <span className="hidden sm:inline">Whiteboard</span>
          </Link>
          <Link
            href="/graph"
            title="Knowledge graph"
            className="hidden h-8 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink sm:flex sm:px-2.5"
          >
            <Share2 size={14} />
            <span className="hidden lg:inline">Graph</span>
          </Link>
          <SearchButton />
          <ThemeMenu />
          {user ? (
            <span className="flex items-center gap-1">
              <Link
                href="/inbox"
                title={unread > 0 ? `${unread} unread` : "Inbox"}
                className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Bell size={15} />
                {unread > 0 && (
                  <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] leading-none text-accent-ink">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>
              {user.role === "admin" && (
                <Link
                  href="/admin"
                  title="Admin"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <Settings2 size={15} />
                </Link>
              )}
              <Link
                href="/account"
                title={`${user.email} — account settings`}
                className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-surface-2"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-ink">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
              </Link>
              <form action={logoutAction}>
                <button
                  title="Sign out"
                  className="flex h-8 items-center rounded-md px-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink sm:px-2"
                >
                  <LogOut size={15} className="sm:hidden" />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </form>
            </span>
          ) : (
            <Link
              href="/login"
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <LogIn size={14} />
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
