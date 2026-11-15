"""Render-only chart checks. Requires Helm and PyYAML; no cluster mutations."""
import os
import subprocess
import tempfile
from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[1]
helm = os.environ.get("HELM", "helm")

def render(values=None):
    with tempfile.TemporaryDirectory() as directory:
        cmd = [helm, "template", "secret-test", str(root / "charts/octavo")]
        if values is not None:
            file = Path(directory) / "values.yaml"
            file.write_text(yaml.safe_dump(values))
            cmd += ["-f", str(file)]
        docs = list(yaml.safe_load_all(subprocess.check_output(cmd, text=True)))
        return next(d for d in docs if d["kind"] == "Deployment")

default = render()["spec"]["template"]
c = default["spec"]["containers"][0]
assert c["env"] == [{"name": "OCTAVO_DATA_DIR", "value": "/data"}]
assert "envFrom" not in c and "annotations" not in default["metadata"]
assert "serviceAccountName" not in default["spec"]
assert len(default["spec"]["volumes"]) == 3
assert len(c["volumeMounts"]) == 3

values = {
    "podAnnotations": {"vault.hashicorp.com/agent-inject": "true"},
    "serviceAccountName": "octavo-vault",
    "extraEnv": [{"name": "OCTAVO_OIDC_CLIENT_SECRET_FILE", "value": "/run/oidc/client-secret"}],
    "envFrom": [{"secretRef": {"name": "octavo-non-file-config"}}],
    "extraVolumes": [{"name": "oidc", "secret": {"secretName": "octavo-oidc", "defaultMode": 288}}],
    "extraVolumeMounts": [{"name": "oidc", "mountPath": "/run/oidc", "readOnly": True}],
}
pod = render(values)["spec"]["template"]
c = pod["spec"]["containers"][0]
assert pod["metadata"]["annotations"] == values["podAnnotations"]
assert pod["spec"]["serviceAccountName"] == "octavo-vault"
assert c["env"][1:] == values["extraEnv"] and c["envFrom"] == values["envFrom"]
assert c["volumeMounts"][-1:] == values["extraVolumeMounts"]
assert pod["spec"]["volumes"][-1:] == values["extraVolumes"]
assert pod["spec"]["securityContext"] == default["spec"]["securityContext"]
assert c["securityContext"] == default["spec"]["containers"][0]["securityContext"]
print("12 Helm secret-hook render checks passed; no cluster execution claimed")
