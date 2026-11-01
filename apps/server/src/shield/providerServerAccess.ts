import type { ProviderExecutionPolicy } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import { seatbeltAllowMachLookupRule } from "../process/seatbeltProfile";
import type { RuntimeServerAccess } from "./runtimeServerAccess";

/**
 * The seam a provider runtime's launch reaches the Project's registered
 * servers through below Full access. Canonical: docs/architecture.md
 * § Octant Shield (provider runtimes' own commands).
 */
export interface ProviderServerAccessPort {
  /**
   * Opens the launch's server folder for the Project that owns `root`.
   * Undefined when the Project has no server a runtime can reach.
   */
  readonly open: (root: string) => Promise<RuntimeServerAccess | undefined>;
}

/** What a launch adds: a folder to read, wrappers first on `PATH`, and its agent socket. */
export type ProviderServerAccess = Pick<
  RuntimeServerAccess,
  "folder" | "binDirectory" | "agentSocket"
>;

/**
 * Opens the folder for the life of the launch's scope, below Full access
 * only: at Full access the runtime uses the person's own SSH setup.
 * Anything that fails leaves the launch without it, as before.
 */
export function acquireProviderServerAccess(
  port: ProviderServerAccessPort | undefined,
  input: { readonly root: string; readonly executionPolicy: ProviderExecutionPolicy },
): Effect.Effect<ProviderServerAccess | undefined, never, Scope.Scope> {
  // Plan runs no shell on any runtime, so it gets nothing to reach a server with.
  if (
    port === undefined ||
    input.executionPolicy === "full-access" ||
    input.executionPolicy === "plan" ||
    input.root === ""
  ) {
    return Effect.succeed(undefined);
  }
  return Effect.acquireRelease(
    Effect.promise(() => port.open(input.root).catch(() => undefined)),
    (opened) => (opened === undefined ? Effect.void : Effect.promise(() => opened.close())),
  ).pipe(
    Effect.map((opened) =>
      opened === undefined
        ? undefined
        : {
            folder: opened.folder,
            binDirectory: opened.binDirectory,
            agentSocket: opened.agentSocket,
          },
    ),
  );
}

/**
 * What a macOS runtime profile adds for the folder: `ssh` looks up the
 * person's own account before it connects, and inside the profile stopped
 * with "No user exists for uid" until the user database was reachable.
 */
export function serverAccessSeatbeltRules(
  servers: ProviderServerAccess | undefined,
): ReadonlyArray<string> {
  return servers === undefined
    ? []
    : [seatbeltAllowMachLookupRule("com.apple.system.opendirectoryd.libinfo")];
}

const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The launch's environment with the wrappers first on its `PATH` and the agent socket set. */
export function withServerAccess(
  environment: NodeJS.ProcessEnv,
  servers: ProviderServerAccess | undefined,
): NodeJS.ProcessEnv {
  if (servers === undefined) return environment;
  const path = environment.PATH;
  return {
    ...environment,
    // A launch with no `PATH` keeps the system's default after the wrappers.
    PATH: `${servers.binDirectory}:${path === undefined || path === "" ? DEFAULT_PATH : path}`,
    SSH_AUTH_SOCK: servers.agentSocket,
  };
}
