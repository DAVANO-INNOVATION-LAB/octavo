import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { SiteHeader } from "@/components/SiteHeader";
import { ImportPreviewForm } from "@/components/ImportPreviewForm";
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
      <main id="main" className="mx-auto w-full max-w-lg flex-1 px-4 py-12 sm:px-6">
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
        <ImportPreviewForm />
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
