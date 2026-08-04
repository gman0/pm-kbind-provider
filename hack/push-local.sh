#!/usr/bin/env bash
# Push kbind-provider helm charts and OCM component to the local kind cluster registry.
#
# Requires the pm-helm-charts local-setup transfer pod to be running:
#   cd ../pm-helm-charts && task ocm:deploy
#
# Usage:
#   hack/push-local.sh
#   VERSION=0.1.0-dev hack/push-local.sh
#
# The following env vars can be overridden:
#   VERSION         — component + chart version  (default: 0.0.0-dev)
#   CHART_VERSION   — chart version only         (default: $VERSION)
#   IMAGE_VERSION   — image version label        (default: $VERSION)
#   LOCAL_REGISTRY  — OCI registry base path     (default: local kind registry)
#   TRANSFER_POD    — pod name for kubectl exec  (default: ocm-transfer-pod)
set -euo pipefail

# ---- Configuration ----------------------------------------------------------

LOCAL_REGISTRY="${LOCAL_REGISTRY:-oci-registry-docker-registry.registry.svc.cluster.local/platform-mesh}"
TRANSFER_POD="${TRANSFER_POD:-ocm-transfer-pod}"
VERSION="${VERSION:-0.0.0-dev}"
CHART_VERSION="${CHART_VERSION:-$VERSION}"
IMAGE_VERSION="${IMAGE_VERSION:-$VERSION}"
HELM="${HELM:-helm}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/bin/local-push"
PRERELEASE_DIR="$BUILD_DIR/prerelease"

LOCAL_HELM_REPO="$LOCAL_REGISTRY/kube-bind-provider/charts"
LOCAL_OCM_REPO="oci://$LOCAL_REGISTRY"

# Look for the common chart in the sibling pm-helm-charts repo
COMMON_CHART_SRC="$PROJECT_ROOT/../pm-helm-charts/charts/common"

# ---- Helpers ----------------------------------------------------------------

COL='\033[0;36m'; COL_RES='\033[0m'
step() { echo -e "${COL}[$(date '+%H:%M:%S')] $*${COL_RES}"; }

# Must be called at point of use (not at script init) — background jobs lose TTY
get_kubectl_exec_flags() {
    if [ -t 0 ]; then echo "-ti"; else echo "-i"; fi
}

# ---- Step 1: Copy charts to prerelease dir ----------------------------------

step "Preparing prerelease chart copies"
rm -rf "$PRERELEASE_DIR"
mkdir -p "$PRERELEASE_DIR" "$BUILD_DIR/charts"

for chart in kbind-provider-operator kbind-provider-portal; do
    cp -r "$PROJECT_ROOT/deploy/helm/$chart" "$PRERELEASE_DIR/$chart"
done

# Swap the portal chart's 'common' OCI dependency to a local file reference if
# the pm-helm-charts repo is present alongside this one.
PORTAL_CHART="$PRERELEASE_DIR/kbind-provider-portal"
if [ -d "$COMMON_CHART_SRC" ]; then
    step "Swapping common chart to file reference"
    cp -r "$COMMON_CHART_SRC" "$PRERELEASE_DIR/common"
    temp=$(mktemp)
    awk '
        /- name: common/ { in_common=1 }
        in_common && /repository:.*oci:\/\/ghcr\.io\/platform-mesh\/helm-charts/ {
            sub(/oci:\/\/ghcr\.io\/platform-mesh\/helm-charts/, "file://../common")
            in_common=0
        }
        { print }
    ' "$PORTAL_CHART/Chart.yaml" > "$temp"
    mv "$temp" "$PORTAL_CHART/Chart.yaml"
else
    step "pm-helm-charts not found at $COMMON_CHART_SRC — pulling common chart from ghcr.io"
fi

# ---- Step 2: Resolve dependencies + package ---------------------------------

for chart in kbind-provider-operator kbind-provider-portal; do
    step "helm dependency update: $chart"
    $HELM dependency update "$PRERELEASE_DIR/$chart"

    step "helm package: $chart @ $CHART_VERSION"
    $HELM package "$PRERELEASE_DIR/$chart" \
        --version "$CHART_VERSION" \
        --app-version "$IMAGE_VERSION" \
        --destination "$BUILD_DIR/charts"
done

# ---- Step 3: Push charts via transfer pod -----------------------------------

for chart in kbind-provider-operator kbind-provider-portal; do
    tarball="$BUILD_DIR/charts/$chart-$CHART_VERSION.tgz"
    step "Pushing $chart to local registry"
    kubectl cp "$tarball" -n default "$TRANSFER_POD:$(basename "$tarball")"
    kubectl exec $(get_kubectl_exec_flags) "$TRANSFER_POD" -- \
        helm push "$(basename "$tarball")" "oci://$LOCAL_HELM_REPO"
done

# ---- Step 4: Build OCM component inside transfer pod ------------------------

step "Copying local constructor to transfer pod"
kubectl exec $(get_kubectl_exec_flags) "$TRANSFER_POD" -- mkdir -p .ocm
kubectl cp "$PROJECT_ROOT/constructor/component-constructor-local.yaml" \
    -n default "$TRANSFER_POD:.ocm/component-constructor-local.yaml"

step "Building OCM transport archive"
kubectl exec $(get_kubectl_exec_flags) "$TRANSFER_POD" -- \
    ocm add components -c --templater=go \
    --file ".ocm/transport.ctf" \
    ".ocm/component-constructor-local.yaml" -- \
    "VERSION=$VERSION" \
    "CHART_VERSION=$CHART_VERSION" \
    "LOCAL_HELM_REPO=$LOCAL_HELM_REPO"

# ---- Step 5: Push OCM component to local registry ---------------------------

step "Pushing OCM component to local registry"
kubectl exec $(get_kubectl_exec_flags) "$TRANSFER_POD" -- \
    ocm transfer ctf --overwrite ".ocm/transport.ctf" "$LOCAL_OCM_REPO"

echo ""
step "Done: github.com/platform-mesh/kube-bind-provider:$VERSION → $LOCAL_REGISTRY"
