import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { doiSettings } from "@/lib/doi";
import { getSetting } from "@/lib/settings";
import { saveDoiSettingsAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "DOIs" };

export default async function AdminDoi({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { saved } = await searchParams;
  const s = doiSettings();

  return (
    <AdminShell active="/admin/doi">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Saved.
        </p>
      )}

      <h2 className="wordmark text-[1.4rem] text-ink">Citable records</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        A DOI makes a page citable: a permanent identifier that resolves to it
        and metadata that still describes it in twenty years. Once configured,
        anyone who can publish in a space can mint one for a published page.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        <strong className="font-medium text-ink">A DOI cannot be withdrawn</strong>,
        only superseded — so minting is a deliberate act, it is recorded in the
        audit log, and the record names the exact revision that was deposited.
        Authors&rsquo; ORCID iDs are sent with the metadata where they have one.
      </p>

      <form action={saveDoiSettingsAction} className="mt-6 max-w-2xl space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
            Provider
          </span>
          <select
            name="provider"
            defaultValue={s?.provider ?? "zenodo"}
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink"
          >
            <option value="zenodo">Zenodo — free, run by CERN</option>
            <option value="datacite">DataCite — your institution&rsquo;s own prefix</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
            API endpoint
          </span>
          <input
            name="endpoint"
            defaultValue={s?.endpoint ?? "https://zenodo.org"}
            placeholder="https://zenodo.org"
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-xs text-ink focus:border-accent"
          />
          <span className="mt-1 block text-xs text-faint">
            Use <code>https://sandbox.zenodo.org</code> to rehearse without
            minting a real DOI, or <code>https://api.test.datacite.org</code>{" "}
            for DataCite&rsquo;s test system.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
            Token
          </span>
          <input
            name="token"
            type="password"
            placeholder={s ? "unchanged — leave blank to keep it" : "Zenodo token, or repositoryId:password for DataCite"}
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-xs text-ink focus:border-accent"
          />
          <span className="mt-1 block text-xs text-faint">
            Encrypted at rest and never shown back. Blank leaves the stored one
            in place.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
            DataCite prefix
          </span>
          <input
            name="prefix"
            defaultValue={s?.prefix ?? ""}
            placeholder="10.5072"
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-xs text-ink focus:border-accent"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
            Public base URL
          </span>
          <input
            name="base_url"
            defaultValue={s?.baseUrl || getSetting("base_url") || ""}
            placeholder="https://docs.example.org"
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-xs text-ink focus:border-accent"
          />
          <span className="mt-1 block text-xs text-faint">
            Where a DOI should resolve to. It must be reachable from outside —
            a DOI pointing at localhost is a broken promise.
          </span>
        </label>

        <button className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
          Save
        </button>
      </form>
    </AdminShell>
  );
}
