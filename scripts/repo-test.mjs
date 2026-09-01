// Prove the GitHub and GitLab clients against a stub of each, touching no
// real repository.
//
// A push is a commit on somebody's branch: not something to "try" against
// production to see if the code works. The stub speaks each host's actual
// protocol — GitHub's blob/tree/commit/ref dance, GitLab's single actions
// call — and the failure cases matter as much as the successes, because a
// push that half-lands leaves a repository in a state nobody chose.
//
// Usage: node scripts/repo-test.mjs
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const STAGE = path.join(process.cwd(), ".repo-stage");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
writeFileSync(
  path.join(STAGE, "git-host.ts"),
  readFileSync("src/lib/git-host.ts", "utf8").replace(/import "server-only";\n?/, "")
);
const gh = await import(pathToFileURL(path.join(STAGE, "git-host.ts")));

/* ---- the stub ---- */
let mode = "ok";
const seen = { auth: null, paths: [], bodies: [], method: [] };
const json = (res, code, body) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://x");
    seen.auth = req.headers.authorization ?? req.headers["private-token"] ?? null;
    seen.paths.push(url.pathname);
    seen.method.push(req.method);
    if (body) seen.bodies.push(JSON.parse(body));

    // ---- GitHub ----
    if (url.pathname === "/repos/acme/docs/branches/main")
      return mode === "badToken" ? json(res, 401, { message: "Bad credentials" }) : json(res, 200, { name: "main" });
    if (url.pathname === "/repos/acme/docs/git/trees/main")
      return mode === "truncated"
        ? json(res, 200, { truncated: true, tree: [] })
        : json(res, 200, { truncated: false, tree: [
            { path: "docs/intro.md", type: "blob", sha: "s1" },
            { path: "docs/deep/guide.md", type: "blob", sha: "s2" },
            { path: "docs/logo.png", type: "blob", sha: "s3" },
            { path: "README.md", type: "blob", sha: "s4" },
          ] });
    if (url.pathname.startsWith("/repos/acme/docs/contents/"))
      return json(res, 200, { encoding: "base64", content: Buffer.from(`# ${url.pathname}`).toString("base64") });
    if (url.pathname === "/repos/acme/docs/git/ref/heads/main")
      return json(res, 200, { object: { sha: "head1" } });
    if (url.pathname === "/repos/acme/docs/git/blobs")
      return mode === "blobFails" ? json(res, 422, { message: "no" }) : json(res, 201, { sha: `b${seen.paths.length}` });
    if (url.pathname === "/repos/acme/docs/git/trees")
      return json(res, 201, { sha: "tree1" });
    if (url.pathname === "/repos/acme/docs/git/commits")
      return json(res, 201, { sha: "commit1" });
    if (url.pathname === "/repos/acme/docs/git/refs/heads/main")
      return mode === "refFails" ? json(res, 422, { message: "not a fast forward" }) : json(res, 200, { ref: "ok" });

    // ---- GitLab ----
    if (url.pathname === "/api/v4/projects/acme%2Fdocs/repository/branches/main")
      return json(res, 200, { name: "main" });
    if (url.pathname === "/api/v4/projects/acme%2Fdocs/repository/tree") {
      if (url.searchParams.get("page") !== "1") return json(res, 200, []);
      return json(res, 200, [
        { path: "docs/intro.md", type: "blob", id: "g1" },
        { path: "docs/deep/guide.md", type: "blob", id: "g2" },
        { path: "docs/logo.png", type: "blob", id: "g3" },
      ]);
    }
    if (url.pathname.includes("/repository/files/") && url.pathname.endsWith("/raw"))
      return res.writeHead(200).end("# from gitlab");
    if (url.pathname === "/api/v4/projects/acme%2Fdocs/repository/commits")
      return mode === "commitFails" ? json(res, 400, { message: "bad" }) : json(res, 201, { id: "glcommit1" });

    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => stub.listen(9097, r));
const BASE = "http://127.0.0.1:9097";

const GITHUB = { provider: "github", endpoint: BASE, repo: "acme/docs", branch: "main", path: "docs", token: "ghtok" };
const GITLAB = { provider: "gitlab", endpoint: `${BASE}/api/v4`, repo: "acme/docs", branch: "main", path: "docs", token: "gltok" };

