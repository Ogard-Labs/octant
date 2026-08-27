import type { IntegrationHostPort } from "@octant/plugin-api/integration";

export interface IntegrationHostPortDependencies {
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly requestCredential?: (scope: string) => Promise<{ readonly reference: string }>;
}

/**
 * Creates the typed host port handed to an Integration plugin. Only the
 * declared capabilities are wired; the default implementation rejects
 * credential requests until the host injects a credential broker.
 */
export function createIntegrationHostPort(
  dependencies: IntegrationHostPortDependencies = {},
): IntegrationHostPort {
  return {
    fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    requestCredential:
      dependencies.requestCredential ??
      (async () => {
        throw new Error("Credential broker is not configured for this integration host.");
      }),
  };
}
