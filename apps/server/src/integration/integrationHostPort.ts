import type {
  IntegrationActivitySource,
  IntegrationCredentialRequestResult,
  IntegrationHostPort,
  IntegrationPkceBeginResult,
  IntegrationPkceRefreshResult,
  IntegrationRevokeResult,
} from "@octant/plugin-api/integration";

export interface IntegrationHostPortDependencies {
  readonly registerCredentialOperation?: IntegrationHostPort["registerCredentialOperation"];
  readonly registerActivitySource?: IntegrationHostPort["registerActivitySource"];
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly requestCredential?: (scope: string) => Promise<IntegrationCredentialRequestResult>;
  readonly beginPkceAuthorization?: IntegrationHostPort["beginPkceAuthorization"];
  readonly refreshPkceAuthorization?: IntegrationHostPort["refreshPkceAuthorization"];
  readonly revokeCredential?: IntegrationHostPort["revokeCredential"];
}

const unavailableCredential: IntegrationCredentialRequestResult = {
  kind: "unavailable",
  reason: "Credential broker is not configured for this integration host.",
};

const refusedPkce: IntegrationPkceBeginResult = {
  kind: "refused",
  reason: "Authorization is not configured for this integration host.",
};

const failedRefresh: IntegrationPkceRefreshResult = {
  kind: "failed",
  reason: "Token refresh is not configured for this integration host.",
};

const clearedRevoke: IntegrationRevokeResult = { kind: "cleared" };

/**
 * Creates the typed host port handed to an Integration plugin. Only the
 * declared capabilities are wired; the default implementation reports that no
 * credential broker is available until the host injects one.
 */
export function createIntegrationHostPort(
  dependencies: IntegrationHostPortDependencies = {},
): IntegrationHostPort {
  return {
    ...(dependencies.registerCredentialOperation === undefined
      ? {}
      : { registerCredentialOperation: dependencies.registerCredentialOperation }),
    ...(dependencies.registerActivitySource === undefined
      ? {}
      : { registerActivitySource: dependencies.registerActivitySource }),
    fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    requestCredential: dependencies.requestCredential ?? (async () => unavailableCredential),
    beginPkceAuthorization: dependencies.beginPkceAuthorization ?? (async () => refusedPkce),
    refreshPkceAuthorization: dependencies.refreshPkceAuthorization ?? (async () => failedRefresh),
    revokeCredential: dependencies.revokeCredential ?? (async () => clearedRevoke),
  };
}

/**
 * The host side of one integration's activity-source registration: a single
 * binding slot scoped to that integration. While a binding is active a second
 * registration is refused; `release` drops only the binding it was issued
 * for, so an older release cannot evict a newer registration of the same
 * source, and calling it twice is a no-op. Lookups answer the bound source
 * only while the integration is effective, so disabling removes it before any
 * credential or network observation.
 */
export function integrationActivitySourceSlot(effective: () => boolean): {
  readonly registerActivitySource: NonNullable<IntegrationHostPort["registerActivitySource"]>;
  readonly current: () => IntegrationActivitySource | undefined;
} {
  let binding:
    | { readonly identity: object; readonly source: IntegrationActivitySource }
    | undefined;
  return {
    registerActivitySource: (source) => {
      if (binding !== undefined) return { kind: "refused" };
      const identity = {};
      binding = { identity, source };
      return {
        kind: "registered",
        release: () => {
          if (binding?.identity === identity) binding = undefined;
        },
      };
    },
    current: () => (effective() ? binding?.source : undefined),
  };
}
