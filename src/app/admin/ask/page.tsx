import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { askConfig } from "@/lib/ask";
import { saveAskAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask" };

export default async function AdminAsk({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { saved } = await searchParams;
  const cfg = askConfig();

  return (
    <AdminShell active="/admin/ask">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">Saved.</p>
      )}
      <h2 className="wordmark text-[1.4rem] text-ink">Answering from the library</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Octavo can answer questions using only what is written in these pages,
        with a link to every page it drew on. It needs a model to do the
        writing, and it does not ship one.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Anything speaking the OpenAI chat-completions shape works — Ollama,
        llama.cpp, vLLM, LM Studio, or a hosted API. On a disconnected network,
        point this at a model on the same network and the feature works there
        too. Leave it empty and Octavo does not offer the feature at all.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Retrieval uses the search index, so a reader can never be told
        something they could not have found by searching.
      </p>

      <form action={saveAskAction} className="mt-6 max-w-2xl space-y-4">
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Endpoint
          </span>
          <input
            name="endpoint"
            type="url"
            defaultValue={cfg?.endpoint ?? ""}
            placeholder="http://ollama.internal:11434/v1"
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
          />
          <span className="mt-1 block text-xs text-faint">
            The base URL. Octavo appends <code>/chat/completions</code>.
          </span>
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Model
          </span>
          <input
            name="model"
            defaultValue={cfg?.model ?? ""}
            placeholder="llama3.1:8b"
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            API key {cfg?.hasKey && <span className="normal-case text-faint">— one is stored</span>}
          </span>
          <input
            name="key"
            type="password"
            autoComplete="off"
            placeholder={cfg?.hasKey ? "Leave empty to keep the stored key" : "Only if the endpoint needs one"}
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
          />
          <span className="mt-1 block text-xs text-faint">
            Stored encrypted with this instance&rsquo;s secret, never shown again.
          </span>
        </label>
        {cfg?.hasKey && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" name="clearKey" value="1" />
            Remove the stored key
          </label>
        )}
        <div className="flex justify-end">
          <button className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink shadow-card">
            Save
          </button>
        </div>
      </form>
    </AdminShell>
  );
}
