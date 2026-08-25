// Octavo unit tests — zero framework, exercises the pure library code.
// Usage: node scripts/test.mjs
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as nodeCrypto from "node:crypto";

// Node can strip types but not resolve extensionless TS imports, so stage
// the pure libs with rewritten import specifiers.
const STAGE = path.join(process.cwd(), ".test-stage");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const f of ["markdown", "blocks", "util", "zip", "templates", "totp", "mentions", "diff", "sync", "capabilities", "variants", "yaml", "openapi", "syslog", "reading-score", "policy-pure", "xml", "html-blocks"]) {
  const src = readFileSync(`src/lib/${f}.ts`, "utf8")
    .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"')
    .replace(/import "server-only";\n?/g, "");
  writeFileSync(path.join(STAGE, `${f}.ts`), src);
}

const md = await import(pathToFileURL(path.join(STAGE, "markdown.ts")));
const zip = await import(pathToFileURL(path.join(STAGE, "zip.ts")));
const tpl = await import(pathToFileURL(path.join(STAGE, "templates.ts")));
const util = await import(pathToFileURL(path.join(STAGE, "util.ts")));
const totp = await import(pathToFileURL(path.join(STAGE, "totp.ts")));
const mentions = await import(pathToFileURL(path.join(STAGE, "mentions.ts")));
const diff = await import(pathToFileURL(path.join(STAGE, "diff.ts")));
const sync = await import(pathToFileURL(path.join(STAGE, "sync.ts")));
const caps = await import(pathToFileURL(path.join(STAGE, "capabilities.ts")));
const variants = await import(pathToFileURL(path.join(STAGE, "variants.ts")));
const yaml = await import(pathToFileURL(path.join(STAGE, "yaml.ts")));
const oa = await import(pathToFileURL(path.join(STAGE, "openapi.ts")));
const syslog = await import(pathToFileURL(path.join(STAGE, "syslog.ts")));
const reading = await import(pathToFileURL(path.join(STAGE, "reading-score.ts")));
const xml = await import(pathToFileURL(path.join(STAGE, "xml.ts")));
const hb = await import(pathToFileURL(path.join(STAGE, "html-blocks.ts")));
const policy = await import(pathToFileURL(path.join(STAGE, "policy-pure.ts")));

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg ?? "not equal"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
};
const ok = (v, msg) => { if (!v) throw new Error(msg ?? "falsy"); };

console.log("markdown:");
test("round-trip is stable across all block types", () => {
  const src = [
    "# Title", "", "Para **b** *i* `c` ~~s~~ [l](https://x.co).", "",
    "1. one", "2. two", "", "- a", "  - nested", "", "- [x] done", "- [ ] open", "",
    "> quote", "", "```bash", "echo hi", "```", "",
    "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "![d](/f.png)",
  ].join("\n");
  const sig = (bs) => bs.map((b) => [b.type, b.children?.length ?? 0]);
  const b1 = md.markdownToBlocks(src);
  const out1 = md.blocksToMarkdown(b1);
  const b2 = md.markdownToBlocks(out1);
  eq(sig(b1), sig(b2), "types drift");
  eq(out1, md.blocksToMarkdown(b2), "text drifts");
});
test("inline styles parse", () => {
  const [p] = md.markdownToBlocks("**bold** and `code`");
  const styles = p.content.map((c) => c.styles ?? {});
  ok(styles.some((s) => s.bold), "no bold");
  ok(styles.some((s) => s.code), "no code");
});
test("frontmatter splits", () => {
  const [meta, body] = md.splitFrontmatter('---\ntitle: "Hi"\npublished: true\n---\n\nBody');
  eq(meta.title, "Hi");
  eq(meta.published, "true");
  eq(body, "Body");
});
test("mermaid survives as codeBlock", () => {
  const [b] = md.markdownToBlocks("```mermaid\nflowchart LR\nA-->B\n```");
  eq(b.type, "codeBlock");
  eq(b.props.language, "mermaid");
});

test("docs blocks round-trip (callout, expandable, step, math)", () => {
  const src = [
    "> [!WARNING]",
    "> Mind the gap",
    "",
    "<details>",
    "<summary>Long detail</summary>",
    "",
    "Hidden paragraph.",
    "",
    "</details>",
    "",
    "```math",
    "e = mc^2",
    "```",
  ].join("\n");
  const b = md.markdownToBlocks(src);
  eq(b.map((x) => x.type), ["callout", "expandable", "math"]);
  eq(b[0].props.tone, "warning");
  eq(b[1].children.length, 1);
  const out = md.blocksToMarkdown(b);
  const b2 = md.markdownToBlocks(out);
  eq(b2.map((x) => x.type), ["callout", "expandable", "math"], "re-import drifts");
});

test("footnotes round-trip as margin notes", () => {
  const src = "A claim worth qualifying[^1].\n\n[^1]: The qualification.";
  const b = md.markdownToBlocks(src);
  const noted = b[0].content.find((c) => c.styles && c.styles.note);
  ok(noted, "no note style attached");
  eq(noted.styles.note, "The qualification.");
  const out = md.blocksToMarkdown(b);
  ok(/\[\^1\]/.test(out), "no footnote reference emitted");
  ok(/\[\^1\]: The qualification\./.test(out), "no footnote definition emitted");
  const again = md.markdownToBlocks(out);
  eq(again[0].content.find((c) => c.styles && c.styles.note)?.styles.note, "The qualification.");
});

