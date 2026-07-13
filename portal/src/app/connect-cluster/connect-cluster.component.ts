import { Component, CUSTOM_ELEMENTS_SCHEMA, OnInit, computed, inject, signal } from '@angular/core';
import * as LuigiClient from '@luigi-project/client';
import {
  ButtonComponent,
  DynamicPageComponent,
  DynamicPageTitleComponent,
  IconComponent,
  InputComponent,
  LabelComponent,
  TextComponent,
  TitleComponent,
  ToolbarButtonComponent,
  ToolbarComponent,
} from '@ui5/webcomponents-ngx';
import { forkJoin } from 'rxjs';

import '@ui5/webcomponents-icons/dist/copy.js';
import '@ui5/webcomponents-icons/dist/refresh.js';
import '@ui5/webcomponents-icons/dist/warning.js';

import { BindingsService } from '../bindings/bindings.service';

// Groups that belong to kcp internals — never surfaced to the konnector.
const KCP_SYSTEM_SUFFIXES = ['.kcp.io'];

function isUserGroup(group: string): boolean {
  if (!group) return false;
  return !KCP_SYSTEM_SUFFIXES.some((s) => group.endsWith(s));
}

// Kubernetes name: lowercase alphanumeric and hyphens, no leading/trailing hyphen.
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

@Component({
  selector: 'app-connect-cluster',
  standalone: true,
  imports: [
    DynamicPageComponent,
    DynamicPageTitleComponent,
    TitleComponent,
    LabelComponent,
    TextComponent,
    ToolbarComponent,
    ToolbarButtonComponent,
    InputComponent,
    ButtonComponent,
    IconComponent,
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './connect-cluster.component.html',
  styleUrl: './connect-cluster.component.scss',
})
export class ConnectClusterComponent implements OnInit {
  private bindingsService = inject(BindingsService);

  bundleName = signal('');
  selectedAPIs = signal<Set<string>>(new Set());
  availableAPIs = signal<string[]>([]);
  kubeconfig = signal<string | null>(null);
  loading = signal(true);
  credentialsReady = signal(false);
  generatedBundle = signal('');

  bundleNameValid = computed(() => K8S_NAME_RE.test(this.bundleName().trim()));

  canGenerate = computed(
    () =>
      this.bundleNameValid() &&
      this.selectedAPIs().size > 0 &&
      this.credentialsReady()
  );

  ngOnInit(): void {
    LuigiClient.addInitListener(() => {
      LuigiClient.uxManager().showLoadingIndicator();
      this.loadData();
    });
  }

  loadData(): void {
    this.loading.set(true);
    this.generatedBundle.set('');
    this.selectedAPIs.set(new Set());

    forkJoin({
      apis: this.bindingsService.listAPIBindings(),
      secret: this.bindingsService.getSecret('kbind-kubeconfig', 'kbind'),
    }).subscribe({
      next: ({ apis, secret }) => {
        const apiNames = new Set<string>();
        for (const binding of apis) {
          for (const res of binding.status?.boundResources ?? []) {
            if (isUserGroup(res.group)) {
              apiNames.add(`${res.resource}.${res.group}`);
            }
          }
        }
        this.availableAPIs.set([...apiNames].sort());

        const rawKubeconfig = secret?.data?.['kubeconfig'];
        if (rawKubeconfig) {
          try {
            this.kubeconfig.set(atob(rawKubeconfig));
            this.credentialsReady.set(true);
          } catch {
            this.kubeconfig.set(null);
            this.credentialsReady.set(false);
          }
        } else {
          this.kubeconfig.set(null);
          this.credentialsReady.set(false);
        }

        this.loading.set(false);
        LuigiClient.uxManager().hideLoadingIndicator();
      },
      error: (err) => {
        console.error('Failed to load data:', err);
        this.loading.set(false);
        LuigiClient.uxManager().hideLoadingIndicator();
        LuigiClient.uxManager().showAlert({
          text: 'Failed to load workspace data',
          type: 'error',
          closeAfter: 4000,
        });
      },
    });
  }

  onNameInput(event: Event): void {
    this.bundleName.set((event.target as any).value as string);
    this.generatedBundle.set('');
  }

  onAPIToggle(event: Event, apiName: string): void {
    const checked = (event.target as any).checked as boolean;
    const next = new Set(this.selectedAPIs());
    if (checked) {
      next.add(apiName);
    } else {
      next.delete(apiName);
    }
    this.selectedAPIs.set(next);
    this.generatedBundle.set('');
  }

  generateBundle(): void {
    const name = this.bundleName().trim();
    const apis = [...this.selectedAPIs()].sort();
    const kubeconfig = this.kubeconfig();
    if (!name || !apis.length || !kubeconfig) return;

    const bundle = this.assembleBundle(name, apis, kubeconfig);
    this.generatedBundle.set(bundle);
    this.copyToClipboard(bundle, 'Bundle copied to clipboard');
  }

  copyBundle(): void {
    const bundle = this.generatedBundle();
    if (bundle) this.copyToClipboard(bundle, 'Bundle copied to clipboard');
  }

  private assembleBundle(name: string, apis: string[], kubeconfig: string): string {
    const kubeconfigIndented = kubeconfig
      .trimEnd()
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    const apisYaml = apis.map((a) => `    - name: ${a}`).join('\n');

    return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: kbind
stringData:
  kubeconfig: |
${kubeconfigIndented}
---
apiVersion: core.kbind.io/v1alpha1
kind: Connection
metadata:
  name: ${name}
spec:
  kubeconfigSecretRef:
    namespace: kbind
    name: ${name}
    key: kubeconfig
  schema:
    source: OpenAPI
    pullPolicy: Bound
    updatePolicy: Always
---
apiVersion: core.kbind.io/v1alpha1
kind: ClusterBinding
metadata:
  name: ${name}
spec:
  connectionRef:
    name: ${name}
  apis:
${apisYaml}`;
  }

  private copyToClipboard(text: string, successMessage: string): void {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        () => LuigiClient.uxManager().showAlert({ text: successMessage, type: 'success', closeAfter: 2000 }),
        () => this.fallbackCopy(text, successMessage)
      );
    } else {
      this.fallbackCopy(text, successMessage);
    }
  }

  private fallbackCopy(text: string, successMessage: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-999999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      if (document.execCommand('copy')) {
        LuigiClient.uxManager().showAlert({ text: successMessage, type: 'success', closeAfter: 2000 });
      }
    } catch {}
    document.body.removeChild(ta);
  }
}
