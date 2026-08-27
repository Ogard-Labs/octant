import type {
  IntegrationCredentialRequestResult,
  IntegrationHostPort,
  IntegrationPkceBeginResult,
  IntegrationPkceRefreshResult,
  IntegrationRevokeResult,
} from "@octant/plugin-api/integration";

export interface IntegrationHostPortDependencies {
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
    fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    requestCredential: dependencies.requestCredential ?? (async () => unavailableCredential),
    beginPkceAuthorization: dependencies.beginPkceAuthorization ?? (async () => refusedPkce),
    refreshPkceAuthorization: dependencies.refreshPkceAuthorization ?? (async () => failedRefresh),
    revokeCredential: dependencies.revokeCredential ?? (async () => clearedRevoke),
  };
}
