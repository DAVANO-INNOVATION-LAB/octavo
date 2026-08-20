"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Renders a Mermaid diagram client-side, following the active theme. */
export function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const htmlId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const dark =
        document.documentElement.getAttribute("data-theme") === "dark" ||
        (document.documentElement.getAttribute("data-theme") !== "light" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "var(--font-geist-sans), sans-serif",
        });
        const { svg } = await mermaid.render(`m${htmlId}${Date.now()}`, source);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Render failed");
      }
    }

    render();
    const onTheme = () => render();
    window.addEventListener("octavo-theme", onTheme);
    return () => {
      cancelled = true;
      window.removeEventListener("octavo-theme", onTheme);
    };
  }, [source, htmlId]);

  if (error)
    return (
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-4 text-xs text-muted">
        {source}
      </pre>
    );

  return (
    <div
      ref={ref}
      className="flex justify-center overflow-x-auto rounded-xl border border-line bg-surface p-6 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
