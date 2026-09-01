import { redirect } from "next/navigation";
import { Braces } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { importOpenApiAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import an API specification" };

export default async function ImportOpenApi({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-2xl flex-1 px-4 py-10 sm:px-6">
        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          <Braces size={13} />
          Import
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          An API reference from OpenAPI
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Paste an OpenAPI document, in YAML or JSON. Octavo builds a space
          with a page for every operation — parameters, request and response
          shapes, examples, and a panel that sends the request from your own
          browser.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The result is ordinary pages. Edit them, translate them, comment on
          them, propose changes to them. Nothing here is read-only.
        </p>

        {error && (
          <p className="mt-5 rounded-lg border border-[rgba(217,119,6,.4)] bg-[rgba(217,119,6,.09)] px-3 py-2 text-sm text-ink">
            {decodeURIComponent(error)}
          </p>
        )}

        <form action={importOpenApiAction} className="mt-6">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Space name
            </span>
            <input
              name="name"
              required
              defaultValue=""
              placeholder="Leave empty to use the title from the document"
              className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
          <label className="mt-4 block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Specification
            </span>
            <textarea
              name="spec"
              required
              rows={16}
              spellCheck={false}
              placeholder={"openapi: 3.0.3\ninfo:\n  title: Pet Store\n  version: \"1.0\"\npaths:\n  /pets:\n    get:\n      summary: List pets\n      responses:\n        \"200\":\n          description: OK"}
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
          <div className="mt-4 flex justify-end">
            <button className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Build the reference
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
