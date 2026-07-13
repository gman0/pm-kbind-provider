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

interface GraphQLConfig {
  endpoint: string;
  token: string | null;
}

@Injectable({ providedIn: 'root' })
export class BindingsService {
  private luigiContextService = inject(LuigiContextService);

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
}
