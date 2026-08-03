/*
Copyright 2026 The Platform Mesh Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/cluster"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	mcbuilder "sigs.k8s.io/multicluster-runtime/pkg/builder"
	mchandler "sigs.k8s.io/multicluster-runtime/pkg/handler"
	mcmanager "sigs.k8s.io/multicluster-runtime/pkg/manager"
	"sigs.k8s.io/multicluster-runtime/pkg/multicluster"
	mcreconcile "sigs.k8s.io/multicluster-runtime/pkg/reconcile"

	kbpv1alpha1 "github.com/platform-mesh/kube-bind-provider/sdk/apis/kube-bind-provider/v1alpha1"
)

const (
	leaseNamespace       = "kbind"
	leaseDurationSeconds = 60

	condConnected = "Connected"
	condReady     = "Ready"

	reasonLeaseNotFound = "LeaseNotFound"
	reasonLeaseRenewed  = "LeaseRenewed"
	reasonLeaseStale    = "LeaseStale"
	reasonAsExpected    = "AsExpected"

	// leaseConnectionIndex is the cache field-index name for
	// Lease.metadata.annotations["core.kbind.io/connection"].
	leaseConnectionIndex = "lease.connection"
)

// KbindClusterReconciler watches KbindCluster objects and the heartbeat Leases
// the konnector maintains on the provider cluster. It updates KbindCluster.status
// to reflect whether the consumer is actively connected.
type KbindClusterReconciler struct {
	manager mcmanager.Manager
}

func NewKbindClusterController() (*KbindClusterReconciler, error) {
	return &KbindClusterReconciler{}, nil
}

func (r *KbindClusterReconciler) SetupWithManager(mgr mcmanager.Manager) error {
	r.manager = mgr

	if err := mgr.GetFieldIndexer().IndexField(
		context.TODO(),
		&coordinationv1.Lease{},
		leaseConnectionIndex,
		func(obj client.Object) []string {
			lease, ok := obj.(*coordinationv1.Lease)
			if !ok {
				return nil
			}
			if v := lease.Annotations["core.kbind.io/connection"]; v != "" {
				return []string{v}
			}
			return nil
		},
	); err != nil {
		return fmt.Errorf("indexing lease connection: %w", err)
	}

	inKbindNS := predicate.NewPredicateFuncs(func(obj client.Object) bool {
		return obj.GetNamespace() == leaseNamespace
	})

	return mcbuilder.ControllerManagedBy(mgr).
		Named("kbindcluster-controller").
		For(&kbpv1alpha1.KbindCluster{}).
		Watches(
			&coordinationv1.Lease{},
			mapLease,
			mcbuilder.WithPredicates(inKbindNS),
		).
		Complete(r)
}

func mapLease(clusterName multicluster.ClusterName, cl cluster.Cluster) handler.TypedEventHandler[client.Object, mcreconcile.Request] {
	return mchandler.TypedEnqueueRequestsFromMapFuncWithClusterPreservation(func(ctx context.Context, obj client.Object) []mcreconcile.Request {
		lease, ok := obj.(*coordinationv1.Lease)
		if !ok {
			return nil
		}
		if lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity == "" {
			return nil
		}

		if lease.Annotations == nil {
			return nil
		}
		if lease.Annotations["core.kbind.io/consumer-cluster-uid"] == "" {
			return nil
		}
		kbcName := lease.Annotations["core.kbind.io/connection"]
		if kbcName == "" {
			return nil
		}

		var kbc kbpv1alpha1.KbindCluster
		if err := cl.GetClient().Get(ctx, types.NamespacedName{Name: kbcName}, &kbc); err != nil {
			log.FromContext(ctx).Error(err, "getting KbindCluster for Lease event")
			return nil
		}

		return []mcreconcile.Request{
			{
				ClusterName: clusterName,
				Request:     reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&kbc)},
			},
		}
	})
}

// Reconcile drives a KbindCluster toward an accurate status: it finds the
// heartbeat Lease matching status.localClusterUID and sets the Connected and
// Ready conditions accordingly. It requeues every leaseDurationSeconds so a
// silently-dead konnector (no Lease delete event) is eventually detected.
func (r *KbindClusterReconciler) Reconcile(ctx context.Context, req mcreconcile.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	cl, err := r.manager.GetCluster(ctx, req.ClusterName)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("getting cluster %s: %w", req.ClusterName, err)
	}
	c := cl.GetClient()

	kbc := &kbpv1alpha1.KbindCluster{}
	if err := c.Get(ctx, req.NamespacedName, kbc); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Snapshot status fields that must not be re-read after mutation.
	origLeaseRef := kbc.Status.LeaseRef
	origLocalUID := kbc.Status.LocalClusterUID
	origConds := append([]metav1.Condition(nil), kbc.Status.Conditions...)
	var origLastHeartbeat *metav1.Time
	if kbc.Status.LastHeartbeatTime != nil {
		t := *kbc.Status.LastHeartbeatTime
		origLastHeartbeat = &t
	}

	if err := r.reconcileStatus(ctx, c, kbc); err != nil {
		return ctrl.Result{}, err
	}

	if !statusEqual(origLocalUID, origLeaseRef, origConds, origLastHeartbeat, kbc.Status) {
		if err := c.Status().Update(ctx, kbc); err != nil {
			log.Error(err, "updating KbindCluster status")
			return ctrl.Result{}, err
		}
	}

	return ctrl.Result{RequeueAfter: leaseDurationSeconds * time.Second}, nil
}

// reconcileStatus looks up the heartbeat Lease and updates the KbindCluster
// status fields and conditions in place. It does not requeue or return
// transient errors for missing Leases.
//
// When LocalClusterUID is not yet set the konnector's Lease is located via the
// leaseConnectionIndex (keyed by core.kbind.io/connection == kbc.Name), and the
// UID is read from Lease.spec.holderIdentity so the two paths share the same
// connected/stale logic below.
func (r *KbindClusterReconciler) reconcileStatus(ctx context.Context, c client.Client, kbc *kbpv1alpha1.KbindCluster) error {
	var lease *coordinationv1.Lease

	if kbc.Status.LocalClusterUID == "" {
		found, err := r.findLeaseByConnection(ctx, c, kbc.Name)
		if err != nil {
			return err
		}
		if found == nil || found.Spec.HolderIdentity == nil || *found.Spec.HolderIdentity == "" {
			kbc.Status.LeaseRef = nil
			setCondition(kbc, condConnected, metav1.ConditionFalse, reasonLeaseNotFound, "konnector has not established a heartbeat yet")
			setCondition(kbc, condReady, metav1.ConditionFalse, reasonLeaseNotFound, "konnector has not established a heartbeat yet")
			return nil
		}
		kbc.Status.LocalClusterUID = *found.Spec.HolderIdentity
		lease = found
	} else {
		leaseName := "consumer-" + kbc.Status.LocalClusterUID
		found := &coordinationv1.Lease{}
		err := c.Get(ctx, types.NamespacedName{Namespace: leaseNamespace, Name: leaseName}, found)
		if apierrors.IsNotFound(err) {
			kbc.Status.LeaseRef = nil
			setCondition(kbc, condConnected, metav1.ConditionFalse, reasonLeaseNotFound, "konnector has not established a heartbeat yet")
			setCondition(kbc, condReady, metav1.ConditionFalse, reasonLeaseNotFound, "konnector has not established a heartbeat yet")
			return nil
		}
		if err != nil {
			return fmt.Errorf("getting lease %s/%s: %w", leaseNamespace, leaseName, err)
		}
		lease = found
	}

	kbc.Status.LeaseRef = &kbpv1alpha1.LocalLeaseRef{Namespace: leaseNamespace, Name: lease.Name}
	if lease.Spec.RenewTime != nil {
		t := metav1.NewTime(lease.Spec.RenewTime.Time)
		kbc.Status.LastHeartbeatTime = &t
	}
	if isLeaseConnected(lease) {
		setCondition(kbc, condConnected, metav1.ConditionTrue, reasonLeaseRenewed, "konnector is heartbeating")
		setCondition(kbc, condReady, metav1.ConditionTrue, reasonAsExpected, "konnector is connected")
	} else {
		setCondition(kbc, condConnected, metav1.ConditionFalse, reasonLeaseStale, "konnector has not renewed its heartbeat")
		setCondition(kbc, condReady, metav1.ConditionFalse, reasonLeaseStale, "konnector heartbeat is stale")
	}
	return nil
}

// findLeaseByConnection returns the first Lease in the kbind namespace whose
// core.kbind.io/connection annotation matches kbcName, or nil if none exists.
func (r *KbindClusterReconciler) findLeaseByConnection(ctx context.Context, c client.Client, kbcName string) (*coordinationv1.Lease, error) {
	var list coordinationv1.LeaseList
	if err := c.List(ctx, &list,
		client.InNamespace(leaseNamespace),
		client.MatchingFields{leaseConnectionIndex: kbcName},
	); err != nil {
		return nil, fmt.Errorf("listing leases for %s: %w", kbcName, err)
	}
	if len(list.Items) == 0 {
		return nil, nil
	}
	return &list.Items[0], nil
}

// isLeaseConnected returns true when the Lease was renewed within the staleness
// deadline (2× leaseDurationSeconds), meaning the konnector is likely still alive.
func isLeaseConnected(lease *coordinationv1.Lease) bool {
	if lease.Spec.RenewTime == nil {
		return false
	}
	deadline := lease.Spec.RenewTime.Time.Add(2 * leaseDurationSeconds * time.Second)
	return time.Now().Before(deadline)
}

func setCondition(kbc *kbpv1alpha1.KbindCluster, condType string, status metav1.ConditionStatus, reason, msg string) {
	apimeta.SetStatusCondition(&kbc.Status.Conditions, metav1.Condition{
		Type:               condType,
		Status:             status,
		Reason:             reason,
		Message:            msg,
		ObservedGeneration: kbc.Generation,
	})
}

// statusEqual compares the reconciler-managed status fields, ignoring condition
// timestamps so a no-op reconcile does not trigger a spurious status update.
func statusEqual(origLocalUID string, origLeaseRef *kbpv1alpha1.LocalLeaseRef, origConds []metav1.Condition, origLastHeartbeat *metav1.Time, cur kbpv1alpha1.KbindClusterStatus) bool {
	if origLocalUID != cur.LocalClusterUID {
		return false
	}
	if !leaseRefEqual(origLeaseRef, cur.LeaseRef) {
		return false
	}
	if !timeEqual(origLastHeartbeat, cur.LastHeartbeatTime) {
		return false
	}
	for _, ct := range []string{condConnected, condReady} {
		oa := apimeta.FindStatusCondition(origConds, ct)
		ca := apimeta.FindStatusCondition(cur.Conditions, ct)
		if !condEqual(oa, ca) {
			return false
		}
	}
	return true
}

func timeEqual(a, b *metav1.Time) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return a.Equal(b)
}

func leaseRefEqual(a, b *kbpv1alpha1.LocalLeaseRef) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return a.Namespace == b.Namespace && a.Name == b.Name
}

func condEqual(a, b *metav1.Condition) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return a.Status == b.Status && a.Reason == b.Reason && a.Message == b.Message
}
