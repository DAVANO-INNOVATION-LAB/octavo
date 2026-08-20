import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, userCount } from "@/lib/auth";
import { loginAction } from "@/app/actions";

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

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="rise w-full max-w-sm">
        <Link href="/" className="wordmark mb-8 block text-center text-3xl">
          octavo<span className="text-accent">.</span>
        </Link>
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card">
          <h1 className="wordmark text-xl text-ink">Sign in</h1>
          {error && (
            <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
              That email and password don’t match.
            </p>
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
