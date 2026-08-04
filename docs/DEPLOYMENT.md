# Local Deployment with Images

Build the provider container images, load them into a local kind cluster, and install via Helm. Use this mode to validate the full deployment path end-to-end.

For iterating on code without rebuilding images, see [DEVELOPMENT.md](DEVELOPMENT.md).

This guide assumes the prerequisites and provider workspace bootstrap from [DEVELOPMENT.md](DEVELOPMENT.md) (steps 1–2) are already done — the backend kubeconfig (`backend.kubeconfig`) must exist before the Helm install.

## Container Images

### Build and Load into Kind (typical workflow)

```bash
export IMAGE_TAG=platform-mesh
make images kind-load-all IMAGE_TAG=$IMAGE_TAG
```

### Individual Targets

```bash
# Build images
make init-image-build          # init container
make portal-image-build        # portal UI
make images                    # both

# Load into kind
make kind-load-init
make kind-load-portal
make kind-load-all

# Push to registry
make images-push
make init-image-push
make portal-image-push
```

### Override Variables

```bash
make images IMAGE_TAG=v0.1.0
make images IMAGE_REGISTRY=my-registry.io/org
make kind-load-all KIND_CLUSTER=my-cluster
```

### Run Portal Container Locally

```bash
make portal-run                # foreground (http://localhost:4300)
make portal-run-detached       # background
make portal-stop               # stop background container
```

## Helm Deployment

### Deploy Operator

```bash
# Create the kubeconfig secret
kubectl create namespace kube-bind-system
kubectl delete secret kube-bind-provider-kubeconfig -n kube-bind-system --ignore-not-found
kubectl create secret generic kube-bind-provider-kubeconfig \
  --from-file=kubeconfig=backend.kubeconfig \
  -n kube-bind-system

helm upgrade --install kbind-provider-operator \
  deploy/helm/kbind-provider-operator \
  -n kube-bind-system --create-namespace \
  --set image.tag=$IMAGE_TAG
```

### Deploy Portal

```bash
# Update chart dependencies
make helm-deps

# Install portal (assumes IMAGE_TAG was exported above).
# httpRoute + middleware are off by default; enable them so the portal is reachable
# via the platform-mesh gateway. referenceGrant is gated on httpRoute.enabled and
# defaults to true.
helm upgrade --install kbind-provider-portal \
  deploy/helm/kbind-provider-portal \
  -n kube-bind-system \
  --set image.tag=$IMAGE_TAG \
  --set httpRoute.enabled=true \
  --set middleware.enabled=true
```
