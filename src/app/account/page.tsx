import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { currentUser, getTotpSecret } from "@/lib/auth";
import { generateTotpSecret, otpauthUrl } from "@/lib/totp";
import { disableTotpAction, enableTotpAction, saveOrcidAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";

export const metadata = { title: "Account" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; enabled?: string; disabled?: string; orcid?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { error, enabled, disabled, orcid: orcidState } = await searchParams;
  const totpOn = Boolean(getTotpSecret(user.id));
  const proposedSecret = totpOn ? null : generateTotpSecret();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-12 sm:px-6">
        <h1 className="wordmark text-2xl text-ink">Account</h1>
        <form action={saveOrcidAction} className="mt-6 max-w-md rounded-xl border border-line bg-surface p-5 shadow-card">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              ORCID iD
            </span>
            <input
              name="orcid"
              defaultValue={user.orcid ?? ""}
              placeholder="0000-0002-1825-0097"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-sm text-ink placeholder:text-faint focus:border-accent"
            />
          </label>
          <p className="mt-1.5 text-xs leading-relaxed text-faint">
            {orcidState === "invalid"
              ? "That iD did not pass its check digit — please re-check it."
              : orcidState === "saved"
                ? "Saved."
                : "Shown beside your name on pages you wrote. Signing in through ORCID fills this in for you."}
          </p>
          <button className="mt-3 h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
            Save iD
          </button>
        </form>
        <p className="mt-3 text-sm">
          <Link href="/highlights" className="text-accent underline">
            My highlights
          </Link>{" "}
          <span className="text-faint">— every passage you marked while reading.</span>
        </p>
        <p className="mt-1 text-sm text-muted">
          {user.name} · {user.email} · {user.role}
        </p>

        {error === "totp" && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            That code didn’t match — try again with a fresh one.
          </p>
        )}
        {enabled && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            Two-factor authentication is on. Codes are now required at sign-in.
          </p>
        )}
        {disabled && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            Two-factor authentication is off.
          </p>
        )}

        <section className="mt-8 rounded-2xl border border-line bg-surface p-8 shadow-card">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {totpOn ? <ShieldCheck size={16} className="text-accent" /> : <ShieldOff size={16} className="text-faint" />}
            Two-factor authentication
          </h2>

          {totpOn ? (
            <>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                On. Signing in requires a code from your authenticator app.
                To turn it off, confirm a current code.
              </p>
              <form action={disableTotpAction} className="mt-4 flex gap-2">
                <input
                  required
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  className="h-10 w-32 rounded-lg border border-line bg-bg text-center font-mono text-sm tracking-[0.2em] text-ink outline-none focus:border-accent"
                />
                <button className="h-10 rounded-lg border border-accent/40 px-4 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-accent-ink">
                  Turn off
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Add a second key to your account. In your authenticator app,
                add an account by entering this secret (or paste the setup
                link), then confirm with the six-digit code it shows.
              </p>
              <p className="mt-4 rounded-lg border border-line bg-bg px-4 py-3 font-mono text-sm tracking-wider text-ink [overflow-wrap:anywhere]">
                {proposedSecret}
              </p>
              <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-faint">
                {otpauthUrl(user.email, proposedSecret!)}
              </p>
              <form action={enableTotpAction} className="mt-4 flex gap-2">
                <input type="hidden" name="secret" value={proposedSecret!} />
                <input
                  required
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  className="h-10 w-32 rounded-lg border border-line bg-bg text-center font-mono text-sm tracking-[0.2em] text-ink outline-none focus:border-accent"
                />
                <button className="h-10 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
                  Turn on
                </button>
              </form>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
