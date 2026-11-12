"""Published-image smoke/upgrade evidence. Synthetic volumes only; no production."""
import json, os, pathlib, shutil, subprocess, sys, time, urllib.request, urllib.error
ROOT=pathlib.Path.cwd(); OUT=ROOT/'container-evidence'; OUT.mkdir(exist_ok=True)
versions=json.load(open('scripts/released-image-inventory.json')); results=[]; name='octavo-upgrade-test'; data=OUT/'data'
def run(*args): return subprocess.check_output(args,stderr=subprocess.STDOUT,text=True,timeout=180)
def stop(): subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def request(path,auth=False):
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*a): return None
 req=urllib.request.Request('http://127.0.0.1:18549'+path,headers={'Cookie':'octavo_session=session'} if auth else {})
 try:
  with urllib.request.build_opener(NoRedirect).open(req,timeout=20) as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def image(v):
 if 'digest' not in v:raise RuntimeError('Published image unavailable: '+str(v))
 return 'ghcr.io/davano-innovation-lab/octavo@'+v['digest']
def start(v):
 stop();data.mkdir(exist_ok=True);os.chmod(data,0o777)
 run('docker','run','-d','--name',name,'--cpus','2','--memory','2g','-p','127.0.0.1:18549:3000','-e','OCTAVO_COLLAB=0','-v',str(data)+':/data',image(v))
 for _ in range(90):
  try:
   status=request('/login')[0]
   if status==200 or (status==307 and request('/setup')[0]==200):return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Readiness timeout: '+run('docker','logs',name)[-6000:])
def fixture(mode):
 run('docker','cp','scripts/upgrade-fixture.cjs',name+':/tmp/upgrade-fixture.cjs')
 run('docker','exec',name,'node','/tmp/upgrade-fixture.cjs',mode)
def smoke():
 for path,auth,expected in [('/',False,200),('/synthetic-upgrade',False,307),('/synthetic-upgrade',True,200),('/synthetic-upgrade/published',True,200),('/synthetic-upgrade/draft',True,200),('/api/files/upgrade-proof.txt',False,404)]:
  actual,body=request(path,auth)
  assert actual==expected,(path,auth,expected,actual,body[:300])
 fixture('check')
def save_log(label):
 p=subprocess.run(['docker','logs',name],capture_output=True,text=True)
 (OUT/(label+'.log')).write_text(p.stdout+p.stderr)
def reset():
 stop();data.mkdir(exist_ok=True);os.chmod(data,0o777)
 run('docker','run','--rm','--user','0','-v',str(data)+':/data','--entrypoint','node',image(versions[0]),'-e',"const f=require('fs');for(const p of f.readdirSync('/data'))f.rmSync('/data/'+p,{recursive:true,force:true})")
def record(kind,fr,to,fn):
 t=time.time()
 try:fn();result={'status':'pass'}
 except Exception as e:result={'status':'fail','error':str(e),'output':getattr(e,'output',None)}
 finally:
  save_log(kind+'-'+str(fr)+'-'+to);stop()
  # Bound disk consumption: preserve baseline used by reset, remove other test images.
  for v in versions[1:]:
   if 'digest' in v:subprocess.run(['docker','image','rm',image(v)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 results.append(dict(kind=kind,source=fr,target=to,seconds=round(time.time()-t,2),**result));(OUT/'results.json').write_text(json.dumps(results,indent=2));print(results[-1],flush=True)
def pair(i):
 a,b=versions[i],versions[i+1];reset();start(a);fixture('seed');smoke();stop()
 # Offline backup preserves SQLite WAL and uploads; copying by uid 1000 is safe.
 run('docker','run','--rm','--user','0','-v',str(data)+':/data','--entrypoint','node',image(a),'-e',"const f=require('fs');f.cpSync('/data','/tmp/backup',{recursive:true});f.mkdirSync('/data/backup');for(const p of f.readdirSync('/tmp/backup'))f.cpSync('/tmp/backup/'+p,'/data/backup/'+p,{recursive:true})")
 start(b);smoke();start(b);smoke();stop()
 run('docker','run','--rm','--user','0','-v',str(data)+':/data','--entrypoint','node',image(a),'-e',"const f=require('fs');for(const p of f.readdirSync('/data'))if(p!=='backup')f.rmSync('/data/'+p,{recursive:true,force:true});for(const p of f.readdirSync('/data/backup'))f.cpSync('/data/backup/'+p,'/data/'+p,{recursive:true});f.rmSync('/data/backup',{recursive:true});function own(p){f.chownSync(p,1000,1000);if(f.statSync(p).isDirectory())for(const n of f.readdirSync(p))own(p+'/'+n)}for(const p of f.readdirSync('/data'))own('/data/'+p)")
 start(a);smoke()
def fresh(v):reset();start(v);fixture('seed');smoke()
mode=sys.argv[1]
if mode=='chain':
 reset()
 for i,v in enumerate(versions):
  def step(v=v,i=i):
   start(v)
   if i==0:fixture('seed')
   smoke()
  record('chain',versions[i-1]['tag'] if i else None,v['tag'],step)
  if results[-1]['status']=='fail':break
else:
 shard=int(mode)
 for i,v in enumerate(versions):
  if i%7==shard:record('fresh',None,v['tag'],lambda v=v:fresh(v))
 for i in range(len(versions)-1):
  if i%7==shard:record('adjacent-restart-restore',versions[i]['tag'],versions[i+1]['tag'],lambda i=i:pair(i))
stop();sys.exit(any(r['status']=='fail' for r in results))
