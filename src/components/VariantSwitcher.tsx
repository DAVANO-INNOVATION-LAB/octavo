import Link from "next/link";
import { Languages, GitBranch } from "lucide-react";
import type { VariantLink } from "@/lib/variants";

/**
 * Switch between versions or translations of the same library.
 *
 * A variant that has no page at this slug is still listed, pointing at its
 * home — leaving it out would leave a reader wondering whether the language
 * exists at all, when the honest answer is that this one page does not.
 */
export function VariantSwitcher({ links }: { links: VariantLink[] }) {
  if (links.length < 2) return null;
  const translations = links.some((l) => l.kind === "translation");
  const Icon = translations ? Languages : GitBranch;

  return (
    <nav
      aria-label={translations ? "Translations" : "Versions"}
      className="flex flex-wrap items-center gap-1.5 print:hidden"
    >
      <Icon size={13} className="shrink-0 text-faint" aria-hidden />
      {links.map((l) =>
        l.current ? (
          <span
            key={l.slug}
            aria-current="true"
            className="flex h-7 items-center rounded-md bg-accent-soft px-2.5 text-xs font-medium text-accent"
          >
            {l.label}
          </span>
        ) : (
          <Link
            key={l.slug}
            href={l.href}
            title={
              l.hasPage
                ? undefined
                : `This page has no ${
                    l.kind === "translation" ? "translation" : "version"
                  } here yet — opens the ${l.label} home`
            }
            className={`flex h-7 items-center rounded-md border border-line px-2.5 text-xs transition-colors hover:border-accent hover:text-accent ${
              l.hasPage ? "text-muted" : "text-faint"
            }`}
          >
            {l.label}
            {!l.hasPage && <span className="ml-1 text-faint">·</span>}
          </Link>
        )
      )}
    </nav>
  );
}
