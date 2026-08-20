import { redirect } from "next/navigation";
import { userCount } from "@/lib/auth";
import { setupAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Welcome" };

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (userCount() > 0) redirect("/login");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="rise w-full max-w-sm">
        <p className="wordmark mb-8 text-center text-3xl">
          octavo<span className="text-accent">.</span>
        </p>
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card">
          <h1 className="wordmark text-xl text-ink">Welcome, binder</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            This library is brand new. Create the first account — it becomes
            the administrator.
          </p>
          {error && (
            <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
              Check the fields — a name, a valid email, and a password of at
              least 8 characters.
            </p>
          )}
          <form action={setupAction} className="mt-6 space-y-4">
            <Field label="Your name" name="name" type="text" placeholder="Ada Lovelace" />
            <Field label="Email" name="email" type="email" placeholder="you@example.com" />
            <Field label="Password" name="password" type="password" placeholder="At least 8 characters" />
            <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Open the library
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  name,
  type,
  placeholder,
}: {
  label: string;
  name: string;
  type: string;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
        {label}
      </span>
      <input
        required
        name={name}
        type={type}
        placeholder={placeholder}
        minLength={type === "password" ? 8 : undefined}
        className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
      />
    </label>
  );
}
