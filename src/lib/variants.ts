/**
 * Content variants: versions and translations of the same library.
 *
 * A variant is a whole space, tied to its siblings by a shared group key.
 * The alternative — one space carrying every version and language behind a
 * discriminator — would thread that discriminator through the page tree,
 * search, export, permissions, and every link, and buy nothing: a v2 of a
 * manual is a different set of pages, and a translation is a different set of
 * pages that happen to correspond. Spaces are cheap; correspondence is the
 * only thing that needed inventing.
 *
 * Correspondence is by page slug. `/handbook-fr/deploying` is the French
 * `/handbook/deploying`. It is predictable, it survives renaming a title, and
 * a reader can guess it.
 *
 * The resolution below is pure so the fallback rules can be tested.
 */

export type VariantKind = "version" | "translation";

export type VariantSpace = {
  id: string;
  slug: string;
  name: string;
  variant_group: string;
  variant_label: string;
  variant_kind: string;
  variant_position: number;
};

export type VariantLink = {
  slug: string;
  label: string;
  kind: VariantKind;
  current: boolean;
  /** False when this variant has no page with the current slug. */
  hasPage: boolean;
  /** Where to send the reader: the page if it exists, else the space. */
  href: string;
};

export function asVariantKind(v: unknown): VariantKind {
  return String(v) === "translation" ? "translation" : "version";
}

/** A readable fallback when someone links spaces without naming them. */
export function labelFor(space: VariantSpace): string {
  return space.variant_label.trim() || space.name;
}

/**
 * Build the switcher for a set of sibling spaces.
 *
 * `pageSlug` is the page being read, and `slugsBySpace` says which spaces
 * actually have a page by that slug. A variant missing the page still
 * appears — hiding it would leave a reader wondering whether the language
 * exists at all — but it points at that variant's home and is marked.
 */
export function resolveVariants(
  siblings: VariantSpace[],
  currentSpaceId: string,
  pageSlug: string | null,
  slugsBySpace: Map<string, Set<string>>
): VariantLink[] {
  return [...siblings]
    .sort(
      (a, b) =>
        a.variant_position - b.variant_position ||
        labelFor(a).localeCompare(labelFor(b))
    )
    .map((s) => {
      const hasPage = Boolean(
        pageSlug && (slugsBySpace.get(s.id)?.has(pageSlug) ?? false)
      );
      return {
        slug: s.slug,
        label: labelFor(s),
        kind: asVariantKind(s.variant_kind),
        current: s.id === currentSpaceId,
        hasPage,
        href: hasPage ? `/${s.slug}/${pageSlug}` : `/${s.slug}`,
      };
    });
}

/**
 * Which spaces to show on the library shelf. Only the primary of each group
 * is listed; the rest are reachable through the switcher, so a shelf does not
 * fill up with six translations of one handbook.
 */
export function primaryOnly<T extends VariantSpace>(spaces: T[]): T[] {
  const best = new Map<string, T>();
  const out: T[] = [];
  for (const s of spaces) {
    if (!s.variant_group) {
      out.push(s);
      continue;
    }
    const held = best.get(s.variant_group);
    if (!held || s.variant_position < held.variant_position) {
      best.set(s.variant_group, s);
    }
  }
  // Keep the original ordering of whichever space represents each group.
  const chosen = new Set([...best.values()].map((s) => s.id));
  return spaces.filter((s) => !s.variant_group || chosen.has(s.id)).filter(
    (s) => out.includes(s) || chosen.has(s.id)
  );
}

/** How many other variants a group has, for a "3 versions" hint. */
export function siblingCount(siblings: VariantSpace[]): number {
  return Math.max(0, siblings.length - 1);
}
