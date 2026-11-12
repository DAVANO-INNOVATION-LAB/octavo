"use client";

import { useMemo, useState } from "react";
import { filterTemplateCatalog, TEMPLATE_GROUPS, type TemplateCatalogEntry, type TemplateGroup } from "@/lib/template-catalog";

export function TemplateChooser({ catalog, defaultId }: { catalog: TemplateCatalogEntry[]; defaultId: string }) {
  const [selectedId, setSelectedId] = useState(defaultId);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<TemplateGroup | "all">("all");
  const matches = useMemo(() => filterTemplateCatalog(catalog, { query, group }), [catalog, query, group]);
  const visibleIds = new Set(matches.map(template => template.id));
  const selected = catalog.find(template => template.id === selectedId);
  const clearFilters = () => { setQuery(""); setGroup("all"); };

  return <section aria-labelledby="template-chooser-heading" className="min-w-0 space-y-4">
    <div>
      <h2 id="template-chooser-heading" className="text-lg font-semibold text-ink">Choose a starting template</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">Find a starting structure by name, audience or page title. Your selection stays selected when you filter.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block min-w-0 text-sm text-ink">Search templates
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} aria-controls="template-options" placeholder="Try incident, API or research" className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-line bg-bg px-3 text-sm focus:outline-2 focus:outline-accent" />
      </label>
      <label className="block min-w-0 text-sm text-ink">Category
        <select value={group} onChange={event => setGroup(event.target.value as TemplateGroup | "all")} aria-controls="template-options" className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-line bg-bg px-3 text-sm focus:outline-2 focus:outline-accent">
          <option value="all">All categories</option>
          {TEMPLATE_GROUPS.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
        </select>
      </label>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p role="status" aria-live="polite" className="text-muted">{matches.length} {matches.length === 1 ? "template matches" : "templates match"}</p>
      <button type="button" onClick={clearFilters} className="min-h-10 rounded-lg px-2 text-accent underline underline-offset-4">Clear filters</button>
    </div>
    {matches.length === 0 && <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">No templates match these filters. Try another search or clear filters. Your selected template has not changed.</p>}
    <fieldset id="template-options" className="min-w-0">
      <legend className="sr-only">Starting template</legend>
      <div className="grid max-h-96 gap-2 overflow-y-auto rounded-lg p-1 sm:grid-cols-2">
        {catalog.map(template => <label key={template.id} hidden={!visibleIds.has(template.id)} className={`${visibleIds.has(template.id) ? "flex" : "hidden"} min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-bg p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft focus-within:outline-2 focus-within:outline-accent`}>
          <input type="radio" name="template" value={template.id} checked={selectedId === template.id} onChange={() => setSelectedId(template.id)} className="mt-0.5 shrink-0 accent-accent" />
          <span className="min-w-0 break-words">
            <span className="block text-sm font-medium text-ink">{template.name}</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">{template.tagline}</span>
            <span className="mt-2 block text-xs text-faint">{template.audience} · {template.pageCount} {template.pageCount === 1 ? "page" : "pages"}</span>
          </span>
        </label>)}
      </div>
    </fieldset>
    {selected && <section aria-labelledby="selected-template-heading" className="min-w-0 space-y-3 rounded-xl border border-accent bg-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Selected template</p>
          <h3 id="selected-template-heading" className="mt-1 text-lg font-semibold text-ink">{selected.name}</h3>
        </div>
        <button type="button" onClick={() => { setSelectedId(defaultId); clearFilters(); }} className="min-h-10 rounded-lg px-2 text-sm text-accent underline underline-offset-4">Use default template</button>
      </div>
      <p className="text-sm leading-relaxed text-muted">{selected.tagline}</p>
      <p className="text-xs leading-relaxed text-muted">For {selected.audience} · {selected.pageCount} draft {selected.pageCount === 1 ? "page" : "pages"}</p>
      {!visibleIds.has(selected.id) && <p role="status" className="text-sm leading-relaxed text-ink">Your selected template is hidden by the current filters. It will still be used when you create the space.</p>}
      <div>
        <h4 className="text-sm font-medium text-ink">Page outline</h4>
        {selected.outline.length ? <ol aria-label="Selected template page outline" className="mt-2 max-h-64 space-y-2 overflow-auto rounded-lg border border-line p-3">
          {selected.outline.map((page, index) => <li key={index} className="min-w-0 break-words text-sm text-ink" style={{ marginLeft: `${Math.min(page.depth, 3) * 0.5}rem` }}>
            <span>{page.title}</span>
            <span className="block text-xs text-muted">{page.parentIndex === null ? "Top-level page" : `Parent: ${selected.outline[page.parentIndex].title}`}</span>
          </li>)}
        </ol> : <p className="mt-2 text-sm text-muted">No starter pages. Begin with an empty space.</p>}
      </div>
      <p className="text-xs leading-relaxed text-muted">Templates create editable drafts, not published pages. This is a page outline, not a preview of every block. You can edit or remove starter content afterward.</p>
    </section>}
  </section>;
}