console.log("\nGitHub\n");
{
  mode = "ok"; seen.paths = []; seen.bodies = []; seen.method = [];
  const v = await gh.verifyConnection(GITHUB);
  ok("a connection is verified before anything is written", v.ok, JSON.stringify(v));
  ok("the token is sent as a bearer credential", String(seen.auth).startsWith("Bearer "));

  const list = await gh.listMarkdown(GITHUB);
  ok("only markdown under the configured path is listed",
    list.ok && list.value.map((f) => f.path).sort().join(",") === "deep/guide.md,intro.md",
    JSON.stringify(list));

  const body = await gh.readFile(GITHUB, "intro.md");
  ok("a file's content comes back decoded", body.ok && body.value.includes("/repos/acme/docs/contents/docs/intro.md"), JSON.stringify(body));

  seen.paths = []; seen.bodies = []; seen.method = [];
  const push = await gh.pushFiles(GITHUB, [
    { path: "intro.md", content: "# Intro\n" },
    { path: "deep/guide.md", content: "# Guide\n" },
  ], "Update 2 pages");
  ok("a push returns the commit it made", push.ok && push.value.commit === "commit1", JSON.stringify(push));
  ok("it is ONE commit, not one per file",
    seen.paths.filter((p) => p === "/repos/acme/docs/git/commits").length === 1,
    seen.paths.join(" "));
  ok("the configured path prefixes every file written",
    JSON.stringify(seen.bodies).includes('"docs/intro.md"') &&
    JSON.stringify(seen.bodies).includes('"docs/deep/guide.md"'),
    JSON.stringify(seen.bodies));
  ok("the new commit builds on the current head",
    seen.bodies.some((b) => Array.isArray(b.parents) && b.parents[0] === "head1"),
    JSON.stringify(seen.bodies));
  ok("the branch is moved to the new commit",
    seen.bodies.some((b) => b.sha === "commit1"), JSON.stringify(seen.bodies));

  ok("nothing to push makes no request at all",
    (await gh.pushFiles(GITHUB, [], "x")).ok && (await gh.pushFiles(GITHUB, [], "x")).value.files === 0);

  mode = "truncated";
  const trunc = await gh.listMarkdown(GITHUB);
  // Half a listing would look like "the rest was deleted upstream".
  ok("a truncated tree is refused rather than half-synced", !trunc.ok && /too large/.test(trunc.error), JSON.stringify(trunc));

  mode = "badToken";
  const bad = await gh.verifyConnection(GITHUB);
  ok("a rejected token reports the host's answer", !bad.ok && bad.error.includes("401"), JSON.stringify(bad));

  mode = "refFails";
  const noFf = await gh.pushFiles(GITHUB, [{ path: "intro.md", content: "x" }], "m");
  ok("a branch that moved under us fails loudly", !noFf.ok && noFf.error.includes("422"), JSON.stringify(noFf));

  mode = "blobFails";
  const noBlob = await gh.pushFiles(GITHUB, [{ path: "intro.md", content: "x" }], "m");
  ok("a failed upload stops before any commit is made", !noBlob.ok, JSON.stringify(noBlob));
}

console.log("\nGitLab\n");
{
  mode = "ok"; seen.paths = []; seen.bodies = [];
  const v = await gh.verifyConnection(GITLAB);
  ok("a connection is verified", v.ok, JSON.stringify(v));
  ok("the token is sent as a private token", seen.auth === "gltok");

  const list = await gh.listMarkdown(GITLAB);
  ok("only markdown under the configured path is listed",
    list.ok && list.value.map((f) => f.path).sort().join(",") === "deep/guide.md,intro.md",
    JSON.stringify(list));

  const body = await gh.readFile(GITLAB, "intro.md");
  ok("a file's content comes back raw", body.ok && body.value === "# from gitlab", JSON.stringify(body));

  seen.bodies = [];
  const push = await gh.pushFiles(GITLAB, [
    { path: "intro.md", content: "# Intro\n" },
    { path: "new/page.md", content: "# New\n" },
  ], "Update 2 pages");
  ok("a push returns the commit it made", push.ok && push.value.commit === "glcommit1", JSON.stringify(push));
  const commitBody = seen.bodies.find((b) => Array.isArray(b.actions));
  ok("an existing file updates and a new one is created",
    commitBody?.actions.find((a) => a.file_path === "docs/intro.md")?.action === "update" &&
    commitBody?.actions.find((a) => a.file_path === "docs/new/page.md")?.action === "create",
    JSON.stringify(commitBody));
  ok("it is one commit carrying every change", commitBody?.actions.length === 2, JSON.stringify(commitBody));

  mode = "commitFails";
  const bad = await gh.pushFiles(GITLAB, [{ path: "a.md", content: "x" }], "m");
  ok("a refused commit reports why", !bad.ok && bad.error.includes("400"), JSON.stringify(bad));
}

console.log("\nURLs\n");
{
  ok("a GitHub file links to its blob view",
    gh.fileUrl({ ...GITHUB, endpoint: "https://api.github.com" }, "intro.md") ===
      "https://github.com/acme/docs/blob/main/docs/intro.md",
    gh.fileUrl({ ...GITHUB, endpoint: "https://api.github.com" }, "intro.md"));
  ok("a GitLab file links to its blob view",
    gh.fileUrl({ ...GITLAB, endpoint: "https://gitlab.com/api/v4" }, "intro.md") ===
      "https://gitlab.com/acme/docs/-/blob/main/docs/intro.md",
    gh.fileUrl({ ...GITLAB, endpoint: "https://gitlab.com/api/v4" }, "intro.md"));
}

stub.close();
rmSync(STAGE, { recursive: true, force: true });
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
