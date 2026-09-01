import { redirect } from "next/navigation";
import { Globe, Lock } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { createSpaceAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";
import { TEMPLATES, type SpaceTemplate } from "@/lib/templates";

function TemplateCard({
  tpl,
  defaultChecked = false,
}: {
  tpl: SpaceTemplate;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-bg p-3 transition-colors hover:border-line-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
      <input
        type="radio"
        name="template"
        value={tpl.id}
        defaultChecked={defaultChecked}
        className="sr-only"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{tpl.name}</span>
        <span className="mt-0.5 block text-xs leading-snug text-faint">
          {tpl.tagline}
        </span>
        <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
          {tpl.audience}
        </span>
      </span>
    </label>
  );
}

export const dynamic = "force-dynamic";

export const metadata = { title: "New space" };

export default async function NewSpacePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
        <h1 className="wordmark text-2xl text-ink">Bind a new space</h1>
        <p className="mt-1 text-sm text-muted">
          A space is one book on the shelf — its own pages, its own published
          site. Templates seed it with structured draft pages you edit or
          delete.
        </p>
        <form
          action={createSpaceAction}
          className="rise mt-8 space-y-6 rounded-2xl border border-line bg-surface p-8 shadow-card"
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Name
            </span>
            <input
              required
              autoFocus
              name="name"
              type="text"
              placeholder="Platform Handbook"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Description
            </span>
            <input
              name="description"
              type="text"
              placeholder="What lives in this book?"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
            />
          </label>

          <fieldset>
            <legend className="mb-2 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Start simple
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATES.filter((tpl) => tpl.group === "simple").map(
                (tpl, i) => (
                  <TemplateCard key={tpl.id} tpl={tpl} defaultChecked={i === 0} />
                )
              )}
            </div>
            <p className="mb-2 mt-5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              For engineers
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TEMPLATES.filter((tpl) => tpl.group === "engineering").map(
                (tpl) => (
                  <TemplateCard key={tpl.id} tpl={tpl} />
                )
              )}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Visibility
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-bg p-3 transition-colors has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input
                  type="radio"
                  name="visibility"
                  value="private"
                  defaultChecked
                  className="sr-only"
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <Lock size={13} />
                    Private
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-faint">
                    Only signed-in members can read it.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-bg p-3 transition-colors has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input
                  type="radio"
                  name="visibility"
                  value="public"
                  className="sr-only"
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <Globe size={13} />
                    Public
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-faint">
                    Anyone with the link can read published pages.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
            Create and start writing
          </button>
        </form>
      </main>
    </div>
  );
}
