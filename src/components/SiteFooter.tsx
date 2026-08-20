export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line px-4 py-5 sm:px-6 print:hidden">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs leading-relaxed text-faint">
        <span>
          Bound with{" "}
          <span className="wordmark text-muted">
            octavo<span className="text-accent">.</span>
          </span>{" "}
          — open-source documentation that reads like a book
        </span>
        <span aria-hidden className="text-line-strong">·</span>
        <a
          href="https://github.com/DAVANO-INNOVATION-LAB/octavo"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-muted"
        >
          AGPL-3.0 source
        </a>
        <span aria-hidden className="text-line-strong">·</span>
        <span className="font-medium tracking-[0.04em] text-muted">
          A Davano Innovation Lab product
        </span>
      </div>
    </footer>
  );
}
