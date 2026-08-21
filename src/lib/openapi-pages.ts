import "server-only";
import {
  exampleFor,
  opSlug,
  parseOpenApi,
  typeName,
  type ApiDoc,
  type Op,
} from "./openapi";

/**
 * Generate Octavo pages from an OpenAPI document.
 *
 * Everything here is ordinary block content, so a generated reference
 * behaves like the rest of the library: searchable, exportable, reviewable,
 * translatable, and editable by hand. The only bespoke piece is one block
 * that lets a reader send the request.
 */

type Block = Record<string, unknown>;

let counter = 0;
const bid = () => `oa${(counter++).toString(36)}${Date.now().toString(36).slice(-4)}`;

const text = (s: string, styles: Record<string, boolean> = {}) => ({
  type: "text",
  text: s,
  styles,
});

const para = (s: string, styles: Record<string, boolean> = {}): Block => ({
  id: bid(),
  type: "paragraph",
  props: {},
  content: s ? [text(s, styles)] : [],
  children: [],
});

const heading = (s: string, level: number): Block => ({
  id: bid(),
  type: "heading",
  props: { level },
  content: [text(s)],
  children: [],
});

const code = (s: string, language: string, filename = ""): Block => ({
  id: bid(),
  type: "codeBlock",
  props: { language, filename, highlight: "", lineNumbers: false, wrap: false },
  content: [text(s)],
  children: [],
});

const callout = (s: string, tone: string): Block => ({
  id: bid(),
  type: "callout",
  props: { tone },
  content: [text(s)],
  children: [],
});

function table(headers: string[], rows: string[][]): Block {
  const cell = (s: string) => ({
    type: "tableCell",
    content: s ? [text(s)] : [],
    props: {
      colspan: 1,
      rowspan: 1,
      backgroundColor: "default",
      textColor: "default",
      textAlignment: "left",
    },
  });
  return {
    id: bid(),
    type: "table",
    props: {},
    content: {
      type: "tableContent",
      columnWidths: headers.map(() => undefined),
      rows: [headers, ...rows].map((r) => ({ cells: r.map(cell) })),
    },
    children: [],
  };
}

/** The interactive piece: everything a reader needs to send the request. */
function tryIt(op: Op, servers: string[]): Block {
  return {
    id: bid(),
    type: "apiRequest",
    props: {
      method: op.method,
      path: op.path,
      servers: servers.join("\n"),
      params: JSON.stringify(
        op.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          example: p.example ?? "",
        }))
      ),
      body: op.requestBody
        ? JSON.stringify(exampleFor(op.requestBody.schema), null, 2)
        : "",
      auth: op.security.join(", "),
    },
    content: undefined,
    children: [],
  };
}

function operationBlocks(op: Op, api: ApiDoc): Block[] {
  const blocks: Block[] = [];

  // The method and path are already the page title and the header of the
  // request panel below; a third copy also collides with the reader's drop
  // cap, which would set a capital on a line of code.
  if (op.deprecated) {
    blocks.push(callout("This operation is deprecated.", "warning"));
  }
  if (op.summary && op.summary !== op.operationId) blocks.push(para(op.summary));
  if (op.description && op.description !== op.summary) {
    for (const p of op.description.split(/\n{2,}/)) if (p.trim()) blocks.push(para(p.trim()));
  }

  blocks.push(heading("Request", 2));
  blocks.push(tryIt(op, api.servers));

  if (op.parameters.length > 0) {
    blocks.push(heading("Parameters", 3));
    blocks.push(
      table(
        ["Name", "In", "Type", "Required", "Description"],
        op.parameters.map((p) => [
          p.name,
          p.in,
          p.type,
          p.required ? "yes" : "no",
          p.description ?? "",
        ])
      )
    );
  }

  if (op.requestBody) {
    blocks.push(heading("Body", 3));
    blocks.push(
      para(
        `${op.requestBody.contentType}${op.requestBody.required ? " — required" : " — optional"}`
      )
    );
    const ex = exampleFor(op.requestBody.schema);
    if (ex !== null) blocks.push(code(JSON.stringify(ex, null, 2), "json"));
  }

  if (op.responses.length > 0) {
    blocks.push(heading("Responses", 2));
    blocks.push(
      table(
        ["Status", "Description", "Content"],
        op.responses.map((r) => [r.status, r.description, r.contentType ?? ""])
      )
    );
    const shown = op.responses.find((r) => r.schema && /^2/.test(r.status));
    if (shown?.schema) {
      const ex = exampleFor(shown.schema);
      if (ex !== null) {
        blocks.push(heading(`Example — ${shown.status}`, 3));
        blocks.push(code(JSON.stringify(ex, null, 2), "json"));
      }
    }
  }

  if (op.security.length > 0) {
    blocks.push(heading("Authentication", 2));
    blocks.push(para(`This operation requires: ${op.security.join(", ")}.`));
  }

  return blocks;
}