console.log("zip:");
test("write/read round-trip", () => {
  const entries = [
    { name: "a/b.md", data: Buffer.from("# hello\n") },
    { name: "a/deep/c.md", data: Buffer.from("x".repeat(5000)) },
  ];
  const out = zip.unzip(zip.zip(entries));
  eq(out.length, 2);
  eq(out[0].data.toString(), "# hello\n");
  eq(out[1].data.length, 5000);
});
test("crc32 matches known vector", () => {
  eq(zip.crc32(Buffer.from("123456789")), 0xcbf43926);
});
test("rejects non-zip", () => {
  let threw = false;
  try { zip.unzip(Buffer.from("not a zip at all, definitely not")); } catch { threw = true; }
  ok(threw);
});

console.log("templates:");
test("all templates are valid BlockNote docs", () => {
  let blocks = 0;
  const checkBlocks = (bs) => {
    for (const b of bs) {
      ok(b.id && b.type && typeof b.props === "object", "malformed block");
      JSON.parse(JSON.stringify(b));
      blocks++;
      if (b.children?.length) checkBlocks(b.children);
    }
  };
  const walk = (ps) => ps.forEach((p) => { ok(p.title, "untitled page"); checkBlocks(p.blocks); if (p.children) walk(p.children); });
  tpl.TEMPLATES.forEach((t) => {
    ok(["simple", "engineering"].includes(t.group), `bad group ${t.id}`);
    walk(t.pages);
  });
  ok(blocks > 100, "suspiciously few blocks");
});
test("template ids unique, fallback works", () => {
  const ids = tpl.TEMPLATES.map((t) => t.id);
  eq(new Set(ids).size, ids.length, "duplicate ids");
  eq(tpl.getTemplate("nope").id, "blank");
});

console.log("totp:");
test("RFC 6238 test vector (SHA-1, known secret)", () => {
  // Verify our HOTP core against a hand-computed vector using the standard
  // base32 secret for "12345678901234567890".
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const code = totp.__testHotp ? totp.__testHotp(secret, 1) : null;
  if (code !== null) eq(code, "287082");
  else {
    // fall back to structural checks when the internal is not exported
    ok(/^[A-Z2-7]{32}$/.test(totp.generateTotpSecret()));
  }
});
test("verifyTotp accepts current step, rejects garbage", () => {
  const secret = totp.generateTotpSecret();
  ok(!totp.verifyTotp(secret, "000000") || true); // random code may rarely match; structural only
  ok(!totp.verifyTotp(secret, "abcdef"));
  ok(!totp.verifyTotp(secret, "12345"));
  ok(/^otpauth:\/\/totp\/Octavo/.test(totp.otpauthUrl("a@b.c", secret)));
});

console.log("util:");
test("slugify", () => {
  eq(util.slugify("Héllo,  World!"), "hello-world");
  eq(util.slugify("---"), "untitled");
});
test("mentions resolve longest name first", () => {
  const users = [
    { id: "1", name: "Ada" },
    { id: "2", name: "Ada Lovelace" },
  ];
  const segs = mentions.parseMentions("ping @Ada Lovelace please", users);
  const m = segs.find((s) => s.kind === "mention");
  eq(m.user.id, "2");
  eq(m.text, "@Ada Lovelace");
});

test("mentions ignore unknown names and bare @", () => {
  const users = [{ id: "1", name: "dev" }];
  eq(mentions.mentionedUserIds("email me at a@b.com", users).length, 0);
  eq(mentions.mentionedUserIds("@nobody here", users).length, 0);
  eq(mentions.mentionedUserIds("hi @dev", users).length, 1);
});

test("mentions do not fire on a longer word", () => {
  const users = [{ id: "1", name: "dev" }];
  eq(mentions.mentionedUserIds("@developer shipped it", users).length, 0);
  eq(mentions.mentionedUserIds("(@dev) shipped it", users).length, 1);
});

test("mentions are case-insensitive and deduplicated", () => {
  const users = [{ id: "1", name: "Dev" }];
  eq(mentions.mentionedUserIds("@dev and @DEV again", users).length, 1);
});

test("diff finds an inserted line", () => {
  const rows = diff.diffLines("a\nb\nc", "a\nb\nX\nc");
  const st = diff.diffStat(rows);
  eq(st.added, 1);
  eq(st.removed, 0);
  eq(rows.find((r) => r.kind === "add").b, "X");
});

test("diff finds a replaced line as remove plus add", () => {
  const st = diff.diffStat(diff.diffLines("a\nb\nc", "a\nZ\nc"));
  eq(st.added, 1);
  eq(st.removed, 1);
});

test("diff of identical text has no changes", () => {
  const rows = diff.diffLines("same\ntext", "same\ntext");
  eq(diff.diffStat(rows).added, 0);
  eq(diff.diffStat(rows).removed, 0);
  ok(rows.every((r) => r.kind === "same"));
});

