import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";

export default function createFakeIntegration(hostPort: IntegrationHostPort): IntegrationRuntime {
  return {
    observe: async () => ({
      kind: "authentication" as const,
      snapshot: { state: "unauthorized" as const, capabilities: [] },
    }),
    execute: async () => ({
      kind: "authentication" as const,
      snapshot: { state: "unauthorized" as const, capabilities: [] },
    }),
    close: async () => {},
  };
}
