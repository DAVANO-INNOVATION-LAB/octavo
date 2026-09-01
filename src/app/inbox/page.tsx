import Link from "next/link";
import { redirect } from "next/navigation";
import { AtSign, Check, CornerDownRight, GitMerge, GitPullRequest, X } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listNotifications, type NotificationKind } from "@/lib/notify";
import { markAllReadAction, markReadAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox" };

const ICON: Record<NotificationKind, React.ComponentType<{ size?: number }>> = {
  mention: AtSign,
  reply: CornerDownRight,
  "cr.opened": GitPullRequest,
  "cr.reviewed": Check,
  "cr.merged": GitMerge,
  "cr.closed": X,
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default async function Inbox() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const items = listNotifications(user.id, { limit: 100 });
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-2xl flex-1 px-4 py-10 sm:px-6">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Inbox
            </p>
            <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
              {unread > 0 ? `${unread} unread` : "Nothing unread"}
            </h1>
          </div>
          {unread > 0 && (
            <form action={markAllReadAction}>
              <button className="h-8 shrink-0 rounded-md border border-line px-3 text-xs text-muted transition-colors hover:border-accent hover:text-accent">
                Mark all read
              </button>
            </form>
          )}
        </div>

        {items.length === 0 && (
          <p className="mt-8 text-sm text-faint">
            When somebody mentions you, replies to your thread, or reviews your
            proposal, it lands here.
          </p>
        )}

        <ul className="mt-8 space-y-2">
          {items.map((n) => {
            const Icon = ICON[n.kind] ?? AtSign;
            return (
              <li
                key={n.id}
                className={`rounded-xl border px-4 py-3 transition-colors ${
                  n.read_at
                    ? "border-line bg-surface-2/40 opacity-70"
                    : "border-line bg-surface"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
                  >
                    <Icon size={13} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {n.url ? (
                      <Link
                        href={n.url}
                        className="text-[15px] leading-snug text-ink no-underline hover:text-accent"
                      >
                        {n.title}
                      </Link>
                    ) : (
                      <p className="text-[15px] leading-snug text-ink">{n.title}</p>
                    )}
                    {n.body && (
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                        {n.body}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-faint">
                      {timeAgo(n.created_at)}
                    </p>
                  </div>
                  {!n.read_at && (
                    <form action={markReadAction} className="shrink-0">
                      <input type="hidden" name="id" value={n.id} />
                      <button
                        aria-label="Mark read"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-accent-soft hover:text-accent"
                      >
                        <Check size={13} />
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
