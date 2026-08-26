/**
 * ORCID iDs: the identifier a researcher is known by across every paper,
 * dataset and protocol they publish.
 *
 * Validated properly rather than by shape alone — the last character is an
 * ISO 7064 MOD 11-2 check digit, and checking it is the difference between
 * "looks like an iD" and "is one". A mistyped iD on an authorship line points
 * at a stranger, which is worse than no iD at all.
 */

const CLEAN = /[^0-9X]/gi;

/** Normalise anything a person might paste into 0000-0000-0000-0000 form. */
export function normalizeOrcid(input: unknown): string | null {
  const digits = String(input ?? "").toUpperCase().replace(CLEAN, "");
  if (digits.length !== 16) return null;
  if (!/^\d{15}[\dX]$/.test(digits)) return null;
  if (!checksumOk(digits)) return null;
  return digits.replace(/(.{4})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4");
}

/** ISO 7064 MOD 11-2, as ORCID specifies. */
function checksumOk(sixteen: string): boolean {
  let total = 0;
  for (let i = 0; i < 15; i++) {
    total = (total + Number(sixteen[i])) * 2;
  }
  const remainder = total % 11;
  const result = (12 - remainder) % 11;
  const expected = result === 10 ? "X" : String(result);
  return sixteen[15] === expected;
}

export function orcidUrl(orcid: string): string {
  return `https://orcid.org/${orcid}`;
}
