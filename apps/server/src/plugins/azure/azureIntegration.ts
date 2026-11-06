import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";
import { azureCredentialOperation } from "./azureCredentialOperation";

/** The public integration port owns custody and use; this plugin receives no token. */
export function createAzureIntegration(host: IntegrationHostPort): IntegrationRuntime {
  const registration = host.registerCredentialOperation?.(azureCredentialOperation);
  const observation = async () => ({
    kind: "authentication" as const,
    snapshot: {
      state: "unauthorized" as const,
      capabilities: [],
      remediation:
        "Use the private one-use Azure subscriptions card with an unexpired Resource Manager token. No saved Azure sign-in or CLI credentials are available.",
    },
  });
  return {
    observe: observation,
    execute: observation,
    close: async () => {
      if (registration?.kind === "registered") registration.release();
    },
  };
}
