#!/usr/bin/env bash
# Push kbind-provider OCM component to the local kind cluster registry.
#
# Requires the pm-helm-charts local-setup transfer pod to be running:
#   cd ../pm-helm-charts && task ocm:deploy
#
# Usage:
#   hack/push-local.sh
#   VERSION=0.1.0-dev hack/push-local.sh
#
# Overridable env vars:
#   VERSION        — component + chart version  (default: 0.0.0-dev)
#   CHART_VERSION  — chart version only         (default: $VERSION)
#   IMAGE_VERSION  — image version label        (default: $VERSION)
#   LOCAL_REGISTRY — OCI registry base path     (default: local kind registry)
#   TRANSFER_POD   — pod for final push         (default: ocm-transfer-pod)
#   OCM            — ocm binary                 (default: pm-helm-charts bin or system ocm)
set -euo pipefail

# ---- Configuration ----------------------------------------------------------

LOCAL_REGISTRY="${LOCAL_REGISTRY:-oci-registry-docker-registry.registry.svc.cluster.local/platform-mesh}"
LOCAL_OCM_REPO="oci://$LOCAL_REGISTRY"
TRANSFER_POD="${TRANSFER_POD:-ocm-transfer-pod}"
VERSION="${VERSION:-0.0.0-dev}"
CHART_VERSION="${CHART_VERSION:-$VERSION}"
IMAGE_VERSION="${IMAGE_VERSION:-$VERSION}"
HELM="${HELM:-helm}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/bin/local-push"

# Use OCM from pm-helm-charts local-setup if available, fall back to system ocm
PMHC_OCM="$PROJECT_ROOT/../pm-helm-charts/bin/ocm"
if [ -z "${OCM:-}" ]; then
    if [ -x "$PMHC_OCM" ]; then
        OCM="$PMHC_OCM"
    else
        OCM="ocm"
    fi
fi

# Look for the common chart in the sibling pm-helm-charts repo
COMMON_CHART_SRC="$PROJECT_ROOT/../pm-helm-charts/charts/common"

# ---- Helpers ----------------------------------------------------------------

COL='\033[0;36m'; COL_RES='\033[0m'
step() { echo -e "${COL}[$(date '+%H:%M:%S')] $*${COL_RES}"; }

get_kubectl_exec_flags() {
    if [ -t 0 ]; then echo "-ti"; else echo "-i"; fi
}

# ---- Step 1: Copy charts to BUILD_DIR ---------------------------------------

step "Preparing chart copies in $BUILD_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

for chart in kbind-provider-operator kbind-provider-portal; do
    cp -r "$PROJECT_ROOT/deploy/helm/$chart" "$BUILD_DIR/$chart"
done

# Swap the portal chart's 'common' OCI dependency to a local file reference if
# the pm-helm-charts repo is present alongside this one.
if [ -d "$COMMON_CHART_SRC" ]; then
    step "Swapping common chart to file reference"
    cp -r "$COMMON_CHART_SRC" "$BUILD_DIR/common"
    temp=$(mktemp)
    awk '
        /- name: common/ { in_common=1 }
        in_common && /repository:.*oci:\/\/ghcr\.io\/platform-mesh\/helm-charts/ {
            sub(/oci:\/\/ghcr\.io\/platform-mesh\/helm-charts/, "file://../common")
            in_common=0
        }
        { print }
    ' "$BUILD_DIR/kbind-provider-portal/Chart.yaml" > "$temp"
    mv "$temp" "$BUILD_DIR/kbind-provider-portal/Chart.yaml"
else
    step "pm-helm-charts not found at $COMMON_CHART_SRC — pulling common chart from ghcr.io"
fi

# ---- Step 2: Stamp Chart.yaml + resolve dependencies -----------------------

step "Stamping Chart.yaml version=$CHART_VERSION appVersion=$IMAGE_VERSION"
for chart in kbind-provider-operator kbind-provider-portal; do
    yq -i '.version = "'"$CHART_VERSION"'" | .appVersion = "'"$IMAGE_VERSION"'"' \
        "$BUILD_DIR/$chart/Chart.yaml"
done

step "Resolving chart dependencies"
$HELM dependency update "$BUILD_DIR/kbind-provider-operator"
$HELM dependency update "$BUILD_DIR/kbind-provider-portal"

# ---- Step 3: Build OCM CTF locally -----------------------------------------
# input: type: helm reads charts from disk — no registry access needed here.
# The resulting CTF is then copied into the transfer pod for the actual push.

step "Copying local constructor to $BUILD_DIR"
cp "$PROJECT_ROOT/constructor/component-constructor-local.yaml" \
    "$BUILD_DIR/component-constructor-local.yaml"

step "Building OCM transport archive (local)"
OCM_CTF="$BUILD_DIR/transport.ctf"
rm -rf "$OCM_CTF"
$OCM add components -c --templater=go \
    --file "$OCM_CTF" \
    "$BUILD_DIR/component-constructor-local.yaml" -- \
    "VERSION=$VERSION" \
    "CHART_VERSION=$CHART_VERSION"

# ---- Step 4: Push OCM component via transfer pod ---------------------------

step "Copying transport archive to transfer pod"
kubectl exec $(get_kubectl_exec_flags) "$TRANSFER_POD" -- mkdir -p .ocm
kubectl cp "$OCM_CTF" -n default "$TRANSFER_POD:.ocm/transport.ctf"

step "Pushing OCM component to local registry"
kubectl exec $(get_kubectl_exec_flags) "$TRANSFER_POD" -- \
    ocm transfer ctf --overwrite ".ocm/transport.ctf" "$LOCAL_OCM_REPO"

echo ""
step "Done: github.com/platform-mesh/kube-bind-provider:$VERSION → $LOCAL_REGISTRY"