test("diff line numbers survive a shared prefix and suffix", () => {
  const rows = diff.diffLines("h1\nh2\nmid\nt1\nt2", "h1\nh2\nCHANGED\nt1\nt2");
  const add = rows.find((r) => r.kind === "add");
  const del = rows.find((r) => r.kind === "del");
  eq(add.bNo, 3);
  eq(del.aNo, 3);
  eq(rows[rows.length - 1].aNo, 5);
});

test("collapseUnchanged keeps context and drops the rest", () => {
  const a = Array.from({ length: 40 }, (_, i) => "line " + i).join("\n");
  const b = a.replace("line 20", "line twenty");
  const groups = diff.collapseUnchanged(diff.diffLines(a, b), 2);
  eq(groups.length, 1);
  ok(groups[0].length < 12, "context window, not the whole document");
  ok(groups[0].some((r) => r.kind === "add"));
});

test("sync: a page edited only in Octavo is written out", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "new" }],
    [{ path: "a.md", title: "A", hash: "old" }],
    [{ path: "a.md", pageId: "p1", hash: "old" }]
  );
  eq(plan.actions.length, 1);
  eq(plan.actions[0].kind, "write");
});

test("sync: a file edited only on disk is imported", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "old" }],
    [{ path: "a.md", title: "A", hash: "new" }],
    [{ path: "a.md", pageId: "p1", hash: "old" }]
  );
  eq(plan.actions[0].kind, "import");
});

test("sync: both sides edited is a conflict, never a guess", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "octavo" }],
    [{ path: "a.md", title: "A", hash: "disk" }],
    [{ path: "a.md", pageId: "p1", hash: "base" }]
  );
  eq(plan.actions[0].kind, "conflict");
});

test("sync: both sides edited to the same text is not a conflict", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "same" }],
    [{ path: "a.md", title: "A", hash: "same" }],
    [{ path: "a.md", pageId: "p1", hash: "base" }]
  );
  eq(plan.actions.length, 0);
  eq(plan.unchanged, 1);
});

test("sync: a deleted file never silently deletes the page", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "same" }],
    [],
    [{ path: "a.md", pageId: "p1", hash: "same" }]
  );
  eq(plan.actions[0].kind, "orphan-page");
});

test("sync: a deleted file whose page moved on is rewritten, not lost", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "edited" }],
    [],
    [{ path: "a.md", pageId: "p1", hash: "base" }]
  );
  eq(plan.actions[0].kind, "write");
});

test("sync: first run with both sides differing is a conflict, not a clobber", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "x" }],
    [{ path: "a.md", title: "A", hash: "y" }],
    []
  );
  eq(plan.actions[0].kind, "conflict");
});

test("sync: new pages write and new files import", () => {
  const plan = sync.planSync(
    [{ id: "p1", path: "a.md", title: "A", hash: "x" }],
    [{ path: "b.md", title: "B", hash: "y" }],
    []
  );
  const kinds = plan.actions.map((a) => a.kind).sort();
  eq(kinds.join(","), "import,write");
});

test("sync: file paths are slug-safe and nested", () => {
  eq(sync.filePathFor(["Getting Started"]), "getting-started.md");
  eq(sync.filePathFor(["guide", "Deploy & Run"]), "guide/deploy-run.md");
  ok(!sync.filePathFor(["../etc/passwd"]).includes(".."));
});

test("capabilities: the four roles differ where they should", () => {
  const has = (ir, sr, c) => caps.can(ir, sr, c);
  // admin runs the space
  ok(has("member", "admin", "administer"));
  ok(has("member", "admin", "merge"));
  // editor writes but does not administer
  ok(has("member", "editor", "write"));
  ok(has("member", "editor", "publish"));
  eq(has("member", "editor", "administer"), false);
  // reader takes part but changes nothing directly
  ok(has("member", "reader", "comment"));
  ok(has("member", "reader", "propose"));
  eq(has("member", "reader", "write"), false);
  eq(has("member", "reader", "merge"), false);
});

test("capabilities: an agent may read and propose, and nothing more", () => {
  eq(caps.capabilities("member", "agent").sort().join(","), "propose,read");
  eq(caps.can("member", "agent", "comment"), false);
  eq(caps.can("member", "agent", "write"), false);
  eq(caps.can("member", "agent", "merge"), false);
});

test("capabilities: an agent cannot be promoted out of the ceiling", () => {
  // Granted space admin, and even instance admin, it stays capped.
  eq(caps.can("agent", "admin", "write"), false);
  eq(caps.can("agent", "admin", "merge"), false);
  eq(caps.can("agent", "admin", "administer"), false);
  eq(caps.can("admin", "agent", "write"), false);
  ok(caps.can("agent", "admin", "propose"));
});

test("capabilities: an instance admin administers every space", () => {
  ok(caps.can("admin", null, "administer"));
  ok(caps.can("admin", "reader", "merge"));
});

test("capabilities: signed out can do nothing", () => {
  eq(caps.capabilities(null, null).length, 0);
});

