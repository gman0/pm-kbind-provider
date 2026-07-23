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

import '@ui5/webcomponents-icons/dist/accept.js';
import '@ui5/webcomponents-icons/dist/copy.js';
import '@ui5/webcomponents-icons/dist/refresh.js';
import '@ui5/webcomponents-icons/dist/slim-arrow-down.js';
import '@ui5/webcomponents-icons/dist/slim-arrow-right.js';
import '@ui5/webcomponents-icons/dist/warning.js';

import { BindingsService } from '../bindings/bindings.service';

// Groups that belong to kcp internals or platform-mesh infrastructure — never surfaced to the konnector.
const SYSTEM_GROUP_SUFFIXES = ['.kcp.io', '.platform-mesh.io'];

function isUserGroup(group: string): boolean {
  if (!group) return false;
  return !SYSTEM_GROUP_SUFFIXES.some((s) => group.endsWith(s));
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
  autoBind = signal(true);
  selectedAPIs = signal<Set<string>>(new Set());
  hideSystemAPIs = signal(true);
  private allResourcePairs = signal<{ group: string; resource: string }[]>([]);
  availableAPIs = computed(() => {
    const pairs = this.allResourcePairs();
    const filtered = this.hideSystemAPIs() ? pairs.filter(r => isUserGroup(r.group)) : pairs;
    return [...new Set(filtered.map(r => `${r.resource}.${r.group}`))].sort();
  });
  kubeconfig = signal<string | null>(null);
  loading = signal(true);
  credentialsReady = signal(false);
  generatedBundle = signal('');

  bundleNameValid = computed(() => K8S_NAME_RE.test(this.bundleName().trim()));

  canGenerate = computed(
    () =>
      this.bundleNameValid() &&
      (this.autoBind() || this.selectedAPIs().size > 0) &&
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
        const allPairs: { group: string; resource: string }[] = [];
        for (const binding of apis) {
          for (const res of binding.status?.boundResources ?? []) {
            if (res.group !== undefined) {
              allPairs.push(res);
            }
          }
        }
        this.allResourcePairs.set(allPairs);

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

  switchToAutoBind(): void {
    this.autoBind.set(true);
    this.selectedAPIs.set(new Set());
    this.generatedBundle.set('');
  }

  switchToManual(): void {
    this.autoBind.set(false);
  }

  onToggleSystemFilter(event: Event): void {
    this.hideSystemAPIs.set((event.target as any).checked as boolean);
    this.selectedAPIs.set(new Set());
    this.generatedBundle.set('');
  }

  onAPITileClick(api: string): void {
    const next = new Set(this.selectedAPIs());
    if (next.has(api)) {
      next.delete(api);
    } else {
      next.add(api);
    }
    this.selectedAPIs.set(next);
    this.generatedBundle.set('');
  }

  // api is "resource.group" e.g. "cowboys.wildwest.dev"
  getAPIResource(api: string): string {
    return api.split('.')[0];
  }

  getAPIGroup(api: string): string {
    const dot = api.indexOf('.');
    return dot >= 0 ? api.slice(dot + 1) : '';
  }

  getAPIInitials(api: string): string {
    return this.getAPIResource(api)[0]?.toUpperCase() ?? '?';
  }

  private readonly colorSchemes = [
    'Accent1', 'Accent2', 'Accent3', 'Accent4', 'Accent5',
    'Accent6', 'Accent7', 'Accent8', 'Accent9', 'Accent10',
  ];

  getColorScheme(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return this.colorSchemes[Math.abs(hash) % this.colorSchemes.length];
  }

  generateBundle(): void {
    const name = this.bundleName().trim();
    const autoBind = this.autoBind();
    const apis = [...this.selectedAPIs()].sort();
    const kubeconfig = this.kubeconfig();
    if (!name || (!autoBind && !apis.length) || !kubeconfig) return;

    const bundle = this.assembleBundle(name, apis, kubeconfig, autoBind);
    this.generatedBundle.set(bundle);
    this.copyToClipboard(bundle, 'Bundle copied to clipboard');
  }

  copyBundle(): void {
    const bundle = this.generatedBundle();
    if (bundle) this.copyToClipboard(bundle, 'Bundle copied to clipboard');
  }

  private assembleBundle(name: string, apis: string[], kubeconfig: string, autoBind: boolean): string {
    const kubeconfigIndented = kubeconfig
      .trimEnd()
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');

    const parts: string[] = [
      `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: kbind
stringData:
  kubeconfig: |
${kubeconfigIndented}`,
      `apiVersion: core.kbind.io/v1alpha1
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
    updatePolicy: Always${autoBind ? '\n  autoBind: true' : ''}`,
    ];

    if (!autoBind) {
      const apisYaml = apis.map((a) => `    - name: ${a}`).join('\n');
      parts.push(`apiVersion: core.kbind.io/v1alpha1
kind: ClusterBinding
metadata:
  name: ${name}
spec:
  connectionRef:
    name: ${name}
  apis:
${apisYaml}`);
    }

    return parts.join('\n---\n');
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
