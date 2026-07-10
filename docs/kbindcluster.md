# KbindCluster API Design

## Overview

`KbindCluster` is a cluster-scoped CRD on the **provider** cluster (a kcp workspace
managed by pm-kbind-provider). It records a single generated kbind bundle — from the
moment a user selects APIs in the portal and clicks Generate, through to a live consumer
that is actively heartbeating.

A consumer workspace can have **multiple** KbindCluster records (one per bundle generated,
e.g. different API subsets for different teams).

---

## Spec

```go
type KbindClusterSpec struct {
    // apis is the set of exported APIs included in this bundle.
    // An empty (or absent) list means "all APIs"; the generated bundle sets
    // Connection.autoBind=true and omits the ClusterBinding.
    // A non-empty list generates a ClusterBinding covering exactly these APIs.
    APIs []corev1alpha1.APIRef `json:"apis,omitempty"`
}
```

### Bundle shape by `apis`

| `spec.apis`   | Generated bundle contains                                         |
|---------------|-------------------------------------------------------------------|
| empty / nil   | Secret + Connection (autoBind=true) — no ClusterBinding           |
| non-empty     | Secret + Connection (autoBind=false) + ClusterBinding with listed APIs |

---

## Status

```go
type KbindClusterStatus struct {
    // localClusterUID is the consumer cluster's kube-system namespace UID —
    // the same value Connection.status.localClusterUID carries on the consumer.
    // Set by the portal at bundle-generation time (the portal has access to the
    // consumer workspace API server and reads the UID via the kube-system namespace).
    // Immutable once set.
    LocalClusterUID string `json:"localClusterUID,omitempty"`

    // leaseRef points at the coordination.k8s.io/Lease maintained by the
    // konnector on this provider cluster as a heartbeat.
    // Set by the KbindClusterReconciler once a Lease whose
    // spec.holderIdentity matches localClusterUID appears.
    LeaseRef *LocalLeaseRef `json:"leaseRef,omitempty"`

    // conditions: Connected, Ready.
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// LocalLeaseRef is a namespace+name pointer to a coordination.k8s.io/Lease
// on this (provider) cluster.
type LocalLeaseRef struct {
    Namespace string `json:"namespace"`
    Name      string `json:"name"`
}
```

### Conditions

| Type        | Meaning                                                                         |
|-------------|---------------------------------------------------------------------------------|
| `Connected` | A Lease with `spec.holderIdentity == localClusterUID` exists and `renewTime` is within 2× `leaseDurationSeconds` (currently 120 s). |
| `Ready`     | `Connected` is true and no internal errors.                                      |

---

## Lifecycle

```
1. [Portal] User selects APIs → clicks "Generate Bundle"
   - Portal reads the consumer workspace's kube-system namespace UID
     (same operation as remote.ClusterUID in the konnector).
   - Portal creates KbindCluster{
         spec.apis            = [...selected APIs...]  // empty = all
         status.localClusterUID = <workspace-kube-system-uid>
     }
   - Portal returns YAML bundle to the user:
         Secret         — kubeconfig for consumer → provider
         Connection     — schema/pull policy; autoBind=true if spec.apis empty
         ClusterBinding — present only if spec.apis non-empty

2. [Consumer] User applies the bundle to their consumer cluster.
   Konnector starts, reconciles the Connection, calls heartbeat():
   - Creates/updates Lease "consumer-<localClusterUID>" in namespace "kbind"
     on the provider with:
         spec.holderIdentity                          = localClusterUID
         annotations["core.kbind.io/consumer-cluster-uid"] = localClusterUID
         labels["core.kbind.io/managed"]              = "true"

3. [KbindClusterReconciler — new in pm-kbind-provider]
   Watches Leases in namespace "kbind" (label core.kbind.io/managed=true).
   On Lease create/update:
   - uid = Lease.spec.holderIdentity
   - List KbindClusters where status.localClusterUID == uid
     (zero matches for foreign Leases; N matches when multiple bundles from the
     same workspace are live simultaneously)
   - For each matching KbindCluster:
       status.leaseRef  = {namespace: "kbind", name: Lease.name}
       condition Connected = True  (renewTime fresh) | False (stale/missing)
   On Lease delete (or renewTime goes stale via periodic requeue):
   - Set condition Connected=False on all matching KbindClusters.
```

---

## Controller placement

```
pm-kbind-provider/internal/controller/
  issuer_controller.go         existing — credential bootstrap only, untouched
  kbindcluster_controller.go   new — Lease-watcher, updates KbindCluster status
```

The `IssuerReconciler` and the `KbindClusterReconciler` are independent. The issuer
controller provisions konnector credentials when a consumer workspace binds the kbind
APIExport; it knows nothing about KbindCluster objects.

---

## Relationship to existing kbind types

| Type             | Lives on  | Owner         | Purpose                                      |
|------------------|-----------|---------------|----------------------------------------------|
| `Connection`     | consumer  | user (bundle) | Links consumer → provider; drives sync       |
| `ClusterBinding` | consumer  | user (bundle) | Selects which APIs to sync                   |
| `KbindCluster`   | provider  | portal        | Records the bundle and tracks consumer liveness |
| `Lease`          | provider  | konnector     | Heartbeat; proves the consumer is still alive |

The `KbindCluster.status.localClusterUID` matches
`Connection.status.localClusterUID` on the consumer side, forming the cross-cluster
identity link without requiring any label to be propagated through the bundle YAML.
