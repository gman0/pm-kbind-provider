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

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	apisv1alpha1 "github.com/kcp-dev/sdk/apis/apis/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	"github.com/kcp-dev/multicluster-provider/apiexport"
	mcmanager "sigs.k8s.io/multicluster-runtime/pkg/manager"

	"github.com/platform-mesh/kube-bind-provider/internal/controller"
)

type operatorOptions struct {
	kcpKubeconfig string
	endpointSlice string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ctrl.SetLogger(zap.New())

	opts := &operatorOptions{}

	root := &cobra.Command{
		Use:   "operator",
		Short: "Platform Mesh kbind provider",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runControllers(cmd.Context(), opts)
		},
	}
	root.Flags().StringVar(&opts.kcpKubeconfig, "kcp-kubeconfig", "",
		"path to the kcp provider workspace kubeconfig (defaults to in-cluster config)")
	root.Flags().StringVar(&opts.endpointSlice, "endpoint-slice", "kbind.platform-mesh.io",
		"name of the APIExportEndpointSlice to watch")
	root.AddCommand(newInitCmd())

	if err := root.ExecuteContext(ctx); err != nil {
		os.Exit(1)
	}
}

func runControllers(ctx context.Context, opts *operatorOptions) error {
	kcpConfig, err := clientcmd.BuildConfigFromFlags("", opts.kcpKubeconfig)
	if err != nil {
		return fmt.Errorf("loading kcp kubeconfig: %w", err)
	}

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		return fmt.Errorf("adding client-go scheme: %w", err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("adding corev1 scheme: %w", err)
	}
	if err := rbacv1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("adding rbacv1 scheme: %w", err)
	}
	if err := apisv1alpha1.AddToScheme(scheme); err != nil {
		return fmt.Errorf("adding kcp apis scheme: %w", err)
	}

	provider, err := apiexport.New(kcpConfig, opts.endpointSlice, apiexport.Options{
		Scheme: scheme,
	})
	if err != nil {
		return fmt.Errorf("creating apiexport provider: %w", err)
	}

	mgr, err := mcmanager.New(kcpConfig, provider, ctrl.Options{
		Scheme: scheme,
	})
	if err != nil {
		return fmt.Errorf("creating manager: %w", err)
	}

	issuerController, err := controller.NewIssuerController()
	if err != nil {
		return fmt.Errorf("failed to create issuer controller: %w", err)
	}
	if err := issuerController.SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up issuer controller: %w", err)
	}

	return mgr.Start(ctx)
}
