import { Injectable, inject } from '@angular/core';
import { LuigiContextService } from '@luigi-project/client-support-angular';
import { from, map, Observable, of, switchMap, catchError, filter, take } from 'rxjs';

export interface Secret {
  data?: Record<string, string>;
}

interface SecretResponse {
  v1: {
    Secret: Secret;
  };
}

export interface APIBinding {
  metadata: { name: string };
  status?: {
    boundResources?: Array<{ group: string; resource: string }>;
  };
}

interface APIBindingListResponse {
  apis_kcp_io: {
    v1alpha1: {
      APIBindings: {
        items: APIBinding[];
      };
    };
  };
}

export interface KbindClusterCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransitionTime?: string;
}

export interface KbindCluster {
  metadata: { name: string; creationTimestamp?: string };
  spec?: { apis?: Array<{ name: string }> };
  status?: {
    localClusterUID?: string;
    leaseRef?: { namespace: string; name: string };
    conditions?: KbindClusterCondition[];
  };
}

interface KbindClusterListResponse {
  kube_bind_provider_platform_mesh_io: {
    v1alpha1: {
      KbindClusters: {
        items: KbindCluster[];
      };
    };
  };
}

const GET_SECRET_QUERY = `
  query GetSecret($name: String!, $namespace: String!) {
    v1 {
      Secret(name: $name, namespace: $namespace) {
        data
      }
    }
  }
`;

const LIST_API_BINDINGS_QUERY = `
  query ListAPIBindings {
    apis_kcp_io {
      v1alpha1 {
        APIBindings {
          items {
            metadata { name }
            status {
              boundResources { group resource }
            }
          }
        }
      }
    }
  }
`;

const LIST_KBIND_CLUSTERS_QUERY = `
  query ListKbindClusters {
    kube_bind_provider_platform_mesh_io {
      v1alpha1 {
        KbindClusters {
          items {
            metadata { name creationTimestamp }
            spec { apis { name } }
            status {
              localClusterUID
              leaseRef { namespace name }
              conditions { type status reason message lastTransitionTime }
            }
          }
        }
      }
    }
  }
`;

const APPLY_KBIND_CLUSTER_MUTATION = `
  mutation ApplyKbindCluster($yaml: String!) {
    applyYaml(yaml: $yaml)
  }
`;

const DELETE_KBIND_CLUSTER_MUTATION = `
  mutation DeleteKbindCluster($name: String!) {
    kube_bind_provider_platform_mesh_io {
      v1alpha1 {
        deleteKbindCluster(name: $name)
      }
    }
  }
`;

interface GraphQLConfig {
  endpoint: string;
  token: string | null;
}

@Injectable({ providedIn: 'root' })
export class BindingsService {
  private luigiContextService = inject(LuigiContextService);

  private buildKbindClusterYAML(name: string, apis: Array<{ name: string }>): string {
    const specLines = apis.length === 0
      ? ['spec: {}']
      : ['spec:', '  apis:', ...apis.map(a => `    - name: ${a.name}`)];
    return [
      'apiVersion: kube-bind-provider.platform-mesh.io/v1alpha1',
      'kind: KbindCluster',
      'metadata:',
      `  name: ${name}`,
      ...specLines,
    ].join('\n');
  }

  private getGraphQLConfig(): Observable<GraphQLConfig> {
    return this.luigiContextService.contextObservable().pipe(
      filter((ctx) => !!ctx?.context && Object.keys(ctx.context).length > 0),
      take(1),
      map((ctx) => {
        const context = ctx.context as any;
        const token = context.token || null;
        let endpoint = context.portalContext?.crdGatewayApiUrl;
        if (!endpoint) {
          console.warn('crdGatewayApiUrl not found in context, falling back to default');
          endpoint = context.portalBaseUrl + '/graphql';
        }
        return { endpoint, token };
      })
    );
  }

