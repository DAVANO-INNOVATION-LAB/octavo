"""Reconstruct missing artifacts from pinned source. Never publish reconstructed images."""
import hashlib,json,pathlib,subprocess,tempfile,time,tarfile
root=pathlib.Path.cwd();out=root/'container-evidence';out.mkdir(exist_ok=True)
p=root/'scripts/released-image-inventory.json';versions=json.loads(p.read_text());builds=[]
for v in versions:
 if 'digest' in v:continue
 started=time.time();entry={'tag':v['tag'],'source_sha':v['sha'],'artifact_origin':'exact-source-rebuild-not-original-release','historical_reproducibility':'Not claimed: upstream base images and apk repositories are mutable'}
 try:
  with tempfile.TemporaryDirectory(prefix='octavo-rebuild-') as tmp:
   archive=subprocess.check_output(['git','archive',v['sha']]);archive_path=pathlib.Path(tmp)/'source.tar';archive_path.write_bytes(archive)
   with tarfile.open(archive_path) as tar:tar.extractall(tmp,filter='data')
   archive_path.unlink()
   for file in ['Dockerfile','package-lock.json']:
    entry[file+'_sha256']=hashlib.sha256((pathlib.Path(tmp)/file).read_bytes()).hexdigest()
   label='octavo-rebuilt:'+v['tag']
   with (out/('build-'+v['tag']+'.log')).open('w') as log:
    command=['docker','build','--progress=plain','--build-arg','VERSION='+v['tag'],'--build-arg','REVISION='+v['sha'],'-t',label,tmp]
    original=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
   if original.returncode:
    original_log=(out/('build-'+v['tag']+'.log')).read_text()
    if v['tag'] not in ['v0.24.2','v0.25.0','v0.25.1'] or "Cannot find module '/app/scripts/stamp-version.mjs'" not in original_log:
     raise RuntimeError('Exact-source build failed; no approved minimal-context workaround applies')
    entry['exact_source_build_status']='fail'
    entry['exact_source_error']='Docker ignore excludes stamp-version.mjs required by prebuild'
    ignore=pathlib.Path(tmp)/'.dockerignore'
    ignore.write_text(ignore.read_text()+'\n!scripts/stamp-version.mjs\n')
    entry['artifact_origin']='patched-context-rebuild-NOT-original-NOT-exact-source'
    entry['workaround']='Append !scripts/stamp-version.mjs to .dockerignore only; source files, Dockerfile and package-lock unchanged'
    entry['patched_dockerignore_sha256']=hashlib.sha256(ignore.read_bytes()).hexdigest()
    with (out/('workaround-build-'+v['tag']+'.log')).open('w') as log:
     subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=1200,check=True)
   else:entry['exact_source_build_status']='pass'
   v['artifact_origin']=entry['artifact_origin']
   entry['image_inspect']=json.loads(subprocess.check_output(['docker','image','inspect',label]))[0]
   entry['status']='pass';v['rebuilt_image']=label
 except Exception as e:entry.update(status='fail',error=str(e))
 entry['seconds']=round(time.time()-started,2);builds.append(entry)
 (out/'rebuild-provenance.json').write_text(json.dumps(builds,indent=2));p.write_text(json.dumps(versions,indent=2));print({k:v for k,v in entry.items() if k!='image_inspect'},flush=True)
