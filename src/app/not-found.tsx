import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="wordmark text-6xl text-faint">404</p>
      <h1 className="wordmark text-2xl text-ink">This page isn’t bound yet</h1>
      <p className="max-w-sm text-sm leading-relaxed text-muted">
        The page you’re after doesn’t exist in this library — it may have been
        moved, unpublished, or never written.
      </p>
      <Link
        href="/"
        className="mt-2 flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
      >
        Back to the library
      </Link>
    </main>
  );
}
