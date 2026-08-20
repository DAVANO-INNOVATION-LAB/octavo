import Link from "next/link";
import { LogIn, PenTool, Settings2 } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { logoutAction } from "@/app/actions";
import { SearchButton } from "./SearchDialog";
import { ThemeMenu } from "./ThemeMenu";
import { SeasonalDecor } from "./SeasonalDecor";

export async function SiteHeader() {
  const user = await currentUser();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <SeasonalDecor />
      <div className="relative mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="wordmark text-[1.35rem] leading-none">
          octavo<span className="text-accent">.</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/whiteboard"
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <PenTool size={14} />
            <span className="hidden sm:inline">Whiteboard</span>
          </Link>
          <SearchButton />
          <ThemeMenu />
          {user ? (
            <span className="flex items-center gap-1">
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
                <button className="flex h-8 items-center rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink">
                  Sign out
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
