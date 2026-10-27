import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ProviderFailure } from "@octant/contracts";
import { SshDeniedRootEntries, SshPlacedVariables } from "@octant/contracts/ssh-executor-protocol";
import type {
  ProviderPlacedAccountState,
  ProviderRemotePlacementPosture,
  ProviderRemotePlacementSupport,
  ProviderRemoteProcessPlacement,
} from "@octant/provider-sdk/driver";
import { Effect, Either, Fiber, Schema, Stream, type Scope } from "effect";
import { acpNegotiationAccepted, versionAtLeast, type AcpAgentConnection } from "./acpProcess";
import type { AcpHostAuthentication, AcpProviderProfile } from "./acpProfiles";
import { AcpFailure, makeAcpClient, type AcpClientCapabilities } from "./acpProtocol";

/**
 * ACP agents placed on a remote target the host reaches, such as an SSH
 * target. Canonical: docs/design/remote-ssh-environments.md § Runtime
 * placement (R4, and the rules 6c settled).
 *
 * An ACP agent speaks on its standard streams, so on a target it is spoken to
 * over the placed process's stream (`stdio`); its HTTP MCP bridge is a
 * listener and is never offered there. A placed launch names a program, its
 * arguments, home-relative account state, fixed variables, and denied root
 * entries, nothing more, so a profile is placed only where that is its whole
 * local launch: a variable that names a folder, a managed file, a host read,
 * or a denial in its sign-in folder would otherwise be silently left behind
 * on the target.
 */

/** The postures Octant confines a runtime in; Full access is never placed. */
const CONFINED_POSTURES: ReadonlyArray<ProviderRemotePlacementPosture> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
];

/**
 * A home the profile's launch functions are asked about only to see whether
 * they would set anything. No file is written there.
 */
const UNUSED_HOME = "/nonexistent/octant-placement";

/**
 * The folders a placed runtime finds under its own home on the target: the
 * target sets `HOME` to the runtime's home and no XDG folder, so a local
 * launch that points these at the managed home names the same folders there.
 */
const HOME_DEFAULT_FOLDERS: Readonly<Record<string, string>> = {
  HOME: "",
  XDG_CONFIG_HOME: ".config",
  XDG_CACHE_HOME: ".cache",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
};

// What a placed launch can carry is what the target's executor accepts; a
// profile that would be refused there declares nothing here instead.
const isPlacedVariables = Schema.is(SshPlacedVariables);
const isDeniedRootEntries = Schema.is(SshDeniedRootEntries);

/** The handshake crosses the SSH session twice, so it gets more time than a local one. */
const DEFAULT_PLACED_STARTUP_TIMEOUT_MS = 30_000;

/** How an ACP profile runs on a target: the driver's declaration and its launch. */
export interface AcpRemotePlacement {
  readonly support: ProviderRemotePlacementSupport;
  readonly args: ReadonlyArray<string>;
  readonly accountState: ReadonlyArray<ProviderPlacedAccountState>;
  /** The profile's guards, constants it sets in every launch. */
  readonly fixedVariables: Readonly<Record<string, string>>;
  /** The Project entries the local launch denies the agent. */
  readonly deniedRootEntries: ReadonlyArray<string>;
}

/**
 * Where an ACP profile can be placed, or undefined when it cannot be placed
 * anywhere. An instance that signs in with an API key or a browser sign-in
 * here is never placed, because provider credentials never reach a target; a
 * placed agent signs in with the target's own account state.
 */
