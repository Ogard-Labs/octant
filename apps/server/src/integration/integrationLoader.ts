import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";

export type IntegrationLoaderFailureCode =
  | "module-missing"
  | "factory-missing"
  | "factory-not-callable"
  | "runtime-invalid"
  | "runtime-factory-threw";

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

/** Type guard for an integration module that exposes a factory export. */
function isIntegrationModule(value: unknown): value is IntegrationModule {
  return (
    typeof value === "object" &&
    value !== null &&
    ("default" in value || "createIntegrationRuntime" in value)
  );
}

/** Reads a named method from a candidate runtime object without coercing it. */
function integrationRuntimeMethod(value: unknown, name: string): unknown {
  return Reflect.get(value as object, name);
}

/** Type guard for an object that implements the IntegrationRuntime interface. */
function isIntegrationRuntime(value: unknown): value is IntegrationRuntime {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof integrationRuntimeMethod(value, "observe") === "function" &&
    typeof integrationRuntimeMethod(value, "execute") === "function" &&
    typeof integrationRuntimeMethod(value, "close") === "function"
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
  return constructIntegrationRuntime(factory, hostPort, modulePath);
}

/**
 * Constructs an Integration runtime from an already-resolved factory. Product
 * callers use this with a statically imported first-party factory so packaging
 * can tree-shake the plugin; the path-based loader above uses the same
 * validation for third-party modules.
 */
export function constructIntegrationRuntime(
  factory: unknown,
  hostPort: IntegrationHostPort,
  origin = "integration factory",
): IntegrationLoaderResult {
  if (typeof factory !== "function") {
    return {
      kind: "failed",
      code: "factory-not-callable",
      message: `Integration export from ${origin} is not a callable factory.`,
    };
  }
  let runtime: unknown;
  try {
    runtime = factory(hostPort);
  } catch (cause) {
    return {
      kind: "failed",
      code: "runtime-factory-threw",
      message:
        cause instanceof Error
          ? cause.message
          : `Integration factory from ${origin} threw while constructing the runtime.`,
    };
  }
  if (!isIntegrationRuntime(runtime)) {
    return {
      kind: "failed",
      code: "runtime-invalid",
      message: `Integration factory from ${origin} did not return a runtime with observe, execute, and close methods.`,
    };
  }
  return { kind: "loaded", runtime };
}
