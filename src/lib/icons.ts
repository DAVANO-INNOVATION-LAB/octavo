/**
 * The icon set for pages and spaces.
 *
 * Deliberately not emoji. Emoji render differently on every platform, carry
 * tone this product does not want, and age badly in a document meant to be
 * read for years. These are line marks from the icon family already in the
 * bundle — no new dependency, no new weight, and they inherit the accent
 * colour like everything else.
 *
 * The list is curated and closed: a name outside it is ignored rather than
 * rendered, so a hand-edited database or an old export can never inject an
 * arbitrary component name into the tree.
 */

export const ICON_NAMES = [
  // documents & writing
  "BookOpen", "FileText", "Notebook", "Feather", "Bookmark", "Library",
  // engineering
  "Terminal", "Code", "Cpu", "Database", "Server", "Container",
  "GitBranch", "Workflow", "Boxes", "Wrench",
  // operations
  "Activity", "Gauge", "Siren", "ShieldCheck", "Lock", "KeyRound",
  // science
  "FlaskConical", "Microscope", "Atom", "Dna", "Telescope", "Sigma",
  // organisation
  "Compass", "Map", "Milestone", "Target", "Flag", "Layers",
  "Users", "Building2", "Globe", "Sparkles",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const VALID = new Set<string>(ICON_NAMES);

/** Narrow anything stored or submitted to a name we actually render. */
export function asIconName(value: unknown): IconName | null {
  const v = String(value ?? "");
  return VALID.has(v) ? (v as IconName) : null;
}

/** Grouped for the picker, in the order above. */
export const ICON_GROUPS: { label: string; icons: IconName[] }[] = [
  { label: "Documents", icons: ICON_NAMES.slice(0, 6) as IconName[] },
  { label: "Engineering", icons: ICON_NAMES.slice(6, 16) as IconName[] },
  { label: "Operations", icons: ICON_NAMES.slice(16, 22) as IconName[] },
  { label: "Science", icons: ICON_NAMES.slice(22, 28) as IconName[] },
  { label: "Organisation", icons: ICON_NAMES.slice(28) as IconName[] },
];