  private buildHeaders(token: string | null): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  getSecret(name: string, namespace: string): Observable<Secret | null> {
    return this.getGraphQLConfig().pipe(
      switchMap(({ endpoint, token }) =>
        from(
          fetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(token),
            body: JSON.stringify({ query: GET_SECRET_QUERY, variables: { name, namespace } }),
          }).then((res) => res.json())
        )
      ),
      map((response: { data: SecretResponse }) => response.data?.v1?.Secret || null),
      catchError((error) => {
        console.error('Error fetching secret:', error);
        return of(null);
      })
    );
  }

  listAPIBindings(): Observable<APIBinding[]> {
    return this.getGraphQLConfig().pipe(
      switchMap(({ endpoint, token }) =>
        from(
          fetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(token),
            body: JSON.stringify({ query: LIST_API_BINDINGS_QUERY }),
          }).then((res) => res.json())
        )
      ),
      map((response: { data: APIBindingListResponse }) =>
        response.data?.apis_kcp_io?.v1alpha1?.APIBindings?.items || []
      ),
      catchError((error) => {
        console.error('Error fetching API bindings:', error);
        return of([]);
      })
    );
  }

  listKbindClusters(): Observable<KbindCluster[]> {
    return this.getGraphQLConfig().pipe(
      switchMap(({ endpoint, token }) =>
        from(
          fetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(token),
            body: JSON.stringify({ query: LIST_KBIND_CLUSTERS_QUERY }),
          }).then((res) => res.json())
        )
      ),
      map((response: { data: KbindClusterListResponse }) =>
        response.data?.kube_bind_provider_platform_mesh_io?.v1alpha1?.KbindClusters?.items || []
      ),
      catchError((error) => {
        console.error('Error fetching KbindClusters:', error);
        return of([]);
      })
    );
  }

  createKbindCluster(cluster: KbindCluster): Observable<KbindCluster | null> {
    return this.getGraphQLConfig().pipe(
      switchMap(({ endpoint, token }) => {
        const yaml = this.buildKbindClusterYAML(cluster.metadata.name, cluster.spec?.apis ?? []);
        return from(
          fetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(token),
            body: JSON.stringify({ query: APPLY_KBIND_CLUSTER_MUTATION, variables: { yaml } }),
          }).then((res) => res.json())
        );
      }),
      map((response: any) => {
        if (response.errors?.length) throw new Error(response.errors[0].message);
        return response.data?.applyYaml ?? null;
      }),
      catchError((error) => {
        console.error('Error creating KbindCluster:', error);
        return of(null);
      })
    );
  }

  patchKbindClusterSpec(name: string, apis: Array<{ name: string }>): Observable<KbindCluster | null> {
    return this.getGraphQLConfig().pipe(
      switchMap(({ endpoint, token }) => {
        const yaml = this.buildKbindClusterYAML(name, apis);
        return from(
          fetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(token),
            body: JSON.stringify({ query: APPLY_KBIND_CLUSTER_MUTATION, variables: { yaml } }),
          }).then((res) => res.json())
        );
      }),
      map((response: any) => {
        if (response.errors?.length) throw new Error(response.errors[0].message);
        return response.data?.applyYaml ?? null;
      }),
      catchError((error) => {
        console.error('Error patching KbindCluster:', error);
        return of(null);
      })
    );
  }

  deleteKbindCluster(name: string): Observable<boolean> {
    return this.getGraphQLConfig().pipe(
      switchMap(({ endpoint, token }) =>
        from(
          fetch(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(token),
            body: JSON.stringify({ query: DELETE_KBIND_CLUSTER_MUTATION, variables: { name } }),
          }).then((res) => res.json())
        )
      ),
      map((response: any) => {
        if (response.errors?.length) throw new Error(response.errors[0].message);
        return response.data?.kube_bind_provider_platform_mesh_io?.v1alpha1?.deleteKbindCluster === true;
      }),
      catchError((error) => {
        console.error('Error deleting KbindCluster:', error);
        return of(false);
      })
    );
  }
}
