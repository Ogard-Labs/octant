import type { ProviderExecutionPolicy } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import type { RuntimeServerAccess } from "./runtimeServerAccess";

/**
 * The seam a provider runtime's launch reaches the Project's registered
 * servers through below Full access. Canonical: docs/architecture.md
 * § Octant Shield (provider runtimes' own commands).
 */
export interface ProviderServerAccessPort {
  /**
   * Opens the launch's server folder for the Project that owns `root`, with
   * `path` (the launch's own `PATH`) after the wrappers. Undefined when the
   * Project has no server a runtime can reach.
   */
  readonly open: (input: {
    readonly root: string;
    readonly path: string | undefined;
  }) => Promise<RuntimeServerAccess | undefined>;
}

/** What a launch adds: the folder to read and the variables to set. */
export interface ProviderServerAccess {
  readonly folder: string;
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Opens the folder for the life of the launch's scope, below Full access
 * only: at Full access the runtime uses the person's own SSH setup.
 * Anything that fails leaves the launch without it, as before.
 */
export function acquireProviderServerAccess(
  port: ProviderServerAccessPort | undefined,
  input: {
    readonly root: string;
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly path: string | undefined;
  },
): Effect.Effect<ProviderServerAccess | undefined, never, Scope.Scope> {
  if (port === undefined || input.executionPolicy === "full-access" || input.root === "") {
    return Effect.succeed(undefined);
  }
  return Effect.acquireRelease(
    Effect.promise(() =>
      port.open({ root: input.root, path: input.path }).catch(() => undefined),
    ),
    (opened) => (opened === undefined ? Effect.void : Effect.promise(() => opened.close())),
  ).pipe(
    Effect.map((opened) =>
      opened === undefined ? undefined : { folder: opened.folder, environment: opened.environment },
    ),
  );
}
