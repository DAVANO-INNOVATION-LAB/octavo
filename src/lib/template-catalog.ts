// Metadata-only helpers. Import template content on the server and pass the
// resulting catalog to the client; this module never imports template bodies.
import type { SpaceTemplate, TemplatePage } from "./templates";

export type TemplateGroup = SpaceTemplate["group"];
export const TEMPLATE_GROUPS: readonly { id: TemplateGroup; label: string }[] = [
  { id: "simple", label: "Simple" },
  { id: "presentation", label: "Presentations and demos" },
  { id: "engineering", label: "Engineering" },
];
export type TemplateOutlineEntry = { title: string; depth: number; parentIndex: number | null };
export type TemplateCatalogEntry = {
  id: string;
  name: string;
  tagline: string;
  audience: string;
  kind: string;
  group: TemplateGroup;
  pageCount: number;
  outline: TemplateOutlineEntry[];
};

/** Recursive page outline, not an outline of blocks/headings inside pages. */
export function templateOutline(pages: readonly TemplatePage[]): TemplateOutlineEntry[] {
  const outline: TemplateOutlineEntry[] = [];
  const append = (items: readonly TemplatePage[], depth: number, parentIndex: number | null) => {
    for (const page of items) {
      const index = outline.length;
      outline.push({ title: page.title.trim() || "Untitled", depth, parentIndex });
      if (page.children) append(page.children, depth + 1, index);
    }
  };
  append(pages, 0, null);
  return outline;
}

/** Call on the server. Only explicitly selected serializable metadata escapes. */
export function buildTemplateCatalog(templates: readonly SpaceTemplate[]): TemplateCatalogEntry[] {
  return templates.map(template => {
    const outline = templateOutline(template.pages);
    return {
      id: template.id,
      name: template.name,
      tagline: template.tagline,
      audience: template.audience,
      kind: template.kind,
      group: template.group,
      pageCount: outline.length,
      outline,
    };
  });
}

const normalized = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** All query words must occur somewhere in the visible metadata or page titles.
 * Filtering preserves catalog order and never changes the selected template.
 */
export function filterTemplateCatalog(
  catalog: readonly TemplateCatalogEntry[],
  options: { query?: string; group?: TemplateGroup | "all" } = {}
): TemplateCatalogEntry[] {
  const words = normalized(options.query ?? "").trim().split(/\s+/).filter(Boolean);
  return catalog.filter(template => {
    if (options.group && options.group !== "all" && template.group !== options.group) return false;
    const text = normalized([template.name, template.tagline, template.audience, ...template.outline.map(page => page.title)].join(" "));
    return words.every(word => text.includes(word));
  });
}
