import Link from "next/link";
import { verifyTotpAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Two-factor check" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="rise w-full max-w-sm">
        <Link href="/" className="wordmark mb-8 block text-center text-3xl">
          octavo<span className="text-accent">.</span>
        </Link>
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card">
          <h1 className="wordmark text-xl text-ink">Second key, please</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Enter the six-digit code from your authenticator app.
          </p>
          {error && (
            <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
              That code didn’t match — codes rotate every 30 seconds.
            </p>
          )}
          <form action={verifyTotpAction} className="mt-6 space-y-4">
            <input
              required
              autoFocus
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              className="h-12 w-full rounded-lg border border-line bg-bg text-center font-mono text-xl tracking-[0.4em] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Verify
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
