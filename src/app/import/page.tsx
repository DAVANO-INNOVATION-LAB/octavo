import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { SiteHeader } from "@/components/SiteHeader";
import { UrlImport } from "@/components/UrlImport";

export const dynamic = "force-dynamic";

export const metadata = { title: "Import" };

export default async function ImportPage({
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
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-12 sm:px-6">
        <h1 className="wordmark text-2xl text-ink">Bring a book home</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Import a <strong className="font-medium text-ink">Confluence space
          export</strong> (the XML .zip from Space Settings → Export — pages,
          tree, and attachments all come along), an Octavo export (.zip), a
          folder of Markdown as a .zip, a Word document (.docx), a notebook
          (.ipynb), or a single .md file. Wiki.js, BookStack, Obsidian, and
          MkDocs exports are all Markdown underneath — they land here cleanly.
          Imports arrive as a private space: your data, on your disk, from the
          first second.
        </p>
        {error && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            {error === "nofile"
              ? "Choose a file to import."
              : error === "toolarge"
                ? "That file is over the 100 MB import limit."
                : `Import failed: ${error}`}
          </p>
        )}
        <form
          action="/api/import"
          method="post"
          encType="multipart/form-data"
          className="rise mt-8 space-y-5 rounded-2xl border border-line bg-surface p-8 shadow-card"
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              File
            </span>
            <input
              required
              type="file"
              name="file"
              accept=".zip,.md,.markdown,.txt,.json,.docx,.ipynb"
              className="block w-full cursor-pointer rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-accent-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Space name (optional)
            </span>
            <input
              name="name"
              type="text"
              placeholder="Defaults to the export’s own name"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
            />
          </label>
          <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
            Import
          </button>
        </form>
        <UrlImport />
        <p className="mt-4 text-xs leading-relaxed text-faint">
          The reverse is always true too: every space exports as a .zip of
          plain Markdown plus a lossless manifest, and every page exports as
          .md. Your writing is never held hostage here.
        </p>
      </main>
    </div>
  );
}
