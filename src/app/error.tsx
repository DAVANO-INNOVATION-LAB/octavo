"use client";

import { useEffect } from "react";

/**
 * The page a reader sees when something inside a route throws.
 *
 * Without this file, Next shows its own unstyled "Application error" screen —
 * the single worst thing to have happen in front of an audience. An error
 * page is part of the product: it stays in the product's dress, says
 * something true without a stack trace, and offers the two actions that
 * usually work.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The console is where the detail belongs — visible to whoever is
    // debugging, invisible to whoever is reading.
    console.error("octavo route error:", error);
  }, [error]);

  return (
    <main id="main" className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p
        aria-hidden
        className="wordmark select-none text-lg tracking-[0.5em] text-line-strong"
      >
        ⁂
      </p>
      <h1 className="wordmark mt-6 text-2xl text-ink">
        This page hit a problem
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        The rest of the library is fine. Trying again usually works; if it
        keeps happening, the error is in the server log
        {error.digest ? ` under digest ${error.digest}` : ""}.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={reset}
          className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Try again
        </button>
        {/* A plain anchor on purpose: when a route has just thrown, a full
            navigation is more reliable than client routing through whatever
            broke. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="h-9 rounded-lg border border-line px-4 text-sm leading-9 text-muted no-underline hover:border-line-strong hover:text-ink"
        >
          Back to the library
        </a>
      </div>
    </main>
  );
}