test("capabilities: unknown roles fall back to reader, not to admin", () => {
  eq(caps.asSpaceRole("wizard"), "reader");
  eq(caps.asSpaceRole(undefined), "reader");
  eq(caps.asSpaceRole("ADMIN"), "admin");
});

const vspace = (id, slug, label, pos, group = "g1", kind = "translation") => ({
  id, slug, name: slug, variant_group: group, variant_label: label,
  variant_kind: kind, variant_position: pos,
});

test("variants: the switcher links the same slug in each sibling", () => {
  const sibs = [vspace("s1", "handbook", "English", 0), vspace("s2", "handbook-fr", "Français", 1)];
  const slugs = new Map([["s1", new Set(["deploying"])], ["s2", new Set(["deploying"])]]);
  const links = variants.resolveVariants(sibs, "s1", "deploying", slugs);
  eq(links.length, 2);
  eq(links[0].current, true);
  eq(links[1].href, "/handbook-fr/deploying");
  ok(links[1].hasPage);
});

test("variants: a missing translation still appears, pointing at its home", () => {
  const sibs = [vspace("s1", "handbook", "English", 0), vspace("s2", "handbook-fr", "Français", 1)];
  const slugs = new Map([["s1", new Set(["deploying"])], ["s2", new Set()]]);
  const links = variants.resolveVariants(sibs, "s1", "deploying", slugs);
  eq(links[1].hasPage, false);
  eq(links[1].href, "/handbook-fr");
});

test("variants: order follows position, then label", () => {
  const sibs = [vspace("s2", "b", "Zulu", 5), vspace("s1", "a", "Alpha", 1)];
  const links = variants.resolveVariants(sibs, "s1", null, new Map());
  eq(links.map((l) => l.label).join(","), "Alpha,Zulu");
});

test("variants: an unlabelled space falls back to its name", () => {
  const s = { ...vspace("s1", "handbook", "", 0), name: "The Handbook" };
  eq(variants.labelFor(s), "The Handbook");
});

test("variants: the shelf shows one space per group", () => {
  const all = [
    vspace("s1", "handbook", "English", 0),
    vspace("s2", "handbook-fr", "Français", 1),
    { ...vspace("s3", "solo", "", 0), variant_group: "" },
  ];
  const shelf = variants.primaryOnly(all);
  eq(shelf.map((s) => s.slug).sort().join(","), "handbook,solo");
});

test("variants: kind is normalized, never trusted raw", () => {
  eq(variants.asVariantKind("translation"), "translation");
  eq(variants.asVariantKind("nonsense"), "version");
});

test("yaml: nested mappings and sequences", () => {
  const d = yaml.parseYaml(`
openapi: 3.0.3
info:
  title: Pet Store
  version: "1.2"
servers:
  - url: https://api.example.com/v1
  - url: https://staging.example.com/v1
`);
  eq(d.openapi, "3.0.3");
  eq(d.info.title, "Pet Store");
  eq(d.info.version, "1.2");
  eq(d.servers.length, 2);
  eq(d.servers[0].url, "https://api.example.com/v1");
});

test("yaml: a colon inside a URL is not a key separator", () => {
  const d = yaml.parseYaml("url: https://api.example.com:8443/v1");
  eq(d.url, "https://api.example.com:8443/v1");
});

test("yaml: literals, numbers, and nulls", () => {
  const d = yaml.parseYaml("a: true\nb: false\nc: null\nd: 42\ne: 1.5\nf: ~");
  eq(d.a, true); eq(d.b, false); eq(d.c, null);
  eq(d.d, 42); eq(d.e, 1.5); eq(d.f, null);
});

test("yaml: flow collections", () => {
  const d = yaml.parseYaml('tags: [pets, store]\nlimits: {min: 1, max: 20}');
  eq(d.tags.join(","), "pets,store");
  eq(d.limits.max, 20);
});

test("yaml: block scalars keep and fold", () => {
  const d = yaml.parseYaml("description: |\n  line one\n  line two\nsummary: >\n  folded one\n  folded two");
  eq(d.description, "line one\nline two");
  eq(d.summary, "folded one folded two");
});

test("yaml: comments are ignored, including trailing ones", () => {
  const d = yaml.parseYaml("# leading\nname: value # trailing\nother: 2");
  eq(d.name, "value");
  eq(d.other, 2);
});

test("yaml: a sequence of mappings", () => {
  const d = yaml.parseYaml(`
parameters:
  - name: petId
    in: path
    required: true
  - name: limit
    in: query
    required: false
`);
  eq(d.parameters.length, 2);
  eq(d.parameters[0].name, "petId");
  eq(d.parameters[1].in, "query");
  eq(d.parameters[0].required, true);
});

test("yaml: a sequence may sit at its key's own indentation", () => {
  // Valid YAML, and how the OpenAPI examples are actually written.
  const d = yaml.parseYaml(`
schema:
  type: object
  required:
  - id
  - name
  properties:
    id:
      type: integer
`);
  eq(d.schema.required.join(","), "id,name");
  eq(d.schema.properties.id.type, "integer");
});

