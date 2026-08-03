import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
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
import '@ui5/webcomponents-icons/dist/add.js';
import '@ui5/webcomponents-icons/dist/copy.js';
import '@ui5/webcomponents-icons/dist/decline.js';
import '@ui5/webcomponents-icons/dist/edit.js';
import '@ui5/webcomponents-icons/dist/delete.js';
import '@ui5/webcomponents-icons/dist/refresh.js';
import '@ui5/webcomponents-icons/dist/slim-arrow-down.js';
import '@ui5/webcomponents-icons/dist/slim-arrow-right.js';
import '@ui5/webcomponents-icons/dist/warning.js';

import { BindingsService, KbindCluster } from '../bindings/bindings.service';

const SYSTEM_GROUP_SUFFIXES = ['.kcp.io', '.platform-mesh.io'];

function isUserGroup(group: string): boolean {
  if (!group) return false;
  return !SYSTEM_GROUP_SUFFIXES.some((s) => group.endsWith(s));
}

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

  @ViewChild('createDialog') createDialogRef!: ElementRef;
  @ViewChild('editDialog') editDialogRef!: ElementRef;
  @ViewChild('deleteDialog') deleteDialogRef!: ElementRef;

  // ── data ────────────────────────────────────────────────────────────────────

  loading = signal(true);
  credentialsReady = signal(false);
  kbindClusters = signal<KbindCluster[]>([]);
  private allResourcePairs = signal<{ group: string; resource: string }[]>([]);
  private kubeconfig = signal<string | null>(null);
  availableAPIs = computed(() => {
    const pairs = this.allResourcePairs();
    const filtered = this.hideSystemAPIs() ? pairs.filter(r => isUserGroup(r.group)) : pairs;
    return [...new Set(filtered.map(r => `${r.resource}.${r.group}`))].sort();
  });

  // ── create dialog state ──────────────────────────────────────────────────────

  bundleName = signal('');
  autoBind = signal(true);
  selectedAPIs = signal<Set<string>>(new Set());
  hideSystemAPIs = signal(true);
  generatedBundle = signal('');
  creating = signal(false);

  bundleNameValid = computed(() => K8S_NAME_RE.test(this.bundleName().trim()));

  canGenerate = computed(
    () =>
      this.bundleNameValid() &&
      (this.autoBind() || this.selectedAPIs().size > 0) &&
      this.credentialsReady()
  );

  canSave = computed(
    () =>
      this.bundleNameValid() &&
      !!this.generatedBundle() &&
      !this.creating()
  );

  // ── edit dialog state ────────────────────────────────────────────────────────

  editingCluster = signal<KbindCluster | null>(null);
  editSelectedAPIs = signal<Set<string>>(new Set());
  editHideSystemAPIs = signal(true);
  editGeneratedYAML = signal('');
  saving = signal(false);

  editIsAutoBind = computed(() => {
    const c = this.editingCluster();
    return !c?.spec?.apis || c.spec.apis.length === 0;
  });

  editAvailableAPIs = computed(() => {
    const pairs = this.allResourcePairs();
    const filtered = this.editHideSystemAPIs() ? pairs.filter(r => isUserGroup(r.group)) : pairs;
    return [...new Set(filtered.map(r => `${r.resource}.${r.group}`))].sort();
  });

  canSaveEdit = computed(
    () => !this.editIsAutoBind() && this.editSelectedAPIs().size > 0 && !!this.editGeneratedYAML()
  );

  // ── delete dialog state ──────────────────────────────────────────────────────

  deletingClusterName = signal('');
  deleting = signal(false);

  // ── lifecycle ────────────────────────────────────────────────────────────────

  ngOnInit(): void {
    LuigiClient.addInitListener(() => {
      LuigiClient.uxManager().showLoadingIndicator();
      this.loadData();
    });
  }

  loadData(): void {
    this.loading.set(true);

    forkJoin({
      apis: this.bindingsService.listAPIBindings(),
      secret: this.bindingsService.getSecret('kbind-kubeconfig', 'kbind'),
      clusters: this.bindingsService.listKbindClusters(),
    }).subscribe({
      next: ({ apis, secret, clusters }) => {
        const allPairs: { group: string; resource: string }[] = [];
        for (const binding of apis) {
          for (const res of binding.status?.boundResources ?? []) {
            if (res.group !== undefined) allPairs.push(res);
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

        this.kbindClusters.set(clusters);
        this.loading.set(false);
        LuigiClient.uxManager().hideLoadingIndicator();
      },
      error: (err) => {
        console.error('Failed to load data:', err);
        this.loading.set(false);
        LuigiClient.uxManager().hideLoadingIndicator();
        LuigiClient.uxManager().showAlert({ text: 'Failed to load workspace data', type: 'error', closeAfter: 4000 });
      },
    });
  }

  // ── create dialog ────────────────────────────────────────────────────────────

  openCreateDialog(): void {
    this.bundleName.set('');
    this.autoBind.set(true);
    this.selectedAPIs.set(new Set());
    this.hideSystemAPIs.set(true);
    this.generatedBundle.set('');
    this.creating.set(false);
    this.createDialogRef.nativeElement.open = true;
  }

  closeCreateDialog(): void {
    this.createDialogRef.nativeElement.open = false;
  }

  generateBundle(): void {
    const name = this.bundleName().trim();
    const autoBind = this.autoBind();
    const apis = [...this.selectedAPIs()].sort();
    const kubeconfig = this.kubeconfig();
    if (!name || (!autoBind && !apis.length) || !kubeconfig) return;

    const bundle = this.assembleBundle(name, apis, kubeconfig, autoBind);
    this.generatedBundle.set(bundle);
  }

  saveConnection(): void {
    const name = this.bundleName().trim();
    const autoBind = this.autoBind();
    const apis = [...this.selectedAPIs()].sort();
    if (!name || !this.generatedBundle()) return;

    this.creating.set(true);
    const apiRefs = autoBind ? [] : apis.map(a => ({ name: a }));
    this.bindingsService.createKbindCluster({
      metadata: { name },
      spec: { apis: apiRefs },
    }).subscribe({
      next: () => {
        this.creating.set(false);
        this.closeCreateDialog();
        this.loadData();
      },
      error: () => {
        this.creating.set(false);
        LuigiClient.uxManager().showAlert({ text: 'Failed to create KbindCluster', type: 'error', closeAfter: 4000 });
      },
    });
  }

  // ── create form helpers ───────────────────────────────────────────────────────

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
    next.has(api) ? next.delete(api) : next.add(api);
    this.selectedAPIs.set(next);
    this.generatedBundle.set('');
  }

  // ── edit dialog ───────────────────────────────────────────────────────────────

  openEditDialog(cluster: KbindCluster): void {
    this.editingCluster.set(cluster);
    const preSelected = new Set((cluster.spec?.apis ?? []).map(a => a.name));
    this.editSelectedAPIs.set(preSelected);
    this.editHideSystemAPIs.set(true);
    this.saving.set(false);

    const kubeconfig = this.kubeconfig();
    const autoBind = !cluster.spec?.apis || cluster.spec.apis.length === 0;
    const apis = [...preSelected].sort();
    this.editGeneratedYAML.set(
      kubeconfig ? this.assembleBundle(cluster.metadata.name, apis, kubeconfig, autoBind) : ''
    );

    this.editDialogRef.nativeElement.open = true;
  }

  closeEditDialog(): void {
    this.editDialogRef.nativeElement.open = false;
  }

  onEditAPITileClick(api: string): void {
    const next = new Set(this.editSelectedAPIs());
    next.has(api) ? next.delete(api) : next.add(api);
    this.editSelectedAPIs.set(next);
    this.editGeneratedYAML.set('');
  }

  onEditToggleSystemFilter(event: Event): void {
    this.editHideSystemAPIs.set((event.target as any).checked as boolean);
  }

  generateEditBundle(): void {
    const cluster = this.editingCluster();
    const kubeconfig = this.kubeconfig();
    if (!cluster || !kubeconfig || this.editSelectedAPIs().size === 0) return;
    const apis = [...this.editSelectedAPIs()].sort();
    this.editGeneratedYAML.set(this.assembleBundle(cluster.metadata.name, apis, kubeconfig, false));
  }

  copyBundle(): void {
    const bundle = this.generatedBundle();
    if (bundle) this.copyToClipboard(bundle, 'Bundle copied to clipboard');
  }

  copyEditYAML(): void {
    const yaml = this.editGeneratedYAML();
    if (yaml) this.copyToClipboard(yaml, 'Bundle copied to clipboard');
  }

  saveEdit(): void {
    const cluster = this.editingCluster();
    if (!cluster || !this.canSaveEdit()) return;
    const apis = [...this.editSelectedAPIs()].sort().map(a => ({ name: a }));
    this.saving.set(true);
    this.bindingsService.patchKbindClusterSpec(cluster.metadata.name, apis).subscribe({
      next: () => {
        this.saving.set(false);
        this.closeEditDialog();
        this.loadData();
      },
      error: () => {
        this.saving.set(false);
        LuigiClient.uxManager().showAlert({ text: 'Failed to update KbindCluster', type: 'error', closeAfter: 4000 });
      },
    });
  }

  // ── delete dialog ─────────────────────────────────────────────────────────────

  openDeleteDialog(name: string): void {
    this.deletingClusterName.set(name);
    this.deleting.set(false);
    this.deleteDialogRef.nativeElement.open = true;
  }

  closeDeleteDialog(): void {
    this.deleteDialogRef.nativeElement.open = false;
  }

  executeDelete(): void {
    const name = this.deletingClusterName();
    if (!name) return;
    this.deleting.set(true);
    this.bindingsService.deleteKbindCluster(name).subscribe({
      next: () => {
        this.deleting.set(false);
        this.closeDeleteDialog();
        this.loadData();
      },
      error: () => {
        this.deleting.set(false);
        LuigiClient.uxManager().showAlert({ text: 'Failed to delete KbindCluster', type: 'error', closeAfter: 4000 });
      },
    });
  }

  // ── status display helpers ───────────────────────────────────────────────────

  getConnectedCondition(cluster: KbindCluster) {
    return cluster.status?.conditions?.find(c => c.type === 'Connected');
  }

  getStatusLabel(cluster: KbindCluster): string {
    const cond = this.getConnectedCondition(cluster);
    if (!cond) return 'Unknown';
    if (cond.status === 'True') return 'Connected';
    return cond.reason === 'LeaseNotFound' ? 'Not connected' : 'Stale';
  }

  getStatusClass(cluster: KbindCluster): string {
    const cond = this.getConnectedCondition(cluster);
    if (!cond) return 'status-unknown';
    if (cond.status === 'True') return 'status-connected';
    return cond.reason === 'LeaseNotFound' ? 'status-pending' : 'status-stale';
  }

  getLastHeartbeat(cluster: KbindCluster): string {
    const cond = this.getConnectedCondition(cluster);
    if (!cond) return '—';
    if (cond.status === 'True') return 'Established';
    return cond.lastTransitionTime ? this.formatRelativeTime(cond.lastTransitionTime) : '—';
  }

  getAPISummary(cluster: KbindCluster): string {
    const apis = cluster.spec?.apis;
    if (!apis || apis.length === 0) return 'All APIs';
    if (apis.length <= 2) return apis.map(a => a.name).join(', ');
    return `${apis[0].name}, ${apis[1].name} +${apis.length - 2} more`;
  }

  isAutoBind(cluster: KbindCluster): boolean {
    return !cluster.spec?.apis || cluster.spec.apis.length === 0;
  }

  private formatRelativeTime(iso: string): string {
    const delta = Date.now() - new Date(iso).getTime();
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // ── shared API tile helpers ──────────────────────────────────────────────────

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

  // ── clipboard ─────────────────────────────────────────────────────────────────

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

  // ── bundle assembly (create) ─────────────────────────────────────────────────

  private assembleBundle(name: string, apis: string[], kubeconfig: string, autoBind: boolean): string {
    const kubeconfigIndented = kubeconfig.trimEnd().split('\n').map(l => `    ${l}`).join('\n');

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
      const apisYaml = apis.map(a => `    - name: ${a}`).join('\n');
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
}
