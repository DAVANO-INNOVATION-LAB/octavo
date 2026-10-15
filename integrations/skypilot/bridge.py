"""Optional SkyPilot SDK bridge. Runs separately from Octavo; no cloud credentials enter Octavo."""
import base64
import concurrent.futures
from contextlib import contextmanager
import hmac
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import zipfile

TOKEN = os.environ.get('OCTAVO_JOB_TOKEN', '')
ROOT = Path(os.environ.get('OCTAVO_JOB_DATA', './job-data')).resolve()
SOURCE_ROOT = Path(os.environ.get('OCTAVO_JOB_SOURCE_ROOT', './job-sources')).resolve()
GIT_HOSTS = set(filter(None, os.environ.get('OCTAVO_JOB_GIT_HOSTS', '').split(',')))
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4)
LOCK = threading.Lock()
MAX_BODY = 1_000_000

# Test/deployment policy: optionally restrict job resource selection.
ALLOWED_INFRA = os.environ.get('OCTAVO_JOB_ALLOWED_INFRA', '')

@contextmanager
def database():
    ROOT.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(ROOT / 'jobs.sqlite', timeout=10)
    db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, spec TEXT, state TEXT, ids TEXT, output TEXT, cancel INTEGER DEFAULT 0)')
    try:
        with db:
            yield db
    finally:
        db.close()

def row(job):
    with database() as db:
        return db.execute('SELECT id,spec,state,ids,output,cancel FROM jobs WHERE id=?', (job,)).fetchone()

def update(job, state, ids=None, output=''):
    with database() as db:
        db.execute('UPDATE jobs SET state=?, ids=COALESCE(?,ids), output=? WHERE id=?', (state, json.dumps(ids) if ids is not None else None, output[-18000:], job))

def prepare_source(source, job):
    if not isinstance(source, dict):
        raise ValueError('source must be an object')
    kind = source.get('type')
    target = ROOT / job / 'source'
    if kind == 'local':
        path = (SOURCE_ROOT / str(source.get('path', ''))).resolve()
        if not path.is_relative_to(SOURCE_ROOT) or not path.is_dir():
            raise ValueError('Local source must be a directory beneath the configured source root')
        # A symlink in a workdir could publish files outside that root.
        if any(p.is_symlink() for p in path.rglob('*')):
            raise ValueError('Local sources cannot contain symlinks')
        return str(path)
    if kind == 'git':
        url, commit = str(source.get('url', '')), str(source.get('commit', ''))
        parsed = urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname not in GIT_HOSTS or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Git URL must use HTTPS on an allowed host without credentials')
        if not re.fullmatch(r'[a-fA-F0-9]{40}|[a-fA-F0-9]{64}', commit):
            raise ValueError('Pin the repository to a full commit hash')
        target.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1'}
        for args in [['init', str(target)], ['-C', str(target), 'fetch', '--depth=1', url, commit], ['-C', str(target), 'checkout', '--detach', 'FETCH_HEAD']]:
            subprocess.run(['git', '-c', 'protocol.file.allow=never', '-c', 'http.followRedirects=false', *args], env=env, check=True, capture_output=True, timeout=120)
        if any(p.is_symlink() for p in target.rglob('*')):
            raise ValueError('Git sources cannot contain symlinks')
        return str(target)
    if kind == 'archive':
        blob = base64.b64decode(source.get('base64', ''), validate=True)
        target.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            files = archive.infolist()
            if len(files) > 1000 or sum(f.file_size for f in files) > 20_000_000:
                raise ValueError('Archive exceeds 1,000 entries or 20 MB unpacked')
            for entry in files:
                dest = (target / entry.filename).resolve()
                if not dest.is_relative_to(target) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unsafe archive entry')
            archive.extractall(target)
        return str(target)
    raise ValueError('Source type must be local, git or archive')

def launch(job, spec):
    try:
        import sky
        task = dict(spec['task'])
        if ALLOWED_INFRA:
            resources = task.setdefault('resources', {})
            if not isinstance(resources, dict) or resources.get('cloud', ALLOWED_INFRA) != ALLOWED_INFRA or resources.get('infra', ALLOWED_INFRA).split('/')[0] != ALLOWED_INFRA:
                raise ValueError('Job infrastructure is restricted by the operator')
            resources['cloud'] = ALLOWED_INFRA
        # File access goes through the source policy, never arbitrary mounts.
        if any(k in task for k in ('workdir', 'file_mounts', 'service')):
            raise ValueError('Use source for files; service deployment is not supported')
        if spec.get('source'):
            task['workdir'] = prepare_source(spec['source'], job)
        if row(job)[5]:
            update(job, 'CANCELLED', output='Cancelled before submission')
            return
        update(job, 'SUBMITTING', output='Waiting for SkyPilot to accept the managed job')
        request = sky.jobs.launch(sky.Task.from_yaml_config(task), name=job)
        # Retain the request id in diagnostics in case the bridge stops here.
        update(job, 'SUBMITTING', output=f'SkyPilot request {request}; do not resubmit while it is pending')
        result = sky.get(request)
        ids = result[0]
        if isinstance(ids, int):
            ids = [ids]
        if not ids or not all(isinstance(i, int) for i in ids):
            raise ValueError('SkyPilot returned no managed job IDs')
        update(job, 'RUNNING', ids, 'Accepted by SkyPilot')
        if row(job)[5]:
            sky.get(sky.jobs.cancel(job_ids=ids))
    except Exception as error:
        # Do not serialize SDK exception text: it may contain credentials.
        update(job, 'FAILED', output=f'SkyPilot submission failed ({type(error).__name__}). Check the server logs/configuration before retrying.')