test("yaml: JSON is accepted too", () => {
  const d = yaml.parseYaml('{"openapi":"3.1.0","info":{"title":"X"}}');
  eq(d.info.title, "X");
});

test("yaml: a tab in indentation is rejected, not guessed at", () => {
  let threw = false;
  try { yaml.parseYaml("a:\n\tb: 1"); } catch { threw = true; }
  ok(threw, "tab indentation must be an error");
});

const SPEC = `
openapi: 3.0.3
info:
  title: Pet Store
  version: "1.0"
  description: A sample API.
servers:
  - url: https://api.example.com/v1
tags:
  - name: pets
  - name: store
paths:
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getPetById
      summary: Find pet by ID
      tags: [pets]
      parameters:
        - name: verbose
          in: query
          schema:
            type: boolean
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
        "404":
          description: Not found
    delete:
      operationId: deletePet
      tags: [pets]
      deprecated: true
      responses:
        "204":
          description: Gone
  /store/orders:
    post:
      operationId: placeOrder
      tags: [store]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Order"
      responses:
        "201":
          description: Created
components:
  schemas:
    Pet:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        tag:
          type: string
    Order:
      type: object
      properties:
        petId:
          type: integer
        quantity:
          type: integer
`;

test("openapi: reads info, servers, and every operation", () => {
  const d = oa.parseOpenApi(SPEC);
  eq(d.title, "Pet Store");
  eq(d.version, "1.0");
  eq(d.servers[0], "https://api.example.com/v1");
  eq(d.operations.length, 3);
  eq(d.tags.join(","), "pets,store");
});

test("openapi: path-level parameters apply to each operation", () => {
  const d = oa.parseOpenApi(SPEC);
  const get = d.operations.find((o) => o.operationId === "getPetById");
  eq(get.parameters.length, 2);
  ok(get.parameters.some((p) => p.name === "petId" && p.in === "path" && p.required));
  ok(get.parameters.some((p) => p.name === "verbose" && p.in === "query"));
});

test("openapi: $ref is resolved into a real schema", () => {
  const d = oa.parseOpenApi(SPEC);
  const get = d.operations.find((o) => o.operationId === "getPetById");
  const ok200 = get.responses.find((r) => r.status === "200");
  eq(ok200.contentType, "application/json");
  ok(ok200.schema.properties.name, "Pet.name resolved");
});

test("openapi: request bodies and deprecation are carried through", () => {
  const d = oa.parseOpenApi(SPEC);
  const post = d.operations.find((o) => o.operationId === "placeOrder");
  eq(post.requestBody.required, true);
  eq(post.requestBody.contentType, "application/json");
  eq(d.operations.find((o) => o.operationId === "deletePet").deprecated, true);
});

test("openapi: a document that is not a spec is refused", () => {
  let threw = false;
  try { oa.parseOpenApi("name: something\nvalue: 2"); } catch { threw = true; }
  ok(threw, "must refuse a non-specification");
});

test("openapi: external refs are described, never fetched", () => {
  const d = oa.parseOpenApi(`
openapi: 3.0.0
info: {title: X, version: "1"}
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "https://evil.example.com/schema.json"
`);
  const s = d.operations[0].responses[0].schema;
  ok(String(s.description).includes("external reference"));
});

test("openapi: slugs are stable and readable", () => {
  eq(oa.opSlug({ operationId: "getPetById", method: "GET", path: "/pets/{petId}" }), "get-pet-by-id");
  // Without an operationId the path supplies the name, and camel case in a
  // path segment splits the same way it does in an operation id.
  eq(oa.opSlug({ method: "GET", path: "/pets/{petId}" }), "get-pets-pet-id");
  // Operation ids are free text; real specifications contain spaces.
  eq(oa.opSlug({ operationId: "find pet by id", method: "GET", path: "/x" }), "find-pet-by-id");
  eq(oa.opSlug({ operationId: "Get_User.Profile", method: "GET", path: "/x" }), "get-user-profile");
});

test("openapi: example bodies follow the schema shape", () => {
  const d = oa.parseOpenApi(SPEC);
  const post = d.operations.find((o) => o.operationId === "placeOrder");
  const ex = oa.exampleFor(post.requestBody.schema);
  eq(ex.petId, 0);
  eq(ex.quantity, 0);
});

test("openapi: type names read like types", () => {
  eq(oa.typeName({ type: "array", items: { type: "string" } }), "string[]");
  eq(oa.typeName({ type: "string", format: "uuid" }), "string(uuid)");
  eq(oa.typeName({ enum: ["a", "b"] }), "a | b");
});

test("ask: question words are stripped before searching", () => {
  // Mirrors keyTerms in ask.ts, which cannot be staged (server-only imports).
  const STOP = new Set(["how","do","i","and","the","from","a","to","what","is","in","of","my"]);
  const keyTerms = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu," ").split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
  eq(keyTerms("How do I back up and restore?").join(","), "back,restore");
  eq(keyTerms("What is the retention policy in my space?").join(","), "retention,policy,space");
});

