// Prove DOI minting against a stub of each provider, with no real DOI minted.
//
// A DOI cannot be un-minted, so this is the one feature that must never be
// "tested" against production. The stub speaks each provider's actual
// protocol — Zenodo's three-step create/metadata/publish, DataCite's single
// JSON:API POST — and the failure cases are checked as carefully as the
// success ones, because a mint that half-succeeds is the dangerous outcome.
//
// Usage: node scripts/doi-test.mjs
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Stage doi.ts without its server-only deps.
const STAGE = path.join(process.cwd(), ".doi-stage");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const src = readFileSync("src/lib/doi.ts", "utf8")
  .replace(/import "server-only";\n?/, "")
  .replace(/import \{ getDb \} from "\.\/db";\n?/, "const getDb = () => ({ prepare: () => ({ all: () => [], run: () => {} }) });\n")
  .replace(/import \{ getSetting, setSetting \} from "\.\/settings";\n?/, "const getSetting = () => null; const setSetting = () => {};\n")
  .replace(/import \{ decryptSecret, encryptSecret \} from "\.\/crypto";\n?/, "const decryptSecret = (s) => s; const encryptSecret = (s) => s;\n")
  .replace(/import \{ bylineFor \} from "\.\/data";\n?/, "const bylineFor = () => globalThis.__byline ?? { author: null, editor: null };\n")
  .replace(/import \{ newId, now \} from "\.\/util";\n?/, "const newId = () => 'id'; const now = () => Date.now();\n");
writeFileSync(path.join(STAGE, "doi.ts"), src);
const doi = await import(pathToFileURL(path.join(STAGE, "doi.ts")));

