import Link from "next/link";
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
          Import a Confluence export, an Octavo export, a Markdown/Notion ZIP,
          a Word document (.docx), a notebook (.ipynb), or a Markdown file.
          Preview the file first to review estimates, available asset-copy plans,
          and warnings. Conversion support depends on the source format;
          formatting, links, or attachments may need attention.
          Imported content is saved in a new private space.
        </p>
        <Link href="/import/history" className="mt-4 inline-flex min-h-10 items-center text-sm text-accent underline underline-offset-4">Recent imports</Link>
        {error && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            {error === "nofile"
              ? "Choose a file to import."
              : error === "toolarge"
                ? "That file is over the 100 MiB import limit."
                : `Import failed: ${error}`}
          </p>
        )}
        <ImportPreviewForm />
        <UrlImport />
        <p className="mt-4 text-xs leading-relaxed text-faint">
          Spaces can be exported as Markdown plus an Octavo manifest; individual
          pages can be exported as Markdown. Markdown does not represent every
          Octavo block or source-document feature. Review important content when
          moving between formats.
        </p>
      </main>
    </div>
  );
}