def inspect(job):
    record = row(job)
    if not record:
        return None
    if not record[3]:
        return {'id': job, 'status': record[2], 'output': record[4]}
    import sky
    ids = json.loads(record[3])
    results = sky.get(sky.jobs.queue(refresh=False, job_ids=ids))
    states = [str(r['status'].value if hasattr(r['status'], 'value') else r['status']).upper() for r in results]
    status = 'SUCCEEDED' if states and all(s == 'SUCCEEDED' for s in states) else 'FAILED' if any(s.startswith('FAILED') for s in states) else 'CANCELLED' if states and all(s == 'CANCELLED' for s in states) else 'RUNNING'
    output = f'SkyPilot jobs {ids}: {", ".join(states) or "pending"}'
    logs = io.StringIO()
    try:
        if status != 'RUNNING':
            sky.jobs.tail_logs(job_id=ids[0], follow=False, tail=100, output_stream=logs)
        output += '\n' + logs.getvalue()[-16000:]
    except Exception:
        output += '\nLogs temporarily unavailable.'
    update(job, status, output=output)
    return {'id': job, 'status': status, 'output': output}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return bool(TOKEN) and hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def do_GET(self):
        if not self.authorized(): return self.reply(401, {'error': 'unauthorized'})
        if self.path == '/health': return self.reply(200, {'ok': True})
        match = re.fullmatch(r'/jobs/([\w.-]{1,200})', self.path)
        if not match: return self.reply(404, {'error': 'not found'})
        try:
            result = inspect(match[1])
            return self.reply(200 if result else 404, result or {'error': 'not found'})
        except Exception:
            return self.reply(502, {'error': 'SkyPilot unavailable; job state retained'})

    def do_POST(self):
        if not self.authorized(): return self.reply(401, {'error': 'unauthorized'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > MAX_BODY: return self.reply(413, {'error': 'body too large'})
            if self.path == '/jobs':
                spec = json.loads(self.rfile.read(size))
                job = spec.get('submission_id', '')
                if not re.fullmatch(r'octavo-[\w-]{1,180}', job) or not isinstance(spec.get('task'), dict) or not isinstance(spec['task'].get('run'), str):
                    return self.reply(400, {'error': 'invalid job specification'})
                with LOCK, database() as db:
                    existing = db.execute('SELECT spec FROM jobs WHERE id=?', (job,)).fetchone()
                    serialized = json.dumps(spec, sort_keys=True)
                    if existing:
                        return self.reply(200 if existing[0] == serialized else 409, {'id': job})
                    pending = db.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('QUEUED','SUBMITTING','RUNNING')").fetchone()[0]
                    if pending >= 16: return self.reply(429, {'error': 'job limit reached'})
                    db.execute('INSERT INTO jobs(id,spec,state,output) VALUES(?,?,?,?)', (job, serialized, 'QUEUED', 'Queued for SkyPilot submission'))
                POOL.submit(launch, job, spec)
                return self.reply(202, {'id': job})
            match = re.fullmatch(r'/jobs/([\w.-]{1,200})/stop', self.path)
            if not match or not row(match[1]): return self.reply(404, {'error': 'not found'})
            with database() as db: db.execute('UPDATE jobs SET cancel=1 WHERE id=?', (match[1],))
            record = row(match[1])
            if record[3]:
                import sky
                sky.get(sky.jobs.cancel(job_ids=json.loads(record[3])))
            return self.reply(200, {'requested': True})
        except (ValueError, TypeError, KeyError):
            return self.reply(400, {'error': 'invalid request'})
        except Exception:
            return self.reply(502, {'error': 'SkyPilot request failed; inspect current state before retrying'})

if __name__ == '__main__':
    if len(TOKEN) < 32: raise SystemExit('Set OCTAVO_JOB_TOKEN to a random value of at least 32 characters')
    # Restarted submissions are intentionally not replayed: duplicate jobs can incur cost.
    ThreadingHTTPServer((os.environ.get('OCTAVO_JOB_BIND', '127.0.0.1'), int(os.environ.get('OCTAVO_JOB_PORT', '8787'))), Handler).serve_forever()
