import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { readingEnabled, retentionDays } from "@/lib/reading";
import { saveReadingAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reading signals" };

export default async function AdminReading({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { saved } = await searchParams;

  const on = readingEnabled();
  const days = retentionDays();
  const stored = (
    getDb()
      .prepare("SELECT COUNT(*) AS c FROM reading_signals")
      .get() as { c: number }
  ).c;

  return (
    <AdminShell active="/admin/reading">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Saved.
        </p>
      )}

      <h2 className="wordmark text-[1.4rem] text-ink">Reading signals</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        A page is written by the person who least needs it, so its author
        cannot see which sentence is hard. Octavo watches where readers slow
        down, scroll back, and stop, and shows the writer those passages.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        What is recorded is a count against a passage: how many times it was
        on screen, for how long in total, how often someone returned to it,
        and how often it was the last thing on screen. There is no identifier
        of any kind — <strong className="font-medium text-ink">the table has
        no column for who</strong>, so “did this person read this page” is a
        question it cannot answer, whoever asks. Readers whose browser sends
        Global Privacy Control are not measured at all.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Only people who can edit a space see the signals for its pages.
      </p>

      <form action={saveReadingAction} className="mt-6 max-w-2xl">
        <label className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={on}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-sm">
            <span className="block font-medium text-ink">
              Collect reading signals
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">
              Turning this off deletes everything already collected, not just
              what comes next.
              {stored > 0 && (
                <> There {stored === 1 ? "is" : "are"} {stored} row
                {stored === 1 ? "" : "s"} stored now.</>
              )}
            </span>
          </span>
        </label>

        <label className="mt-4 block">
          <span className="block text-xs font-medium text-muted">
            Keep signals for
          </span>
          <span className="mt-1 flex items-center gap-2">
            <input
              type="number"
              name="retention_days"
              min={1}
              max={3650}
              defaultValue={days}
              className="h-9 w-28 rounded-lg border border-line bg-surface px-3 text-sm text-ink"
            />
            <span className="text-sm text-muted">days</span>
          </span>
        </label>

        <button
          type="submit"
          className="mt-5 h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Save
        </button>
      </form>
    </AdminShell>
  );
}
