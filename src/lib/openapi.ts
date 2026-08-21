/**
 * Turn an OpenAPI document into Octavo pages.
 *
 * The import produces ordinary blocks rather than a bespoke viewer, so an
 * API reference is searchable, exportable, translatable, commentable, and
 * reviewable like every other page — and an author can correct a generated
 * sentence without the next import being the only way to change it.
 *
 * One page per operation. Grouping a whole tag onto one page reads well
 * until someone needs to link a colleague to a single endpoint.
 */

import { parseYaml, type YamlValue } from "./yaml";

export type Op = {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: Param[];
  requestBody?: { contentType: string; schema?: Doc; required: boolean };
  responses: { status: string; description: string; contentType?: string; schema?: Doc }[];
  deprecated: boolean;
  security: string[];
};

export type Param = {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  type: string;
  example?: string;
};

export type ApiDoc = {
  title: string;
  version: string;
  description?: string;
  servers: string[];
  operations: Op[];
  /** Tags in the order the document declares them, then any others found. */
  tags: string[];
};

type Doc = Record<string, YamlValue>;

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

const isDoc = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Follow a local $ref. Remote refs are not fetched: an import that reaches
 * out to resolve a document would be a request the operator did not make,
 * and on a disconnected network it would simply hang.
 */
function deref(spec: Doc, node: unknown, seen = new Set<string>()): unknown {
  if (!isDoc(node)) return node;
  const ref = node["$ref"];
  if (typeof ref !== "string") return node;
  if (!ref.startsWith("#/")) return { description: `external reference: ${ref}` };
  if (seen.has(ref)) return { description: "circular reference" };
  seen.add(ref);
  let cur: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isDoc(cur)) return {};
    cur = cur[key];
  }
  return deref(spec, cur, seen);
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** A readable type name for a schema, without unfolding the whole thing. */
export function typeName(schema: unknown): string {
  if (!isDoc(schema)) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((e) => String(e)).join(" | ");
  const t = str(schema.type);
  if (t === "array") {
    const items = schema.items;
    return `${typeName(items)}[]`;
  }
  if (schema.oneOf || schema.anyOf) {
    const list = (schema.oneOf ?? schema.anyOf) as unknown[];
    return Array.isArray(list) ? list.map(typeName).join(" | ") : "any";
  }
  if (t === "string" && str(schema.format)) return `string(${str(schema.format)})`;
  return t ?? (schema.properties ? "object" : "any");
}

function collectParams(spec: Doc, raw: unknown): Param[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const d = deref(spec, p) as Doc;
    const schema = deref(spec, d.schema);
    return {
      name: str(d.name) ?? "",
      in: str(d.in) ?? "query",
      required: d.required === true || str(d.in) === "path",
      description: str(d.description),
      type: typeName(schema),
      example: d.example !== undefined ? String(d.example) : undefined,
    };
  });
}

/** Read a specification into the shape the page generator wants. */
export function parseOpenApi(source: string): ApiDoc {
  const root = parseYaml(source);
  if (!isDoc(root)) throw new Error("the document is not an OpenAPI object");
  if (!root.openapi && !root.swagger)
    throw new Error("no openapi or swagger version field — is this a specification?");

  const info = isDoc(root.info) ? root.info : {};
  const servers = Array.isArray(root.servers)
    ? root.servers.map((s) => (isDoc(s) ? str(s.url) ?? "" : "")).filter(Boolean)
    : [];

  const declaredTags = Array.isArray(root.tags)
    ? root.tags.map((t) => (isDoc(t) ? str(t.name) ?? "" : "")).filter(Boolean)
    : [];

  const operations: Op[] = [];
  const paths = isDoc(root.paths) ? root.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = deref(root, item);
    if (!isDoc(pathItem)) continue;
    // Parameters declared on the path apply to every operation under it.
    const shared = collectParams(root, pathItem.parameters);

    for (const method of METHODS) {
      const opRaw = pathItem[method];
      if (!isDoc(opRaw)) continue;

      const responses: Op["responses"] = [];
      const respRoot = isDoc(opRaw.responses) ? opRaw.responses : {};
      for (const [status, r] of Object.entries(respRoot)) {
        const resp = deref(root, r);
        if (!isDoc(resp)) continue;
        const content = isDoc(resp.content) ? resp.content : undefined;
        const contentType = content ? Object.keys(content)[0] : undefined;
        const media =
          content && contentType && isDoc(content[contentType])
            ? (content[contentType] as Doc)
            : undefined;
        responses.push({
          status,
          description: str(resp.description) ?? "",
          contentType,
          schema: media ? (deref(root, media.schema) as Doc) : undefined,
        });
      }

      let requestBody: Op["requestBody"];
      const rb = deref(root, opRaw.requestBody);
      if (isDoc(rb) && isDoc(rb.content)) {
        const ct = Object.keys(rb.content)[0];
        const media = isDoc(rb.content[ct]) ? (rb.content[ct] as Doc) : undefined;
        requestBody = {
          contentType: ct,
          schema: media ? (deref(root, media.schema) as Doc) : undefined,
          required: rb.required === true,
        };
      }

      const security = Array.isArray(opRaw.security ?? root.security)
        ? ((opRaw.security ?? root.security) as unknown[])
            .flatMap((s) => (isDoc(s) ? Object.keys(s) : []))
        : [];

      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: str(opRaw.operationId),
        summary: str(opRaw.summary),
        description: str(opRaw.description),
        tags: Array.isArray(opRaw.tags)
          ? opRaw.tags.map(String)
          : ["Endpoints"],
        parameters: [...shared, ...collectParams(root, opRaw.parameters)],
        requestBody,
        responses,
        deprecated: opRaw.deprecated === true,
        security,
      });
    }
  }

  const found = new Set(operations.flatMap((o) => o.tags));
  const tags = [
    ...declaredTags.filter((t) => found.has(t)),
    ...[...found].filter((t) => !declaredTags.includes(t)).sort(),
  ];

  return {
    title: str(info.title) ?? "API",
    version: str(info.version) ?? "",
    description: str(info.description),
    servers,
    operations,
    tags,
  };
}

/** A stable, readable slug for an operation. */
export function opSlug(op: Op): string {
  const base = op.operationId || `${op.method}-${op.path}`;
  return base
    // Split camel case before flattening, or "getPetById" loses its words.
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[{}]/g, "")
    // Operation ids are free text and are written with spaces often enough
    // that assuming otherwise produces slugs with spaces in them.
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** An example JSON body from a schema, so a reader sees shape not prose. */
export function exampleFor(schema: unknown, depth = 0): unknown {
  if (!isDoc(schema) || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const t = str(schema.type);
  if (t === "array") return [exampleFor(schema.items, depth + 1)];
  if (t === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    const props = isDoc(schema.properties) ? schema.properties : {};
    for (const [k, v] of Object.entries(props)) out[k] = exampleFor(v, depth + 1);
    return out;
  }
  if (t === "integer" || t === "number") return 0;
  if (t === "boolean") return true;
  if (t === "string") {
    const f = str(schema.format);
    if (f === "date-time") return "2026-01-01T00:00:00Z";
    if (f === "uuid") return "00000000-0000-0000-0000-000000000000";
    return "string";
  }
  return null;
}
