import Link from "next/link";
import { Sparkle } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { ask, askConfig } from "@/lib/ask";
import { readablePrivateSpaceIds } from "@/lib/roles";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask" };

export default async function Ask({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await currentUser();
  const { q } = await searchParams;
  const cfg = askConfig();
  const question = (q ?? "").trim();
  const result = question ? await ask(question, readablePrivateSpaceIds(user)) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          <Sparkle size={13} />
          Ask the library
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          A question, answered from these pages
        </h1>

        {!cfg ? (
          <p className="mt-5 rounded-xl border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
            No model is configured for this instance, so questions cannot be
            answered.{" "}
            {user?.role === "admin" ? (
              <Link href="/admin/ask" className="underline">
                Point Octavo at one
              </Link>
            ) : (
              "An administrator can point Octavo at one."
            )}{" "}
            It can be a model on this network — nothing is sent anywhere else.
          </p>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Answers are written only from pages you can already read, and every
            claim is linked to the page it came from. If the library does not
            cover it, the answer says so.
          </p>
        )}

        <form method="get" className="mt-6 flex gap-2">
          <input
            name="q"
            defaultValue={question}
            required
            disabled={!cfg}
            placeholder="How do I restore from a snapshot?"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
          />
          <button
            disabled={!cfg}
            className="h-11 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card disabled:opacity-40"
          >
            Ask
          </button>
        </form>

        {result && "error" in result && (
          <p className="mt-6 rounded-xl border border-[rgba(217,119,6,.4)] bg-[rgba(217,119,6,.09)] px-4 py-3 text-sm text-ink">
            {result.error}
          </p>
        )}

        {result && !("error" in result) && (
          <>
            <div className="mt-6 rounded-xl border border-line bg-surface px-5 py-4">
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
                {result.text}
              </p>
            </div>

            {result.passages.length > 0 && (
              <section className="mt-6">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                  Sources
                </p>
                <ol className="space-y-2">
                  {result.passages.map((p, i) => {
                    const used = result.cited.includes(i);
                    return (
                      <li
                        key={p.pageId}
                        className={`rounded-lg border px-3 py-2 ${
                          used ? "border-line bg-surface" : "border-line bg-surface-2/40 opacity-70"
                        }`}
                      >
                        <Link
                          href={`/${p.space}/${p.slug}`}
                          className="flex items-baseline gap-2 text-sm no-underline"
                        >
                          <span className="font-mono text-xs text-accent">[{i + 1}]</span>
                          <span className="min-w-0 flex-1 truncate text-ink hover:text-accent">
                            {p.title}
                          </span>
                          {!used && (
                            <span className="shrink-0 text-[11px] text-faint">
                              not cited
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-3 text-xs leading-relaxed text-faint">
                  Read the sources before relying on the answer. A model can
                  summarise a passage incorrectly, and the passage is the
                  record.
                </p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
