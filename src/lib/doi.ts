import "server-only";
import { getDb } from "./db";
import { getSetting, setSetting } from "./settings";
import { decryptSecret, encryptSecret } from "./crypto";
import { bylineFor } from "./data";
import { newId, now } from "./util";

/**
 * Minting a DOI for a page or a space.
 *
 * A DOI is a promise: this identifier will resolve to this thing, and the
 * metadata behind it will still describe it in twenty years. That makes it
 * the one outbound action in this codebase that must never be casual —
 * a DOI cannot be un-minted, only superseded, so the flow is deliberate,
 * audited, and records exactly which version was deposited.
 *
 * Two providers, one shape between them:
 *
 *   Zenodo    the researcher's usual route: deposit metadata, get a
 *             reserved DOI, publish. Free, run by CERN, keeps the record.
 *   DataCite  the institutional route: an organisation with its own prefix
 *             posts DataCite-schema metadata directly.
 *
 * Credentials are encrypted at rest with the same AES-256-GCM used for
 * connector credentials, and never leave the server.
 */

export type DoiProvider = "zenodo" | "datacite";

export type DoiSettings = {
  provider: DoiProvider;
  /** Zenodo: the API host — zenodo.org or sandbox.zenodo.org. DataCite: api.datacite.org. */
  endpoint: string;
  /** Zenodo: a personal access token. DataCite: "repositoryId:password". */
  token: string;
  /** DataCite only: the prefix the account is allowed to mint under. */
  prefix: string;
  /** Public base URL a DOI should resolve back to. */
  baseUrl: string;
};

export function doiSettings(): DoiSettings | null {
  const raw = getSetting("doi");
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<DoiSettings> & { token?: string };
    if (!t.provider || !t.token) return null;
    return {
      provider: t.provider === "datacite" ? "datacite" : "zenodo",
      endpoint: String(t.endpoint || (t.provider === "datacite" ? "https://api.datacite.org" : "https://zenodo.org")).replace(/\/$/, ""),
      token: decryptSecret(String(t.token)),
      prefix: String(t.prefix ?? ""),
      baseUrl: String(t.baseUrl ?? getSetting("base_url") ?? "").replace(/\/$/, ""),
    };
  } catch {
    return null;
  }
}

export function saveDoiSettings(s: Omit<DoiSettings, "token"> & { token: string }): void {
  setSetting("doi", JSON.stringify({ ...s, token: encryptSecret(s.token) }));
}

export type MintedDoi = {
  id: string;
  doi: string;
  target_type: "page" | "space";
  target_id: string;
  version_id: string;
  url: string;
  provider: string;
  minted_by: string;
  minted_at: number;
  title: string;
};

/** Every DOI minted for a target, newest first. */
export function doisFor(targetType: "page" | "space", targetId: string): MintedDoi[] {
  return getDb()
    .prepare(
      "SELECT * FROM dois WHERE target_type = ? AND target_id = ? ORDER BY minted_at DESC"
    )
    .all(targetType, targetId) as MintedDoi[];
}

export type DoiMetadata = {
  title: string;
  creators: { name: string; orcid?: string }[];
  description: string;
  publicationYear: number;
  url: string;
  /** The page version this DOI names, so the record is specific. */
  versionId: string;
};

/**
 * Build the metadata a provider needs. Deliberately explicit about what is
 * unknown: an anonymous page deposits no creator rather than inventing one.
 */
export function metadataForPage(page: {
  id: string;
  title: string;
  content_text: string;
  created_by?: string;
  updated_by?: string;
  updated_at: number;
}, spaceSlug: string, pageSlug: string, baseUrl: string): DoiMetadata {
  const { author, editor } = bylineFor(page);
  const creators = [author, editor]
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
    .map((b) => ({ name: b.name, orcid: b.orcid || undefined }));
  return {
    title: page.title,
    creators,
    description: page.content_text.slice(0, 2000),
    publicationYear: new Date(page.updated_at).getUTCFullYear(),
    url: `${baseUrl}/${spaceSlug}/${pageSlug}`,
    versionId: String(page.updated_at),
  };
}

