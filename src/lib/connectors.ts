import "server-only";
import { createHmac } from "node:crypto";
import { getDb } from "./db";
import { getPage } from "./data";
import { parseBlocks, inlineText } from "./blocks";
import { encryptSecret, decryptSecret } from "./crypto";
import { newId, now } from "./util";

// Runnable cookbooks. The isolation design law, enforced here, not by trust:
//
//  1. A connector belongs to whoever configured it and is scoped to ONE space
//     (or the whole instance if an admin chooses). A run can only use a
//     connector visible from the page's space.
//  2. A run dispatches the SAVED, PUBLISHED block content read from the
//     database by id — never text supplied by the client. The client sends a
//     block id; the server reads what is actually on the page.
//  3. Octavo never executes anything itself. It dispatches to a system that
//     already enforces its own credentials and RBAC (a webhook receiver,
//     Airflow, GitHub Actions) and renders what comes back.
//  4. Every run is immutably logged with who, what, when, and which page
//     version — the log is a feature, shown on the page.

export const CONNECTOR_TYPES = ["webhook", "airflow", "github_actions"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export type Connector = {
  id: string;
  name: string;
  type: string;
  base_url: string;
  space_id: string | null;
  created_by: string;
  created_at: number;
};

export function listConnectors(): Connector[] {
  return getDb()
    .prepare(
      `SELECT id, name, type, base_url, space_id, created_by, created_at
       FROM connectors ORDER BY created_at DESC`
    )
    .all() as Connector[];
}

/** Connectors usable from a given space: its own, plus instance-wide ones. */
export function connectorsForSpace(spaceId: string): Connector[] {
  return getDb()
    .prepare(
      `SELECT id, name, type, base_url, space_id, created_by, created_at
       FROM connectors WHERE space_id = ? OR space_id IS NULL
       ORDER BY created_at DESC`
    )
    .all(spaceId) as Connector[];
}

export function createConnector(input: {
  name: string;
  type: string;
  baseUrl: string;
  credential: string;
  spaceId: string | null;
  createdBy: string;
}): void {
  const type = CONNECTOR_TYPES.includes(input.type as ConnectorType)
    ? input.type
    : "webhook";
  getDb()
    .prepare(
      `INSERT INTO connectors (id, name, type, base_url, credential, space_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(),
      input.name.trim().slice(0, 80) || "Connector",
      type,
      input.baseUrl.trim(),
      input.credential ? encryptSecret(input.credential) : "",
      input.spaceId,
      input.createdBy,
      now()
    );
}

export function deleteConnector(id: string): void {
  getDb().prepare("DELETE FROM connectors WHERE id = ?").run(id);
}

function getConnector(id: string) {
  return getDb().prepare("SELECT * FROM connectors WHERE id = ?").get(id) as
    | (Connector & { credential: string })
    | undefined;
}

/** Extract a single code block's text from the page's saved content. */
function findCodeBlock(pageContent: string, blockId: string) {
  const search = (blocks: ReturnType<typeof parseBlocks>): { code: string; language: string } | null => {
    for (const b of blocks) {
      if (b.id === blockId && b.type === "codeBlock") {
        return {
          code: inlineText(b.content),
          language: String(b.props?.language ?? ""),
        };
      }
      if (b.children?.length) {
        const hit = search(b.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return search(parseBlocks(pageContent));
}

export type RunResult = {
  runId: string;
  status: "succeeded" | "failed" | "running";
  output: string;
  externalUrl: string;
};

/**
 * Start a run. Enforces the isolation law, reads the saved block, dispatches.
 * `params` is caller-supplied JSON forwarded to the target — but the CODE is
 * always read from the database, never from the client.
 */
export async function startRun(input: {
  pageId: string;
  blockId: string;
  connectorId: string;
  spaceId: string;
  user: { id: string; name: string };
  params: Record<string, unknown>;
}): Promise<RunResult> {
  const db = getDb();
  const connector = getConnector(input.connectorId);
  // Law #1: the connector must be visible from THIS space.
  if (
    !connector ||
    (connector.space_id !== null && connector.space_id !== input.spaceId)
  ) {
    return fail("connector not available for this space");
  }
  const page = getPage(input.pageId);
  if (!page || page.space_id !== input.spaceId) {
    return fail("page not found");
  }
  // Law #2: read the saved block from the DB, never trust client-sent code.
  const block = findCodeBlock(page.content, input.blockId);
  if (!block) return fail("no runnable code block with that id on this page");

  const runId = newId();
  db.prepare(
    `INSERT INTO runs (id, page_id, block_id, connector_id, connector_name, user_id, user_name, page_version, status, started)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
  ).run(
    runId,
    input.pageId,
    input.blockId,
    connector.id,
    connector.name,
    input.user.id,
    input.user.name,
    page.updated_at,
    now()
  );

  let result: { status: "succeeded" | "failed"; output: string; externalUrl: string };
  try {
    result = await dispatch(connector, block, input.params, {
      page: page.slug,
      user: input.user.name,
    });
  } catch (e) {
    result = {
      status: "failed",
      output: e instanceof Error ? e.message : "dispatch failed",
      externalUrl: "",
    };
  }

  db.prepare(
    "UPDATE runs SET status = ?, output = ?, external_url = ?, finished = ? WHERE id = ?"
  ).run(result.status, result.output.slice(0, 20000), result.externalUrl, now(), runId);

  return { runId, ...result };

  function fail(msg: string): RunResult {
    return { runId: "", status: "failed", output: msg, externalUrl: "" };
  }
}

async function dispatch(
  connector: Connector & { credential: string },
  block: { code: string; language: string },
  params: Record<string, unknown>,
  ctx: { page: string; user: string }
): Promise<{ status: "succeeded" | "failed"; output: string; externalUrl: string }> {
  const secret = connector.credential ? decryptSecret(connector.credential) : "";
  const controller = AbortSignal.timeout(30_000);

  if (connector.type === "airflow") {
    // POST a DAG run; the code block's first line names the dag_id.
    const dagId = block.code.split("\n")[0].replace(/^#\s*dag:\s*/i, "").trim();
    const res = await fetch(
      `${connector.base_url.replace(/\/$/, "")}/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ conf: params }),
        signal: controller,
      }
    );
    const body = await res.text();
    return {
      status: res.ok ? "succeeded" : "failed",
      output: `Triggered DAG "${dagId}" — HTTP ${res.status}\n${body.slice(0, 4000)}`,
      externalUrl: `${connector.base_url.replace(/\/$/, "")}/dags/${dagId}/grid`,
    };
  }

  if (connector.type === "github_actions") {
    // base_url = https://api.github.com/repos/OWNER/REPO/actions/workflows/FILE.yml
    const res = await fetch(`${connector.base_url.replace(/\/$/, "")}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${secret}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: String(params.ref ?? "main"), inputs: params }),
      signal: controller,
    });
    return {
      status: res.ok ? "succeeded" : "failed",
      output: `workflow_dispatch — HTTP ${res.status}${res.ok ? " (queued)" : "\n" + (await res.text()).slice(0, 2000)}`,
      externalUrl: connector.base_url.replace(/api\.github\.com\/repos\//, "github.com/").replace(/\/actions\/workflows\/.*/, "/actions"),
    };
  }

  // webhook — the universal connector: signed JSON POST, response rendered.
  const payload = JSON.stringify({
    code: block.code,
    language: block.language,
    params,
    page: ctx.page,
    user: ctx.user,
    at: now(),
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    headers["X-Octavo-Signature"] =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  }
  const res = await fetch(connector.base_url, {
    method: "POST",
    headers,
    body: payload,
    signal: controller,
  });
  const text = await res.text();
  return {
    status: res.ok ? "succeeded" : "failed",
    output: `HTTP ${res.status}\n${text.slice(0, 8000)}`,
    externalUrl: "",
  };
}

export type Run = {
  id: string;
  block_id: string;
  connector_name: string;
  user_name: string;
  status: string;
  output: string;
  external_url: string;
  started: number;
  finished: number | null;
};

export function runsForPage(pageId: string, limit = 20): Run[] {
  return getDb()
    .prepare(
      `SELECT id, block_id, connector_name, user_name, status, output, external_url, started, finished
       FROM runs WHERE page_id = ? ORDER BY started DESC LIMIT ?`
    )
    .all(pageId, limit) as Run[];
}

export function latestRunForBlock(pageId: string, blockId: string): Run | null {
  return (getDb()
    .prepare(
      `SELECT id, block_id, connector_name, user_name, status, output, external_url, started, finished
       FROM runs WHERE page_id = ? AND block_id = ? ORDER BY started DESC LIMIT 1`
    )
    .get(pageId, blockId) ?? null) as Run | null;
}
