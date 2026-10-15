"use client";

import { useFormStatus } from "react-dom";
import { createUserAction } from "@/app/actions";

function Submit() {
  const { pending } = useFormStatus();
  return <button disabled={pending} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50">{pending ? "Creating account…" : "Add user"}</button>;
}

export function AddUserForm() {
  return <details className="mb-6 rounded-xl border border-line bg-surface p-5">
    <summary className="cursor-pointer text-base font-semibold text-ink">Add user</summary>
    <p className="mt-2 text-sm text-muted">Create a local sign-in account. Members receive access through space memberships; administrators can manage the entire instance.</p>
    <form action={createUserAction} className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-ink">Name<input name="name" required maxLength={120} autoComplete="off" className="mt-1 block w-full rounded-lg border border-line bg-bg p-2" /></label>
      <label className="text-sm text-ink">Email<input name="email" type="email" required maxLength={254} autoComplete="off" className="mt-1 block w-full rounded-lg border border-line bg-bg p-2" /></label>
      <label className="text-sm text-ink">Password<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" aria-describedby="new-user-password-hint" className="mt-1 block w-full rounded-lg border border-line bg-bg p-2" /><span id="new-user-password-hint" className="mt-1 block text-xs text-muted">12–128 characters. Share securely with the new user.</span></label>
      <label className="text-sm text-ink">Role<select name="role" defaultValue="member" className="mt-1 block w-full rounded-lg border border-line bg-bg p-2"><option value="member">Member</option><option value="admin">Administrator</option></select></label>
      <div className="sm:col-span-2"><Submit /></div>
    </form>
  </details>;
}