/** DataCite's schema 4, the fields that matter. */
export function dataciteBody(meta: DoiMetadata, prefix: string): unknown {
  return {
    data: {
      type: "dois",
      attributes: {
        prefix,
        titles: [{ title: meta.title }],
        creators: meta.creators.map((c) => ({
          name: c.name,
          nameType: "Personal",
          ...(c.orcid
            ? {
                nameIdentifiers: [
                  {
                    nameIdentifier: `https://orcid.org/${c.orcid}`,
                    nameIdentifierScheme: "ORCID",
                    schemeUri: "https://orcid.org",
                  },
                ],
              }
            : {}),
        })),
        publisher: "Octavo",
        publicationYear: meta.publicationYear,
        types: { resourceTypeGeneral: "Text" },
        url: meta.url,
        descriptions: meta.description
          ? [{ description: meta.description, descriptionType: "Abstract" }]
          : [],
        event: "publish",
      },
    },
  };
}

/** Zenodo's deposition metadata. */
export function zenodoBody(meta: DoiMetadata): unknown {
  return {
    metadata: {
      title: meta.title,
      upload_type: "publication",
      publication_type: "technicalnote",
      description: meta.description || meta.title,
      creators: meta.creators.length
        ? meta.creators.map((c) => ({ name: c.name, ...(c.orcid ? { orcid: c.orcid } : {}) }))
        : [{ name: "Unknown" }],
      related_identifiers: [
        { relation: "isIdenticalTo", identifier: meta.url, scheme: "url" },
      ],
    },
  };
}

export type MintResult =
  | { ok: true; doi: string; url: string }
  | { ok: false; error: string };

/**
 * Deposit the metadata and return the DOI.
 *
 * Never throws into the caller: a failed mint must report why, because the
 * person who asked is about to try again and needs to know whether the
 * problem is their token, their prefix, or the provider being down.
 */
export async function mintDoi(
  meta: DoiMetadata,
  settings: DoiSettings
): Promise<MintResult> {
  try {
    if (settings.provider === "datacite") {
      if (!settings.prefix) return { ok: false, error: "no DataCite prefix configured" };
      const res = await fetch(`${settings.endpoint}/dois`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          Authorization: `Basic ${Buffer.from(settings.token).toString("base64")}`,
        },
        body: JSON.stringify(dataciteBody(meta, settings.prefix)),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `DataCite answered HTTP ${res.status}: ${text.slice(0, 200)}` };
      const json = JSON.parse(text) as { data?: { id?: string } };
      const doi = json.data?.id;
      if (!doi) return { ok: false, error: "DataCite returned no DOI" };
      return { ok: true, doi, url: `https://doi.org/${doi}` };
    }

    // Zenodo: create a deposition, set metadata, publish.
    const auth = { Authorization: `Bearer ${settings.token}` };
    const create = await fetch(`${settings.endpoint}/api/deposit/depositions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!create.ok)
      return { ok: false, error: `Zenodo answered HTTP ${create.status} creating the deposition` };
    const dep = (await create.json()) as { id?: number; metadata?: { prereserve_doi?: { doi?: string } } };
    if (!dep.id) return { ok: false, error: "Zenodo returned no deposition id" };

    const put = await fetch(`${settings.endpoint}/api/deposit/depositions/${dep.id}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(zenodoBody(meta)),
      signal: AbortSignal.timeout(20_000),
    });
    if (!put.ok)
      return { ok: false, error: `Zenodo answered HTTP ${put.status} setting metadata` };

    const publish = await fetch(
      `${settings.endpoint}/api/deposit/depositions/${dep.id}/actions/publish`,
      { method: "POST", headers: auth, signal: AbortSignal.timeout(30_000) }
    );
    const body = await publish.text();
    if (!publish.ok)
      return { ok: false, error: `Zenodo answered HTTP ${publish.status} publishing: ${body.slice(0, 200)}` };
    const published = JSON.parse(body) as { doi?: string; doi_url?: string };
    if (!published.doi) return { ok: false, error: "Zenodo published without returning a DOI" };
    return { ok: true, doi: published.doi, url: published.doi_url ?? `https://doi.org/${published.doi}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "the deposit did not complete",
    };
  }
}

/** Record a minted DOI. Append-only: a DOI is never edited or removed. */
export function recordDoi(input: {
  doi: string;
  targetType: "page" | "space";
  targetId: string;
  versionId: string;
  url: string;
  provider: string;
  mintedBy: string;
  title: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO dois (id, doi, target_type, target_id, version_id, url, provider, minted_by, minted_at, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(),
      input.doi,
      input.targetType,
      input.targetId,
      input.versionId,
      input.url,
      input.provider,
      input.mintedBy,
      now(),
      input.title
    );
}
