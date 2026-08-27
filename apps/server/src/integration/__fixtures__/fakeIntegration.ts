import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";

export default function createFakeIntegration(_hostPort: IntegrationHostPort): IntegrationRuntime {
  return {
    observe: async () => ({
      kind: "authentication" as const,
      snapshot: { state: "unauthorized" as const, capabilities: [] },
    }),
    execute: async () => ({
      kind: "operation" as const,
      operationId: "test",
      result: { kind: "ok" as const, value: null },
    }),
    close: async () => {},
  };
}