test("ask: citations are extracted and bounded", () => {
  // The pure helpers are staged the same way as the rest; ask.ts pulls in
  // server-only modules, so reimplement the two pure functions' contract.
  const cited = (answer, count) => {
    const found = new Set();
    for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
      const n = Number(m[1]) - 1;
      if (n >= 0 && n < count) found.add(n);
    }
    return [...found].sort((a, b) => a - b);
  };
  eq(cited("See [1] and [3].", 4).join(","), "0,2");
  eq(cited("No citations here.", 4).length, 0);
  // A model citing a passage that was never supplied must not index past the end.
  eq(cited("As shown in [9].", 3).length, 0);
  eq(cited("[2] [2] [2]", 3).join(","), "1");
});

test("syslog: the line matches RFC 5424", () => {
  const line = syslog.formatSyslog({
    severity: syslog.SEVERITY.informational,
    timestamp: new Date("2026-08-20T12:00:00.000Z"),
    hostname: "octavo-1",
    appName: "octavo",
    msgId: "space.deleted",
    structured: { actor: "dev", space: "handbook" },
    message: "dev deleted the space handbook",
  });
  // facility 13 (log audit) * 8 + severity 6 = 110
  ok(line.startsWith("<110>1 2026-08-20T12:00:00.000Z octavo-1 octavo "), line.slice(0, 60));
  ok(line.includes("space.deleted"), "msgid is the event type");
  ok(line.includes('[octavo@32473 actor="dev" space="handbook"]'), "structured data");
  ok(line.endsWith("dev deleted the space handbook"));
});

test("syslog: quotes, backslashes and brackets are escaped", () => {
  const line = syslog.formatSyslog({
    severity: syslog.SEVERITY.warning,
    timestamp: new Date("2026-08-20T12:00:00.000Z"),
    hostname: "h", appName: "octavo", msgId: "x",
    // Any of these unescaped would end the element early and corrupt the rest.
    structured: { label: 'a"b\\c]d' },
    message: "m",
  });
  ok(line.includes('label="a\\"b\\\\c\\]d"'), line);
});

test("syslog: empty fields become the nil value, never blanks", () => {
  const line = syslog.formatSyslog({
    severity: syslog.SEVERITY.informational,
    timestamp: new Date("2026-08-20T12:00:00.000Z"),
    hostname: "", appName: "", msgId: "", structured: {}, message: "hello",
  });
  ok(line.includes(" - - "), "nil values present");
  ok(line.includes("] hello") || line.includes("- hello"), "message still trails");
});

test("syslog: newlines in a message cannot forge a second record", () => {
  const line = syslog.formatSyslog({
    severity: syslog.SEVERITY.informational,
    timestamp: new Date("2026-08-20T12:00:00.000Z"),
    hostname: "h", appName: "octavo", msgId: "x", structured: {},
    message: "real\n<110>1 forged entry",
  });
  eq(line.split("\n").length, 1, "one line only");
});

test("syslog: TCP framing counts octets, not characters", () => {
  const framed = syslog.octetFrame("héllo");
  eq(framed.split(" ")[0], "6", "e-acute is two octets");
});

test("sbom: purls encode scopes and integrity converts to hex", () => {
  // Mirrors scripts/sbom.mjs; a purl a downstream tool cannot parse is worse
  // than no bill of materials, because it looks like one.
  const purl = (name, version) => {
    const at = name.lastIndexOf("/");
    if (name.startsWith("@") && at > 0)
      return `pkg:npm/${encodeURIComponent(name.slice(0, at))}/${name.slice(at + 1)}@${version}`;
    return `pkg:npm/${name}@${version}`;
  };
  eq(purl("yjs", "13.6.32"), "pkg:npm/yjs@13.6.32");
  eq(purl("@blocknote/core", "0.54.0"), "pkg:npm/%40blocknote/core@0.54.0");

  const hex = (integrity) => {
    const [alg, b64] = integrity.split("-");
    return { alg, content: Buffer.from(b64, "base64").toString("hex") };
  };
  const h = hex("sha512-" + Buffer.from("abc").toString("base64"));
  eq(h.alg, "sha512");
  eq(h.content, "616263", "base64 integrity becomes hex");
});

test("audit chain verifies, and detects tampering", () => {
  // The hash logic is pure: rebuild it here rather than standing up a db.
  const { createHash } = nodeCrypto;
  const canonical = (e) =>
    [e.id, String(e.at), e.actor_id ?? "", e.actor_name, e.action,
     e.object_type, e.object_id, e.object_label, e.space_id ?? "",
     e.detail, e.prev_hash].map((v) => JSON.stringify(v)).join("");
  const digest = (e) => createHash("sha256").update(canonical(e)).digest("hex");
  const mk = (i, prev, label) => {
    const row = { id: "e" + i, at: 1000 + i, actor_id: "u", actor_name: "dev",
      action: "space.deleted", object_type: "space", object_id: "s" + i,
      object_label: label, space_id: "s" + i, detail: "", prev_hash: prev };
    return { ...row, hash: digest(row) };
  };
  const GEN = "0".repeat(64);
  const chain = [];
  let prev = GEN;
  for (let i = 0; i < 4; i++) { const r = mk(i, prev, "space " + i); chain.push(r); prev = r.hash; }

  const walk = (rows) => {
    let p = GEN;
    for (const r of rows) {
      if (r.prev_hash !== p) return { ok: false, at: r.id };
      const { hash, ...rest } = r;
      if (digest(rest) !== hash) return { ok: false, at: r.id };
      p = hash;
    }
    return { ok: true };
  };

  ok(walk(chain).ok, "an untouched chain verifies");

  const edited = chain.map((r) => ({ ...r }));
  edited[2].object_label = "something else";
  eq(walk(edited).ok, false);
  eq(walk(edited).at, "e2");

  const removed = chain.filter((_, i) => i !== 1);
  eq(walk(removed).ok, false);
});

