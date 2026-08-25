"use client";

/**
 * The last line: shown only when the root layout itself throws, which means
 * no theme tokens, no stylesheet, nothing to lean on. Inline styles are the
 * point — this page must render when everything else has failed to.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  console.error("octavo global error:", error);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Georgia, serif",
          background: "#faf6ee",
          color: "#1f1b13",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div style={{ letterSpacing: "0.5em", color: "#cfc6ae" }} aria-hidden>
          ⁂
        </div>
        <h1 style={{ marginTop: 24, fontSize: 24, fontWeight: 600 }}>
          Octavo hit a problem
        </h1>
        <p style={{ marginTop: 8, maxWidth: 420, fontSize: 14, color: "#6b6455" }}>
          Reloading usually clears it. The detail is in the server log
          {error.digest ? ` under digest ${error.digest}` : ""}.
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: 24,
            height: 36,
            padding: "0 16px",
            borderRadius: 8,
            border: "none",
            background: "#b8401b",
            color: "#faf6ee",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
