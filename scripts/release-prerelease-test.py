"""Validate prerelease publication tags without contacting a registry."""
import os,subprocess,yaml
from pathlib import Path
workflow=yaml.safe_load(Path(".github/workflows/release.yml").read_text())
step=next(s for s in workflow["jobs"]["image"]["steps"] if s.get("name")=="Publish the multi-architecture image")
shell=step["run"]
stub="""docker() {
  if [[ "$*" == *"imagetools create"* ]]; then printf '%s\\n' "$*";
  elif [[ "$*" == *"imagetools inspect"* ]]; then printf 'Digest: sha256:synthetic\\n'; fi
}
"""
for tag,latest in [("v0.28.0-rc.1",False),("v0.28.0",True)]:
 env={**os.environ,"TAG":tag,"IMAGE":"ghcr.io/example/octavo","HUB_USER":"example","GITHUB_OUTPUT":"/dev/null"}
 result=subprocess.check_output(["bash","-c",stub+shell],env=env,text=True)
 assert (":latest" in result)==latest,result
 assert tag[1:] in result
release=workflow["jobs"]["release"]["steps"][-1]["with"]
assert "contains(inputs.tag || github.ref_name, '-')" in release["prerelease"]
assert "'false'" in release["make_latest"]
print("4 prerelease publication checks passed; no registry calls")
