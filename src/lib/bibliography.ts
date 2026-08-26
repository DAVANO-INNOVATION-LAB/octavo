import "server-only";
import { getSetting, setSetting } from "./settings";
import { parseBibtex, type Reference } from "./bibtex";

/**
 * A space's bibliography: the .bib file an author pasted, parsed on read.
 *
 * Stored as the source text rather than parsed rows, so what a researcher
 * pasted is what they get back when they edit it — a bibliography is a
 * document people maintain by hand, and round-tripping it through a schema
 * would quietly reformat their file.
 */

export function bibliographySource(spaceId: string): string {
  return getSetting(`bib:${spaceId}`) ?? "";
}

export function setBibliography(spaceId: string, source: string): number {
  const clean = source.slice(0, 500_000);
  setSetting(`bib:${spaceId}`, clean.trim() ? clean : null);
  return parseBibtex(clean).length;
}

export function bibliography(spaceId: string): Map<string, Reference> {
  const refs = parseBibtex(bibliographySource(spaceId));
  return new Map(refs.map((r) => [r.key, r]));
}