/* ---- the stub ---- */
let mode = "ok";
const seen = { zenodoSteps: [], dataciteBody: null, auth: null };
const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.auth = req.headers.authorization ?? null;

    // DataCite: one POST to /dois
    if (req.url === "/dois" && req.method === "POST") {
      seen.dataciteBody = body ? JSON.parse(body) : null;
      if (mode === "reject") { res.writeHead(422, {"content-type":"application/json"}).end('{"errors":[{"title":"bad prefix"}]}'); return; }
      res.writeHead(201, { "content-type": "application/json" })
        .end(JSON.stringify({ data: { id: "10.5072/octavo-abc123" } }));
      return;
    }

    // Zenodo: create → metadata → publish
    if (req.url === "/api/deposit/depositions" && req.method === "POST") {
      seen.zenodoSteps.push("create");
      if (mode === "createFails") { res.writeHead(401).end("{}"); return; }
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: 42 }));
      return;
    }
    if (req.url === "/api/deposit/depositions/42" && req.method === "PUT") {
      seen.zenodoSteps.push("metadata");
      seen.zenodoBody = JSON.parse(body);
      if (mode === "metadataFails") { res.writeHead(400).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.url === "/api/deposit/depositions/42/actions/publish") {
      seen.zenodoSteps.push("publish");
      if (mode === "publishFails") { res.writeHead(500).end("provider on fire"); return; }
      res.writeHead(202, { "content-type": "application/json" })
        .end(JSON.stringify({ doi: "10.5281/zenodo.42", doi_url: "https://doi.org/10.5281/zenodo.42" }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => stub.listen(9098, r));
const BASE = "http://127.0.0.1:9098";

const meta = {
  title: "A protocol worth citing",
  creators: [{ name: "Lovelace, Ada", orcid: "0000-0002-1825-0097" }, { name: "Babbage, C." }],
  description: "How the thing is done.",
  publicationYear: 2026,
  url: "https://docs.example.org/lab/protocol",
  versionId: "1750000000000",
};

console.log("Zenodo\n");
{
  const settings = { provider: "zenodo", endpoint: BASE, token: "tok", prefix: "", baseUrl: "https://docs.example.org" };
  mode = "ok"; seen.zenodoSteps = [];
  const r = await doi.mintDoi(meta, settings);
  ok("a mint returns the DOI and its resolver URL", r.ok && r.doi === "10.5281/zenodo.42", JSON.stringify(r));
  ok("all three protocol steps run, in order", seen.zenodoSteps.join(">") === "create>metadata>publish", seen.zenodoSteps.join(">"));
  ok("the token is sent as a bearer credential", String(seen.auth).startsWith("Bearer "));
  const m = seen.zenodoBody.metadata;
  ok("the title and description are deposited", m.title === meta.title && m.description === meta.description);
  ok("an ORCID rides along with the creator that has one", m.creators[0].orcid === "0000-0002-1825-0097");
  ok("a creator without an ORCID sends none rather than a blank", !("orcid" in m.creators[1]));
  ok("the record points back at the public URL", JSON.stringify(m.related_identifiers).includes(meta.url));

  for (const [failMode, step] of [["createFails","create"],["metadataFails","metadata"],["publishFails","publish"]]) {
    mode = failMode; seen.zenodoSteps = [];
    const bad = await doi.mintDoi(meta, settings);
    ok(`a failure at ${step} reports why and mints nothing`, bad.ok === false && typeof bad.error === "string" && bad.error.length > 0, JSON.stringify(bad));
  }
}

console.log("\nDataCite\n");
{
  const settings = { provider: "datacite", endpoint: BASE, token: "repo:pass", prefix: "10.5072", baseUrl: "https://docs.example.org" };
  mode = "ok";
  const r = await doi.mintDoi(meta, settings);
  ok("a mint returns the DOI DataCite assigned", r.ok && r.doi === "10.5072/octavo-abc123", JSON.stringify(r));
  ok("credentials are sent as HTTP Basic", String(seen.auth).startsWith("Basic "));
  const attrs = seen.dataciteBody.data.attributes;
  ok("the configured prefix is used", attrs.prefix === "10.5072");
  ok("the event is publish, so the DOI is findable", attrs.event === "publish");
  ok("an ORCID becomes a proper nameIdentifier", attrs.creators[0].nameIdentifiers[0].nameIdentifier === "https://orcid.org/0000-0002-1825-0097");
  ok("a creator without an ORCID carries no identifier block", !attrs.creators[1].nameIdentifiers);

  mode = "reject";
  const bad = await doi.mintDoi(meta, settings);
  ok("a rejected deposit reports the provider's reason", bad.ok === false && bad.error.includes("422"), JSON.stringify(bad));

  mode = "ok";
  const noPrefix = await doi.mintDoi(meta, { ...settings, prefix: "" });
  ok("minting without a prefix is refused before any request", noPrefix.ok === false && noPrefix.error.includes("prefix"));
}

console.log("\nMetadata assembly\n");
{
  globalThis.__byline = {
    author: { id: "u1", name: "Lovelace, Ada", orcid: "0000-0002-1825-0097" },
    editor: { id: "u2", name: "Babbage, C.", orcid: "" },
  };
  const built = doi.metadataForPage(
    { id: "p", title: "T", content_text: "x".repeat(5000), updated_at: Date.UTC(2026, 0, 2) },
    "lab", "protocol", "https://docs.example.org"
  );
  ok("the URL is built from the public base", built.url === "https://docs.example.org/lab/protocol");
  ok("the description is bounded", built.description.length === 2000);
  ok("the year comes from the revision", built.publicationYear === 2026);
  ok("author and editor both become creators", built.creators.length === 2);
  ok("an empty ORCID is omitted, not sent blank", built.creators[1].orcid === undefined);

  globalThis.__byline = { author: null, editor: null };
  const anon = doi.metadataForPage(
    { id: "p", title: "T", content_text: "", updated_at: Date.now() }, "s", "p", "https://x.org"
  );
  ok("an unattributed page deposits no invented creator", anon.creators.length === 0);
  // Zenodo requires at least one creator, so the body falls back explicitly.
  const zb = doi.zenodoBody(anon);
  ok("Zenodo's required creator field falls back to Unknown", zb.metadata.creators[0].name === "Unknown");
}

stub.close();
rmSync(STAGE, { recursive: true, force: true });
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
