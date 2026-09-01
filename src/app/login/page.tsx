import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, userCount } from "@/lib/auth";
import { loginAction } from "@/app/actions";
import { oidcSettings } from "@/lib/oidc";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (userCount() === 0) redirect("/setup");
  if (await currentUser()) redirect("/");
  const { error } = await searchParams;
  const sso = oidcSettings();

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="rise w-full max-w-sm">
        <Link href="/" className="wordmark mb-8 block text-center text-3xl">
          octavo<span className="text-accent">.</span>
        </Link>
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card">
          <h1 className="wordmark text-xl text-ink">Sign in</h1>
          {error && (
            <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
              {error === "sso"
                ? "Single sign-on failed — check the identity provider, or use a local account."
                : error === "locked"
                  ? "Too many failed attempts. This account is paused for a few minutes — wait, then try again."
                  : "That email and password don’t match."}
            </p>
          )}
          {sso && (
            <>
              {/* OAuth needs a full-page navigation to the route handler,
                  not a client-side <Link> transition. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/api/auth/oidc/login"
                className="mt-6 flex h-10 w-full items-center justify-center rounded-lg border border-line bg-bg text-sm font-medium text-ink transition-colors hover:border-accent"
              >
                Continue with {sso.name}
              </a>
              <p className="my-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                <span className="h-px flex-1 bg-line" />
                or with a local account
                <span className="h-px flex-1 bg-line" />
              </p>
            </>
          )}
          <form action={loginAction} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
                Email
              </span>
              <input
                required
                name="email"
                type="email"
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
                Password
              </span>
              <input
                required
                name="password"
                type="password"
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors focus:border-accent"
              />
            </label>
            <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Sign in
            </button>
          </form>
          <p className="mt-4 text-center text-xs text-faint">
            Or keep <Link href="/" className="text-muted underline">reading the library</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