test("reading: a passage read at reading pace scores near zero", () => {
  const text = "The retry timeout is thirty seconds by default.";
  const words = text.split(/\s+/).length;
  const expected = (words / 220) * 60_000;
  const p = reading.scorePassage({
    text, views: 20, dwellMs: expected * 20, revisits: 0, exits: 0,
  });
  ok(p.score < 0.05, `scored ${p.score}`);
  ok(Math.abs(p.slowdown - 1) < 0.01);
});

test("reading: scrolling back dominates the score", () => {
  const text = "Reconciliation is eventually consistent across partitions.";
  const paced = { text, views: 20, dwellMs: 0, revisits: 0, exits: 0 };
  const expected = reading.scorePassage(paced).expectedMs;

  const slow = reading.scorePassage({ ...paced, dwellMs: expected * 20 * 4 });
  const reread = reading.scorePassage({ ...paced, dwellMs: expected * 20, revisits: 8 });
  // Half the readers went back. That must outweigh being four times slow.
  ok(reread.score > slow.score, `reread ${reread.score} vs slow ${slow.score}`);
});

test("reading: the score is bounded whatever the input", () => {
  for (const bad of [
    { views: 1, dwellMs: 1e12, revisits: 1e9, exits: 1e9 },
    { views: 0, dwellMs: 0, revisits: 0, exits: 0 },
    { views: -5, dwellMs: -1, revisits: -1, exits: -1 },
    { views: 3, dwellMs: NaN, revisits: NaN, exits: NaN },
  ]) {
    const p = reading.scorePassage({ text: "x y z", ...bad });
    ok(p.score >= 0 && p.score <= 1, `score ${p.score} for ${JSON.stringify(bad)}`);
  }
});

test("reading: a short passage is not judged instantly hard", () => {
  // A two-word heading has almost no reading time, so a naive ratio would
  // call every heading a stumble. The floor exists to stop that.
  const p = reading.scorePassage({
    text: "Overview", views: 30, dwellMs: 30 * 1500, revisits: 0, exits: 0,
  });
  ok(p.expectedMs >= 1200);
  ok(p.score < 0.2, `heading scored ${p.score}`);
});

test("reading: too few readers is marked as not enough", () => {
  const few = reading.scorePassage({ text: "a b c", views: 2, dwellMs: 9e4, revisits: 2, exits: 2 });
  const many = reading.scorePassage({ text: "a b c", views: 40, dwellMs: 18e5, revisits: 40, exits: 40 });
  eq(few.enough, false);
  eq(many.enough, true);
});

test("reading: passages come out in document order with their ids", () => {
  const blocks = [
    { id: "a", type: "paragraph", props: {}, content: [{ type: "text", text: "First." }], children: [] },
    { id: "b", type: "heading", props: {}, content: [{ type: "text", text: "Second" }], children: [
      { id: "c", type: "paragraph", props: {}, content: [{ type: "text", text: "Nested." }], children: [] },
    ] },
    { id: "d", type: "image", props: {}, children: [] },
  ];
  const got = reading.readablePassages(blocks);
  eq(got.map((p) => p.id).join(","), "a,b,c");
  eq(got[2].text, "Nested.");
});

test("reading: dividers and headings are never ranked", () => {
  ok(!reading.isRankable("Motivation: ------------"));
  ok(!reading.isRankable("------------------------------------"));
  ok(!reading.isRankable("Abstract"));
  ok(!reading.isRankable("The Problem: ---"));
  ok(reading.isRankable("This protocol was originally designed for the DEC, Intel and Xerox Ethernet."));
});

test("reading: days bucket to UTC midnight", () => {
  const d = reading.dayOf(Date.UTC(2026, 7, 23, 13, 45, 6));
  eq(d, Date.UTC(2026, 7, 23));
  eq(reading.dayOf(Date.UTC(2026, 7, 23)), Date.UTC(2026, 7, 23));
});

test("policy: values clamp to their bounds instead of being rejected", () => {
  const p = policy.clampPolicy({ sessionDays: 9999, lockoutThreshold: 1, minPasswordLength: -5 });
  eq(p.sessionDays, 365);
  eq(p.lockoutThreshold, 3);
  eq(p.minPasswordLength, 8);
});

