#!/bin/sh
# Scan a locally built octavo image with the local Triton instance and save
# the report for release-over-release comparison.
#   TRITON_URL=http://127.0.0.1:8971 TRITON_TOKEN=trt_... \
#     scripts/triton-scan.sh octavo:0.4.0
set -e
IMAGE="${1:?usage: triton-scan.sh <image:tag>}"
TRITON_URL="${TRITON_URL:-http://127.0.0.1:8971}"
: "${TRITON_TOKEN:?set TRITON_TOKEN}"
REG="${LOCAL_REGISTRY:-localhost:5001}"

docker tag "$IMAGE" "$REG/$IMAGE"
docker push -q "$REG/$IMAGE"
REF="host.docker.internal:${REG#*:}/$IMAGE"
SID=$(curl -s -X POST -H "Authorization: Bearer $TRITON_TOKEN" -H "Content-Type: application/json" \
  -d "{\"image_ref\":\"$REF\"}" "$TRITON_URL/api/scans" | sed -n 's/.*"scan_id":"\([^"]*\)".*/\1/p')
echo "scan $SID started for $REF"
while :; do
  STATUS=$(curl -s -H "Authorization: Bearer $TRITON_TOKEN" "$TRITON_URL/api/scans/$SID" \
    | sed -n 's/.*"status": *"\([^"]*\)".*/\1/p' | head -1)
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "failed" ] && { echo "scan failed"; exit 1; }
  sleep 10
done
OUT="docs/security/triton-$(echo "$IMAGE" | tr '/:' '--').json"
curl -s -H "Authorization: Bearer $TRITON_TOKEN" "$TRITON_URL/api/scans/$SID" > "$OUT"
echo "saved $OUT"