export function acpRemotePlacement(
  profile: AcpProviderProfile,
  authentication: "provider-owned" | "subscription" | "api-key" | undefined,
  home: string = homedir(),
): AcpRemotePlacement | undefined {
  const remote = profile.process.remote;
  if (remote === undefined) return undefined;
  if (profile.authentication.kind !== "provider-owned") return undefined;
  if (authentication !== undefined && authentication !== "provider-owned") return undefined;
  const { process } = profile;
  const fixedVariables = process.guards;
  const deniedRootEntries = process.forbiddenRootEntries ?? [];
  if (
    !isPlacedVariables(Object.entries(fixedVariables).map(([name, value]) => ({ name, value }))) ||
    !isDeniedRootEntries(deniedRootEntries) ||
    (process.hostReadPaths ?? []).length > 0 ||
    (process.hostDeniedEntries ?? []).length > 0 ||
    // The refusal reads the root's files, which on a target name nothing here.
    profile.refusesProject !== undefined
  ) {
    return undefined;
  }
  const accountState = placedAccountState(process.hostAuthentication, home);
  if (accountState === "not-expressible") return undefined;
  if (
    accountState.some((state) => state.variable !== undefined && state.variable in fixedVariables)
  ) {
    return undefined;
  }
  const postures = CONFINED_POSTURES.filter(
    (posture) =>
      profile.refuses?.("code", posture) === undefined &&
      // A child server is a fork, which Plan's process filter refuses on a
      // target as it does here, where such a profile is refused Plan.
      !(process.requiresChildServer === true && posture === "plan") &&
      namesOnlyHomeDefaults(
        process.environment({ managedHome: UNUSED_HOME, executionPolicy: posture }),
      ) &&
      process.managedFiles({ managedHome: UNUSED_HOME, executionPolicy: posture }).length === 0,
  );
  if (postures.length === 0) return undefined;
  return {
    support: { postures, appToolTransport: "stdio" },
    args: remote.args,
    accountState,
    fixedVariables,
    deniedRootEntries,
  };
}

/** Whether every variable the local launch sets names a folder the runtime's home on the target already gives it. */
function namesOnlyHomeDefaults(environment: Readonly<Record<string, string>>): boolean {
  return Object.entries(environment).every(([name, value]) => {
    const folder = HOME_DEFAULT_FOLDERS[name];
    return folder !== undefined && value === join(UNUSED_HOME, folder);
  });
}

/**
 * The profile's sign-in folder as account state on the target: the same path
 * under the remote user's home, read-write as the local launch grants it, and
 * named by the variable the profile points the agent at it with. A placed
 * agent's `HOME` is its own runtime home, so a folder no variable names would
 * never be found; a credential file the local launch links into its managed
 * home, a variable that is not the folder itself, or entries the local launch
 * denies inside it cannot be stated on the target.
 */
function placedAccountState(
  authentication: AcpHostAuthentication | undefined,
  home: string,
): ReadonlyArray<ProviderPlacedAccountState> | "not-expressible" {
  if (authentication === undefined) return [];
  if (authentication.kind !== "directory") return "not-expressible";
  if ((authentication.forbiddenEntries ?? []).length > 0) return "not-expressible";
  const path = relative(home, authentication.defaultPath);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return "not-expressible";
  const variables = Object.entries(authentication.environment?.(authentication.defaultPath) ?? {});
  const [named] = variables;
  if (variables.length !== 1 || named === undefined) return "not-expressible";
  const [variable, value] = named;
  if (value !== authentication.defaultPath) return "not-expressible";
  return [{ path, access: "read-write", variable }];
}

export interface AcpPlacedProcessStartInput {
  readonly profile: AcpProviderProfile;
  readonly placement: ProviderRemoteProcessPlacement;
  readonly launch: Pick<
    AcpRemotePlacement,
    "args" | "accountState" | "fixedVariables" | "deniedRootEntries"
  >;
  /** The bound root as the target names it. */
  readonly root: string;
  readonly clientCapabilities: AcpClientCapabilities;
}

/** Starts an ACP agent through a remote placement and negotiates ACP with it. */
export interface AcpPlacedProcessPort {
  readonly start: (
    input: AcpPlacedProcessStartInput,
  ) => Effect.Effect<AcpAgentConnection, ProviderFailure, Scope.Scope>;
}

function failure(
  category: ProviderFailure["category"],
  message: string,
  extras: Pick<ProviderFailure, "reason" | "diagnostic"> = {},
): ProviderFailure {
  return { category, message, ...extras };
}

/**
 * The agent runs only through the placement, at the path the person set for
 * this target; a refused or lost launch fails the start, and nothing runs on
 * this host instead. Its version is the one its own `initialize` answer
 * reports, because no version probe runs on the target, and an agent that
 * reports none, or one below the profile's minimum, is refused.
 */
