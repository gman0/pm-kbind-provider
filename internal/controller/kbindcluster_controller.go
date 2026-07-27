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
		fmt.Printf("### mapLease 1\n")
		lease, ok := obj.(*coordinationv1.Lease)
		if !ok {
			fmt.Printf("### mapLease 2\n")
			return nil
		}
		if lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity == "" {
			fmt.Printf("### mapLease 3\n")
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
			fmt.Printf("### mapLease 4\n")
			return nil
		}

		fmt.Printf("### mapLease 6\n")
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
	fmt.Printf("### KbindClusterReconciler.Reconcile 1\n")
	log := log.FromContext(ctx)

	cl, err := r.manager.GetCluster(ctx, req.ClusterName)
	if err != nil {
		fmt.Printf("### KbindClusterReconciler.Reconcile 2\n")
		return ctrl.Result{}, fmt.Errorf("getting cluster %s: %w", req.ClusterName, err)
	}
	c := cl.GetClient()

	kbc := &kbpv1alpha1.KbindCluster{}
	if err := c.Get(ctx, req.NamespacedName, kbc); err != nil {
		fmt.Printf("### KbindClusterReconciler.Reconcile 3\n")
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Snapshot status fields that must not be re-read after mutation.
	origLeaseRef := kbc.Status.LeaseRef
	origLocalUID := kbc.Status.LocalClusterUID
	origConds := append([]metav1.Condition(nil), kbc.Status.Conditions...)

	if err := r.reconcileStatus(ctx, c, kbc); err != nil {
		fmt.Printf("### KbindClusterReconciler.Reconcile 4\n")
		return ctrl.Result{}, err
	}

	if !statusEqual(origLocalUID, origLeaseRef, origConds, kbc.Status) {
		if err := c.Status().Update(ctx, kbc); err != nil {
			fmt.Printf("### KbindClusterReconciler.Reconcile 5\n")
			log.Error(err, "updating KbindCluster status")
			return ctrl.Result{}, err
		}
	}

	fmt.Printf("### KbindClusterReconciler.Reconcile 6\n")
	return ctrl.Result{RequeueAfter: leaseDurationSeconds * time.Second}, nil
}

// reconcileStatus looks up the heartbeat Lease and updates the KbindCluster
// status fields and conditions in place. It is a pure function of the Lease
// state: it does not requeue or return transient errors for missing Leases.
func (r *KbindClusterReconciler) reconcileStatus(ctx context.Context, c client.Client, kbc *kbpv1alpha1.KbindCluster) error {
	if kbc.Status.LocalClusterUID == "" {
		// Portal hasn't set localClusterUID yet; nothing to observe.
		return nil
	}

	leaseName := "consumer-" + kbc.Status.LocalClusterUID
	lease := &coordinationv1.Lease{}
	err := c.Get(ctx, types.NamespacedName{Namespace: leaseNamespace, Name: leaseName}, lease)

	if apierrors.IsNotFound(err) {
		kbc.Status.LeaseRef = nil
		setCondition(kbc, condConnected, metav1.ConditionFalse, reasonLeaseNotFound, "konnector has not established a heartbeat yet")
		setCondition(kbc, condReady, metav1.ConditionFalse, reasonLeaseNotFound, "konnector has not established a heartbeat yet")
		return nil
	}
	if err != nil {
		return fmt.Errorf("getting lease %s/%s: %w", leaseNamespace, leaseName, err)
	}

	kbc.Status.LeaseRef = &kbpv1alpha1.LocalLeaseRef{Namespace: leaseNamespace, Name: leaseName}

	if isLeaseConnected(lease) {
		setCondition(kbc, condConnected, metav1.ConditionTrue, reasonLeaseRenewed, "konnector is heartbeating")
		setCondition(kbc, condReady, metav1.ConditionTrue, reasonAsExpected, "konnector is connected")
	} else {
		setCondition(kbc, condConnected, metav1.ConditionFalse, reasonLeaseStale, "konnector has not renewed its heartbeat")
		setCondition(kbc, condReady, metav1.ConditionFalse, reasonLeaseStale, "konnector heartbeat is stale")
	}
	return nil
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
func statusEqual(origLocalUID string, origLeaseRef *kbpv1alpha1.LocalLeaseRef, origConds []metav1.Condition, cur kbpv1alpha1.KbindClusterStatus) bool {
	if origLocalUID != cur.LocalClusterUID {
		return false
	}
	if !leaseRefEqual(origLeaseRef, cur.LeaseRef) {
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
