"""Disposable kind Helm release tests, synthetic data only; no production context."""
import json,subprocess,pathlib,sys,tarfile,io,time
OUT=pathlib.Path('helm-evidence');OUT.mkdir(exist_ok=True); rows=[]; versions=json.load(open('scripts/helm-image-inventory.json')); shard=int(sys.argv[1]); fixture=pathlib.Path('scripts/helm-fixture.cjs').read_text()
def run(*a,input=None,timeout=360):
 p=subprocess.run(a,input=input,capture_output=True,text=True,timeout=timeout)
 if p.returncode:raise RuntimeError(' '.join(a)+'\n'+p.stdout+'\n'+p.stderr)
 return p.stdout
assert run('kubectl','config','current-context').strip()=='kind-octavo-audit'
def chart(v):
 dest=OUT/v['tag'];dest.mkdir(exist_ok=True)
 data=subprocess.check_output(['git','archive',v['tag'],'charts/octavo'])
 with tarfile.open(fileobj=io.BytesIO(data)) as t:t.extractall(dest,filter='data')
 return str(dest/'charts/octavo')
def record(kind,a,b,fn):
 t=time.time()
 try: fn();r={'status':'pass'}
 except Exception as e:r={'status':'fail','error':str(e)}
 rows.append(dict(kind=kind,source=a,target=b,seconds=round(time.time()-t,2),**r));(OUT/'results.json').write_text(json.dumps(rows,indent=2));print(rows[-1],flush=True)
def blocked(kind,a,b):
 rows.append(dict(kind=kind,source=a,target=b,status='availability-blocked'));(OUT/'results.json').write_text(json.dumps(rows,indent=2))
def load(v):
 image='ghcr.io/davano-innovation-lab/octavo@'+v['digest'];local='octavo-audit:'+v['tag'][1:]
 run('docker','exec','octavo-audit-control-plane','ctr','--namespace=k8s.io','images','pull','--platform','linux/amd64',image)
 run('docker','exec','octavo-audit-control-plane','ctr','--namespace=k8s.io','images','tag','--force',image,'docker.io/library/'+local)
 return local
ns='audit'
def reset():
 run('kubectl','delete','namespace',ns,'--ignore-not-found=true','--wait=true');run('kubectl','create','namespace',ns)
def deploy(v):
 load(v)
 run('helm','upgrade','--install','octavo',chart(v),'-n',ns,'--set','image.repository=octavo-audit','--set','image.tag='+v['tag'][1:],'--set','image.pullPolicy=Never','--set','persistence.size=1Gi','--wait','--timeout','180s')
 run('kubectl','rollout','status','deployment/octavo','-n',ns,'--timeout=180s')
def check(mode):
 run('kubectl','exec','-i','-n',ns,'deployment/octavo','--','node','-',mode,input=fixture)
 if mode=='check':
  js="""(async()=>{for(const [p,auth,want] of [['/',false,200],['/synthetic-upgrade',false,307],['/synthetic-upgrade',true,200],['/synthetic-upgrade/published',true,200],['/synthetic-upgrade/draft',true,200],['/api/files/upgrade-proof.txt',false,404]]){let r=await fetch('http://127.0.0.1:3000'+p,{redirect:'manual',headers:auth?{Cookie:'octavo_session=session'}:{}});if(r.status!==want)throw new Error(p+' expected '+want+' got '+r.status)}})().catch(e=>{console.error(e);process.exit(1)})"""
  run('kubectl','exec','-n',ns,'deployment/octavo','--','node','-e',js)
def logs(label):
 for name,args in [('pods',['get','pods','-o','wide']),('events',['get','events']),('describe',['describe','deployment/octavo']),('app',['logs','deployment/octavo','--all-containers=true'])]:
  p=subprocess.run(['kubectl','-n',ns]+args,capture_output=True,text=True);(OUT/(label+'-'+name+'.log')).write_text(p.stdout+p.stderr)
def cleanimages(vs):
 for v in vs:
  if 'digest' not in v:continue
  for cmd in [['docker','exec','octavo-audit-control-plane','crictl','rmi','octavo-audit:'+v['tag'][1:]],['docker','image','rm','-f','octavo-audit:'+v['tag'][1:],'ghcr.io/davano-innovation-lab/octavo@'+v['digest']]]:subprocess.run(cmd,capture_output=True)
def fresh(v):
 reset()
 try:deploy(v);check('seed');check('check')
 finally:logs('fresh-'+v['tag'])
def pair(a,b):
 reset()
 try:
  deploy(a);check('seed');check('check');uid=run('kubectl','get','pvc','octavo','-n',ns,'-o','jsonpath={.metadata.uid}');deploy(b);check('check');assert uid==run('kubectl','get','pvc','octavo','-n',ns,'-o','jsonpath={.metadata.uid}');run('kubectl','rollout','restart','deployment/octavo','-n',ns);run('kubectl','rollout','status','deployment/octavo','-n',ns,'--timeout=180s');check('check')
 finally:logs('pair-'+a['tag']+'-'+b['tag'])
if '--pilot' in sys.argv: versions=versions[:2]
for i,v in enumerate(versions):
 if '--pilot' not in sys.argv and i%4!=shard:continue
 def validate(v=v):
  c=chart(v);run('helm','lint',c,'--strict');render=run('helm','template','octavo',c);(OUT/(v['tag']+'-default.yaml')).write_text(render);run('kubectl','apply','--dry-run=server','-f','-',input=render)
 record('chart-server-dry-run',None,v['tag'],validate)
 if 'digest' not in v:blocked('fresh',None,v['tag']);continue
 record('fresh',None,v['tag'],lambda v=v:fresh(v));reset();cleanimages([v])
for i in range(len(versions)-1):
 if '--pilot' not in sys.argv and i%4!=shard:continue
 a,b=versions[i:i+2]
 if any('digest' not in v for v in [a,b]):blocked('adjacent-pvc-restart',a['tag'],b['tag']);continue
 record('adjacent-pvc-restart',a['tag'],b['tag'],lambda a=a,b=b:pair(a,b));reset();cleanimages([a,b])
sys.exit(any(r['status']=='fail' for r in rows))
