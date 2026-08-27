import type {
  IntegrationCredentialRequestResult,
  IntegrationHostPort,
} from "@octant/plugin-api/integration";

export interface IntegrationHostPortDependencies {
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly requestCredential?: (scope: string) => Promise<IntegrationCredentialRequestResult>;
}

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
    requestCredential:
      dependencies.requestCredential ??
      (async () => ({
        kind: "unavailable",
        reason: "Credential broker is not configured for this integration host.",
      })),
  };
}
