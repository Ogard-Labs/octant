import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";

export type IntegrationLoaderFailureCode = "module-missing" | "factory-missing" | "runtime-invalid";

export type IntegrationLoaderResult =
  | { readonly kind: "loaded"; readonly runtime: IntegrationRuntime }
  | {
      readonly kind: "failed";
      readonly code: IntegrationLoaderFailureCode;
      readonly message: string;
    };

type IntegrationModule =
  | { readonly default: (hostPort: IntegrationHostPort) => IntegrationRuntime }
  | { readonly createIntegrationRuntime: (hostPort: IntegrationHostPort) => IntegrationRuntime };

function isIntegrationModule(value: unknown): value is IntegrationModule {
  return (
    typeof value === "object" &&
    value !== null &&
    ("default" in value || "createIntegrationRuntime" in value)
  );
}

function isIntegrationRuntime(value: unknown): value is IntegrationRuntime {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Record<string, unknown>;
  return (
    typeof runtime.observe === "function" &&
    typeof runtime.execute === "function" &&
    typeof runtime.close === "function"
  );
}

/**
 * Loads an Integration plugin module and constructs its runtime with the
 * provided host port. The module may export its factory as the default or as
 * a named `createIntegrationRuntime` export. Failures are returned, not thrown,
 * so callers can decide whether to surface or fall back.
 */
export async function loadIntegrationModule(
  modulePath: string,
  hostPort: IntegrationHostPort,
): Promise<IntegrationLoaderResult> {
  let imported: unknown;
  try {
    imported = await import(modulePath);
  } catch (cause) {
    return {
      kind: "failed",
      code: "module-missing",
      message:
        cause instanceof Error ? cause.message : `Failed to load integration module: ${modulePath}`,
    };
  }
  if (!isIntegrationModule(imported)) {
    return {
      kind: "failed",
      code: "factory-missing",
      message: `Integration module ${modulePath} must export a default or createIntegrationRuntime factory.`,
    };
  }
  const factory = "default" in imported ? imported.default : imported.createIntegrationRuntime;
  const runtime = factory(hostPort);
  if (!isIntegrationRuntime(runtime)) {
    return {
      kind: "failed",
      code: "runtime-invalid",
      message: `Integration factory from ${modulePath} did not return a runtime with observe, execute, and close methods.`,
    };
  }
  return { kind: "loaded", runtime };
}
