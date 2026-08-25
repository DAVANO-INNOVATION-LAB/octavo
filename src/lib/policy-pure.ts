/**
 * The policy shape and its clamping, pure so tests can hold it still.
 * Storage and enforcement live in ./policy.
 */

export type Policy = {
  sessionDays: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  lockoutWindowMinutes: number;
  minPasswordLength: number;
  auditRetentionDays: number;
};

export const DEFAULT_POLICY: Policy = {
  sessionDays: 30,
  lockoutThreshold: 10,
  lockoutMinutes: 15,
  lockoutWindowMinutes: 15,
  minPasswordLength: 12,
  auditRetentionDays: 0,
};

const BOUNDS: Record<keyof Policy, [number, number]> = {
  sessionDays: [1, 365],
  lockoutThreshold: [3, 100],
  lockoutMinutes: [1, 1440],
  lockoutWindowMinutes: [1, 1440],
  minPasswordLength: [8, 128],
  auditRetentionDays: [0, 3650],
};

/** Clamp rather than reject: a policy is a safety rail, and a rail that
 *  refuses to be set at all just gets bypassed by whoever needed it. */
export function clampPolicy(input: Partial<Record<keyof Policy, unknown>>): Policy {
  const out = { ...DEFAULT_POLICY };
  for (const key of Object.keys(DEFAULT_POLICY) as (keyof Policy)[]) {
    const raw = Number(input[key]);
    if (!Number.isFinite(raw)) continue;
    const [lo, hi] = BOUNDS[key];
    out[key] = Math.min(hi, Math.max(lo, Math.round(raw)));
  }
  return out;
}