export function makeAcpPlacedProcessLive(
  options: { readonly startupTimeoutMs?: number } = {},
): AcpPlacedProcessPort {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_PLACED_STARTUP_TIMEOUT_MS;
  return {
    start: (input) =>
      Effect.gen(function* () {
        const { profile } = input;
        const name = profile.displayName;
        const placed = yield* input.placement.launch({
          executable: input.placement.executable,
          args: input.launch.args,
          ...(input.launch.accountState.length === 0
            ? {}
            : { accountState: input.launch.accountState }),
          ...(Object.keys(input.launch.fixedVariables).length === 0
            ? {}
            : { fixedVariables: input.launch.fixedVariables }),
          ...(input.launch.deniedRootEntries.length === 0
            ? {}
            : { deniedRootEntries: input.launch.deniedRootEntries }),
        });
        const stdout = new PassThrough();
        // The output ends when the process does, which the launch's own
        // release brings about. Waiting for this reader to stop before that
        // release would wait on output that only the release can end, so the
        // scope only asks it to stop and does not wait (a hang seen against
        // the loopback target, whose stream yields nothing until then).
        const forwarding = yield* Effect.forkDaemon(
          Stream.runForEach(placed.output, (chunk) =>
            Effect.sync(() => {
              stdout.write(chunk);
            }),
          ).pipe(Effect.ensuring(Effect.sync(() => stdout.end()))),
        );
        yield* Effect.addFinalizer(() => Fiber.interruptFork(forwarding));
        const stdin = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            void Effect.runPromise(Effect.either(placed.write(new Uint8Array(chunk)))).then(
              (written) =>
                callback(Either.isLeft(written) ? new Error(written.left.message) : null),
            );
          },
        });
        // Each write's own callback carries its failure to the ACP client. The
        // client stops listening for stream errors once it is closed, so a write
        // still crossing the session then, failed by a session that ended, would
        // otherwise be an unhandled stream error that takes this host down.
        stdin.on("error", () => undefined);
        const acp = makeAcpClient({
          stdin,
          stdout,
          limits: { requestTimeoutMs: startupTimeoutMs },
        });
        // Added after the launch, so it runs first: the agent's input closes
        // before the target is asked to stop it.
        yield* Effect.addFinalizer(() => Effect.promise(() => acp.close().catch(() => undefined)));
        const exited = Promise.race([
          Effect.runPromise(placed.ended),
          acp.exited.catch((error: unknown) => Promise.reject(error)),
        ]).then(() => undefined);
        void exited.catch(() => undefined);
        const initialized = yield* Effect.tryPromise({
          try: () => acp.initialize(input.clientCapabilities),
          catch: (error) =>
            error instanceof AcpFailure && error.kind === "timeout"
              ? failure("unavailable", `${name} ACP initialization timed out on the target.`)
              : error instanceof AcpFailure && error.kind === "closed"
                ? failure("unavailable", `${name} ACP process exited during startup on the target.`)
                : failure("protocol", `${name} ACP initialization failed on the target.`),
        });
        if (!acpNegotiationAccepted(profile, initialized)) {
          return yield* Effect.fail(
            failure("incompatible", `${name} ACP negotiation was incompatible.`),
          );
        }
        const reported = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u.exec(
          initialized.agentInfo?.version ?? "",
        );
        const minimum = profile.process.minimumVersion;
        if (reported === null) {
          return yield* Effect.fail(
            failure("incompatible", `${name} on the target did not report its version.`, {
              reason: "runtime-incompatible",
            }),
          );
        }
        const current = [Number(reported[1]), Number(reported[2]), Number(reported[3])] as const;
        const version = current.join(".");
        if (!versionAtLeast(current, minimum)) {
          return yield* Effect.fail(
            failure("incompatible", `${name} ${minimum.join(".")} or later is required.`, {
              reason: "runtime-incompatible",
              diagnostic: {
                stage: "version-check",
                kind: "version-mismatch",
                detectedVersion: version,
                supportedVersion: minimum.join("."),
              },
            }),
          );
        }
        return { version, root: input.root, initialized, acp, exited };
      }),
  };
}
