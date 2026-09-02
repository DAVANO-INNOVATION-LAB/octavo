import Link from "next/link";
import type { Space } from "@/lib/data";

/**
 * One space as it appears on a site. The label is the site's name for it,
 * which may differ from the space's own — the same handbook is "Operations"
 * internally and "Getting started" to a customer.
 */
export function SpaceCard({ space, label }: { space: Space; label: string }) {
  return (
    <Link
      href={`/${space.slug}`}
      className="group flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent"
    >
      <span className="wordmark text-[1.15rem] leading-snug text-ink group-hover:text-accent">
        {label}
      </span>
      {space.description && (
        <span className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted">
          {space.description}
        </span>
      )}
      {space.visibility === "private" && (
        <span className="mt-3 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">
          Private
        </span>
      )}
    </Link>
  );
}