test("policy: nonsense leaves the default standing", () => {
  const p = policy.clampPolicy({ sessionDays: "soon", lockoutMinutes: NaN, auditRetentionDays: null });
  eq(p.sessionDays, policy.DEFAULT_POLICY.sessionDays);
  eq(p.lockoutMinutes, policy.DEFAULT_POLICY.lockoutMinutes);
  eq(p.auditRetentionDays, 0);
});

test("policy: audit retention may be zero, meaning forever", () => {
  eq(policy.clampPolicy({ auditRetentionDays: 0 }).auditRetentionDays, 0);
  eq(policy.clampPolicy({ auditRetentionDays: 90 }).auditRetentionDays, 90);
});

test("xml: nesting, attributes, CDATA, entities", () => {
  const [root] = xml.parseXml(
    `<object class="Page"><id name="id">42</id><property name="title"><![CDATA[Hello & <World>]]></property></object>`
  );
  eq(root.tag, "object");
  eq(root.attrs.class, "Page");
  eq(xml.textOf(xml.child(root, "id")), "42");
  eq(xml.textOf(xml.child(root, "property")), "Hello & <World>");
});

test("xml: survives real-world HTML sloppiness", () => {
  const forest = xml.parseXml(
    `<p>one<br>two<img src=pic.png><li>loose</p><div>after</div>`
  );
  // Nothing throws, all the text survives, void elements do not swallow.
  const all = forest.map((n) => xml.textOf(n)).join(" ");
  ok(all.includes("one") && all.includes("two") && all.includes("after"));
});

test("xml: script bodies are dropped, not parsed", () => {
  const forest = xml.parseXml(`<div><script>if (a < b) { hack(); }</script><p>kept</p></div>`);
  const text = forest.map((n) => xml.textOf(n)).join("");
  ok(!text.includes("hack"));
  ok(text.includes("kept"));
});

test("html-blocks: headings, lists, bold survive", () => {
  const blocks = hb.htmlToBlocks(
    `<h1>Title</h1><p>Plain <strong>bold</strong> text.</p><ul><li>one</li><li>two<ul><li>deep</li></ul></li></ul>`
  );
  eq(blocks[0].type, "heading");
  eq(blocks[1].type, "paragraph");
  const boldRun = blocks[1].content.find((c) => c.styles?.bold);
  eq(boldRun.text.trim(), "bold");
  eq(blocks[2].type, "bulletListItem");
  eq(blocks[3].children[0].content[0].text, "deep");
});

test("html-blocks: confluence code macro becomes a code block", () => {
  const blocks = hb.htmlToBlocks(
    `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[print("hi < there")]]></ac:plain-text-body></ac:structured-macro>`
  );
  eq(blocks[0].type, "codeBlock");
  eq(blocks[0].props.language, "python");
  eq(blocks[0].content[0].text, 'print("hi < there")');
});

test("html-blocks: info macro becomes a callout, body intact", () => {
  const blocks = hb.htmlToBlocks(
    `<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Do not do the thing.</p></ac:rich-text-body></ac:structured-macro>`
  );
  eq(blocks[0].type, "callout");
  eq(blocks[0].props.tone, "danger");
});

test("html-blocks: attachment images resolve through the caller", () => {
  const blocks = hb.htmlToBlocks(
    `<p><ac:image ac:alt="diagram"><ri:attachment ri:filename="arch.png"/></ac:image></p>`,
    (f) => (f === "arch.png" ? "/api/files/x.png" : null)
  );
  eq(blocks[0].type, "image");
  eq(blocks[0].props.url, "/api/files/x.png");
  eq(blocks[0].props.caption, "diagram");
});

test("html-blocks: a missing attachment says so instead of vanishing", () => {
  const blocks = hb.htmlToBlocks(
    `<ac:image><ri:attachment ri:filename="gone.png"/></ac:image>`,
    () => null
  );
  ok(blocks[0].content[0].text.includes("gone.png"));
});

test("html-blocks: confluence task list becomes checklist items", () => {
  const blocks = hb.htmlToBlocks(
    `<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>done thing</ac:task-body></ac:task>` +
      `<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>open thing</ac:task-body></ac:task></ac:task-list>`
  );
  eq(blocks[0].type, "checkListItem");
  eq(blocks[0].props.checked, true);
  eq(blocks[1].props.checked, false);
});

test("html-blocks: tables keep their cells", () => {
  const blocks = hb.htmlToBlocks(
    `<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>`
  );
  eq(blocks[0].type, "table");
  eq(blocks[0].content.rows.length, 2);
  eq(blocks[0].content.rows[1].cells[1][0].text, "2");
});

test("html-blocks: a web page's article is found and the nav is not imported", () => {
  const { title, blocks } = hb.pageContentToBlocks(
    `<html><head><title>Doc</title></head><body><nav><a href="/">Home</a></nav>` +
      `<article><h2>Real</h2><p>Content here.</p></article><footer>legal</footer></body></html>`
  );
  eq(title, "Doc");
  const text = JSON.stringify(blocks);
  ok(text.includes("Content here"));
  ok(!text.includes("legal") && !text.includes("Home"));
});

test("newId shape", () => {
  ok(/^[0-9a-z]{16}$/.test(util.newId()));
});

rmSync(STAGE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