export type GeneratedPage = {
  title: string;
  slug: string;
  blocks: Block[];
  /** Slug of the parent page, for the tag this operation belongs to. */
  parent?: string;
};

export type Generated = {
  api: ApiDoc;
  pages: GeneratedPage[];
};

/** Read a specification and lay out the pages an import should create. */
export function generatePages(source: string): Generated {
  const api = parseOpenApi(source);
  const pages: GeneratedPage[] = [];

  const overview: Block[] = [];
  if (api.description) {
    for (const p of api.description.split(/\n{2,}/)) if (p.trim()) overview.push(para(p.trim()));
  }
  if (api.version) overview.push(para(`Version ${api.version}`));
  if (api.servers.length > 0) {
    overview.push(heading("Servers", 2));
    overview.push(code(api.servers.join("\n"), "text"));
  }
  overview.push(heading("Operations", 2));
  overview.push(
    table(
      ["Method", "Path", "Summary"],
      api.operations.map((o) => [o.method, o.path, o.summary ?? ""])
    )
  );
  pages.push({ title: "Overview", slug: "overview", blocks: overview });

  for (const tag of api.tags) {
    const ops = api.operations.filter((o) => o.tags.includes(tag));
    if (ops.length === 0) continue;
    const tagSlug = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    pages.push({
      title: tag,
      slug: tagSlug,
      blocks: [
        para(`${ops.length} operation${ops.length === 1 ? "" : "s"}.`),
        table(
          ["Method", "Path", "Summary"],
          ops.map((o) => [o.method, o.path, o.summary ?? ""])
        ),
      ],
    });
    for (const op of ops) {
      pages.push({
        title: op.summary || `${op.method} ${op.path}`,
        slug: opSlug(op),
        blocks: operationBlocks(op, api),
        parent: tagSlug,
      });
    }
  }

  return { api, pages };
}

export { typeName };

/**
 * Create the pages in a space. Returns what was made, so the caller can
 * report it rather than leaving the author to go and look.
 */
export function importInto(
  spaceId: string,
  source: string,
  create: (input: {
    spaceId: string;
    parentId?: string | null;
    title?: string;
    content?: string;
    published?: boolean;
  }) => { id: string; slug: string }
): { api: ApiDoc; created: number; firstSlug: string } {
  const { api, pages } = generatePages(source);
  const bySlug = new Map<string, string>();
  let first = "";

  // Tag pages first, so an operation can be filed under its own tag rather
  // than landing at the top level and having to be moved afterwards.
  for (const page of pages.filter((p) => !p.parent)) {
    const made = create({
      spaceId,
      title: page.title,
      content: JSON.stringify(page.blocks),
      // An imported specification is already an authored document; leaving
      // every page as a draft would mean publishing them one at a time.
      published: true,
    });
    bySlug.set(page.slug, made.id);
    if (!first) first = made.slug;
  }
  for (const page of pages.filter((p) => p.parent)) {
    create({
      spaceId,
      parentId: page.parent ? (bySlug.get(page.parent) ?? null) : null,
      title: page.title,
      content: JSON.stringify(page.blocks),
      published: true,
    });
  }

  return { api, created: pages.length, firstSlug: first };
}
