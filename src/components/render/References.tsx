import { formatReference, referenceHref, type Reference } from "@/lib/bibtex";

/**
 * The references a page cites, in the order it cites them.
 *
 * A key with no matching entry is shown as the key rather than dropped: a
 * missing citation is a fact the author needs to see, and silently deleting
 * it would hide the error in the one place it matters.
 */
export function References({
  keys,
  refs,
}: {
  keys: string[];
  refs: Map<string, Reference>;
}) {
  if (keys.length === 0) return null;
  return (
    <section className="mt-14 border-t border-line pt-6">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-faint">
        References
      </h2>
      <ol className="mt-4 space-y-2.5 text-sm leading-relaxed text-muted">
        {keys.map((key, i) => {
          const ref = refs.get(key);
          const href = ref ? referenceHref(ref) : null;
          return (
            <li key={key} id={`ref-${key}`} className="flex gap-3">
              <span className="w-5 shrink-0 text-right tabular-nums text-faint">
                {i + 1}.
              </span>
              <span className="min-w-0 flex-1">
                {ref ? (
                  <>
                    {formatReference(ref)}
                    {href && (
                      <>
                        {" "}
                        <a
                          href={href}
                          rel="noopener noreferrer"
                          className="text-accent no-underline hover:underline"
                        >
                          {href.startsWith("https://doi.org/")
                            ? href.replace("https://", "")
                            : "link"}
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-faint">
                    <code className="rounded bg-wash px-1 text-[13px]">{key}</code>{" "}
                    — not in this space&rsquo;s bibliography
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
