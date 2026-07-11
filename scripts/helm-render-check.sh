#!/usr/bin/env bash
# Helm render + validation check for the mail-platform chart.
#
# Closes the long-standing "Helm rendering: not executed (Helm unavailable)"
# certification gap by making the render reproducible. It:
#   1. lints the chart,
#   2. renders it with default values,
#   3. renders it again with a production-like overlay,
#   4. parses every rendered document to confirm it is valid Kubernetes YAML,
#   5. asserts the expected workload kinds are present.
#
# Requires: helm 3.x, python3 (for YAML parsing). Exits non-zero on any failure
# so it can gate CI.
#
# Usage:
#   ./scripts/helm-render-check.sh
#   CHART_DIR=infra/helm/mail-platform ./scripts/helm-render-check.sh

set -euo pipefail

CHART_DIR="${CHART_DIR:-infra/helm/mail-platform}"
RELEASE="${RELEASE:-mp}"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

command -v helm >/dev/null 2>&1 || { echo "FAIL: helm not installed"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 not installed"; exit 2; }

echo "==> helm lint"
helm lint "$CHART_DIR"

render_and_validate() {
  local label="$1"; shift
  local out="$OUT_DIR/${label}.yaml"
  echo "==> helm template ($label)"
  helm template "$RELEASE" "$CHART_DIR" "$@" >"$out"
  python3 - "$out" "$label" <<'PY'
import sys, yaml
path, label = sys.argv[1], sys.argv[2]
docs = [d for d in yaml.safe_load_all(open(path)) if d]
kinds = {}
for d in docs:
    kinds[d.get("kind", "?")] = kinds.get(d.get("kind", "?"), 0) + 1
# Every workload the platform needs must render.
required = ["Deployment", "Service", "ConfigMap", "Job"]
missing = [k for k in required if k not in kinds]
if missing:
    print(f"FAIL [{label}]: missing required kinds: {missing}")
    sys.exit(1)
# Every rendered doc must carry apiVersion + metadata.name (well-formed object).
for d in docs:
    if not d.get("apiVersion") or not (d.get("metadata") or {}).get("name"):
        print(f"FAIL [{label}]: a rendered object is missing apiVersion/metadata.name: kind={d.get('kind')}")
        sys.exit(1)
print(f"OK [{label}]: {len(docs)} valid manifests — " + ", ".join(f"{kinds[k]}x {k}" for k in sorted(kinds)))
PY
}

render_and_validate "default"

# Production-like overlay: real image tags, HA replica counts, ingress on. These
# are rendering-only overrides (no secrets) so the check stays reproducible.
render_and_validate "production" \
  --set global.image.tag=release \
  --set api.replicaCount=3 \
  --set worker.replicaCount=3 \
  --set tracker.replicaCount=2 \
  --set ingress.enabled=true

echo "==> Helm render check PASSED"
