// Synthetic verification evidence, not a certification or deployment readiness claim.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const gates = [
  ['import', 'scripts/import-report-test.mjs'],
  ['search', 'scripts/import-search-test.mjs'],
  ['access-api', 'scripts/api-resource-access-test.mjs'],
  ['access-spaces', 'scripts/space-access-test.mjs'],
  ['restore', 'scripts/restore-test.mjs'],
  ['offline-browser', 'scripts/offline-smoke-test.mjs'],
];
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function identity(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const digest = process.env.OCTAVO_IMAGE_DIGEST || null;
  if (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('OCTAVO_IMAGE_DIGEST must be sha256:<64 lowercase hex characters>');
  return {
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
    revision: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    dirty: Boolean(status), workingTreeStatus: status,
    lockfileSha256: hash(fs.readFileSync(path.join(root, 'package-lock.json'))),
    // A caller-supplied digest identifies an image; these tests do not verify that image.
    image: digest ? { digest, source: 'caller-supplied', tested: false } : null,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: os.release(), cpus: os.cpus().length },
  };
}
export async function runGate({ id, script, root, output, timeoutMs = 300000 }) {
  const logName = `${id}.log`, logFile = path.join(output, logName);
  const fd = fs.openSync(logFile, 'wx');
  const started = Date.now();
  let timedOut = false, error = null;
  const child = spawn(process.execPath, [script], {
    cwd: root, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32',
    env: { ...process.env, OCTAVO_UI_ARTIFACT_DIR: path.join(output, `${id}-artifacts`), OCTAVO_OFFLINE_ARTIFACT_DIR: path.join(output, `${id}-artifacts`) },
  });
  const kill = (signal = 'SIGKILL') => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') error = e.message; } };
  let forceTimer;
  const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill(), 10000); }, timeoutMs);
  const result = await new Promise(resolve => {
    child.once('error', e => { error = e.message; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearTimeout(forceTimer); fs.closeSync(fd);
  return { id, command: [process.execPath, script], status: result.code === 0 && !timedOut && !error ? 'passed' : 'failed',
    startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    exitCode: result.code, signal: result.signal, timedOut, error, log: logName,
    logSha256: hash(fs.readFileSync(logFile)) };
}
export function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.posix.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Evidence cannot contain a symlink: ${name}`);
    return entry.isDirectory() ? inventory(file, name) : [{ path: name, bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) }];
  });
}
export function verify(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files)) throw new Error('Unsupported evidence manifest');
  const actual = inventory(directory).filter(file => file.path !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Evidence inventory differs: missing, extra or changed file');
  return actual.length;
}
export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--verify' && args.length === 2) {
    console.log(`Verified ${verify(path.resolve(args[1]))} evidence files against manifest (not a signature or a passing-test assertion)`); return;
  }
  if (args.some(arg => !['--source-only'].includes(arg))) throw new Error('Usage: node scripts/evidence-bundle.mjs [--source-only] | --verify <bundle-directory>');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceOnly = args.includes('--source-only');
  const source = identity(root);
  const parent = path.resolve(root, process.env.OCTAVO_EVIDENCE_DIR || 'artifacts/evidence');
  fs.mkdirSync(parent, { recursive: true });
  // Never overwrite an earlier result or erase failure evidence.
  const output = fs.mkdtempSync(path.join(parent, 'run-'));
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), source,
    scope: 'Synthetic source and standalone browser checks. No deployment, host-network isolation, hardware, security certification, or operational acceptance is established.',
    gates: [], targetEnvironment: { status: 'not_run', reason: 'No target installation, network isolation, resource measurement or recovery exercise was performed.' } };
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  for (const [id, script] of gates) {
    report.gates.push(sourceOnly && id === 'offline-browser'
      ? { id, status: 'not_run', reason: 'Source-only profile; build and browser check omitted.' }
      : await runGate({ id, script, root, output }));
    save();
  }
  report.completedAt = new Date().toISOString();
  report.status = report.gates.some(g => g.status === 'failed') ? 'failed' : report.gates.some(g => g.status === 'not_run') ? 'incomplete' : 'passed';
  save();
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', files: inventory(output) }, null, 2) + '\n');
  console.log(`Evidence ${report.status}: ${output}`);
  if (report.status === 'failed') process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
