import http from "node:http";
import https from "node:https";
/** Remote job adapters. This process never executes document code. */
export type JobState = "running" | "succeeded" | "failed" | "cancelled";
export type JobUpdate = {status: JobState; output: string; externalUrl: string; remoteId?: string};
export function jobSpec(code: string, type: string, runId: string): Record<string, unknown> {
  if (code.length > 100_000) throw new Error("Job specification exceeds 100 KB");
  const spec = JSON.parse(code);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Use a JSON job specification");
  if (type === "ray") {
    if (typeof spec.entrypoint !== "string" || !spec.entrypoint.trim()) throw new Error("Ray needs an entrypoint command");
    const allowed = ["entrypoint", "runtime_env", "entrypoint_num_cpus", "entrypoint_num_gpus", "entrypoint_memory", "entrypoint_resources", "metadata"];
    for (const key of Object.keys(spec)) if (!allowed.includes(key)) throw new Error(`Unsupported Ray field: ${key}`);
    for (const key of ["entrypoint_num_cpus", "entrypoint_num_gpus", "entrypoint_memory"]) if (key in spec && (typeof spec[key] !== "number" || !Number.isFinite(spec[key]) || spec[key] < 0)) throw new Error(`Invalid ${key}`);
    return {...spec, submission_id: `octavo-${runId}`};
  }
  if (!spec.task || typeof spec.task !== "object" || Array.isArray(spec.task)) throw new Error("SkyPilot needs a task object");
  if (typeof spec.task.run !== "string" || !spec.task.run.trim()) throw new Error("SkyPilot task needs a run command");
  if (Object.keys(spec).some(k => !["task", "source"].includes(k))) throw new Error("Use task and optional source fields");
  return {...spec, submission_id: `octavo-${runId}`};
}

async function request(base: string, path: string, token: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid job service URL");
  // Ray rejects browser Fetch-Metadata headers; use a server HTTP client.
  return new Promise((resolve, reject) => {
    const target = new URL(`${base.replace(/\/+$/, "")}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (target.protocol === "https:" ? https : http).request(target, {
      method, headers: {"Content-Type":"application/json", ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(payload ? {"Content-Length":Buffer.byteLength(payload)} : {})},
    }, res => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`Job service returned HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", chunk => { bytes += chunk.length; if(bytes > 1_000_000) { res.destroy(); reject(new Error("Job service response exceeds 1 MB")); } else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => { try { const data = JSON.parse(Buffer.concat(chunks).toString() || "{}"); if(!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid job service response"); resolve(data); } catch(e) { reject(e); } });
    });
    const timeout = setTimeout(() => req.destroy(new Error("Job service timed out; inspect the target before retrying")), 20_000);
    req.on("close", () => clearTimeout(timeout)); req.on("error", reject);
    req.end(payload);
  });
}
export async function submitJob(type: string, base: string, token: string, code: string, runId: string): Promise<JobUpdate> {
  const spec = jobSpec(code, type, runId);
  const data = await request(base, type === "ray" ? "/api/jobs/" : "/jobs", token, "POST", spec);
  const id = type === "ray" ? data.submission_id ?? data.job_id : data.id;
  if(typeof id !== "string" || !/^[\w.-]{1,200}$/.test(id)) throw new Error("Job service returned no valid job ID; inspect its dashboard before retrying");
  return {status:"running", remoteId:id, output:`Submitted ${id}. Submission is not completion.`, externalUrl: type === "ray" ? `${base.replace(/\/$/, "")}/#/jobs/${encodeURIComponent(id)}` : ""};
}
export async function inspectJob(type: string, base: string, token: string, id: string, stop = false): Promise<JobUpdate> {
  const path = type === "ray" ? `/api/jobs/${encodeURIComponent(id)}` : `/jobs/${encodeURIComponent(id)}`;
  if(stop) await request(base, `${path}/stop`, token, "POST", {});
  const data = await request(base, path, token);
  const state = String(data.status ?? "").toUpperCase();
  const status: JobState = state === "SUCCEEDED" ? "succeeded" : ["FAILED", "FAILED_SETUP", "FAILED_PRECHECKS", "FAILED_NO_RESOURCE", "FAILED_CONTROLLER"].includes(state) ? "failed" : ["STOPPED", "CANCELLED"].includes(state) ? "cancelled" : "running";
  let output = typeof data.output === "string" ? data.output : String(data.message ?? state);
  if(type === "ray") { try { const logs = await request(base, `${path}/logs`, token); output += `\n${String(logs.logs ?? "").slice(-18000)}`; } catch { output += "\nLogs temporarily unavailable."; } }
  return {status, output:output.slice(-20000), remoteId:id, externalUrl:type === "ray" ? `${base.replace(/\/$/, "")}/#/jobs/${encodeURIComponent(id)}` : ""};
}
