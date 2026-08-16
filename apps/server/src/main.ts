import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import {
  acquireHostRuntimeOwner,
  availablePlatformCapabilityNames,
  BoundedHostLogStore,
  clearHostRuntimeProjections,
  deriveHostRuntimeHostId,
  prepareHostRuntimePaths,
  formatHostRuntimeError,
  probeHostPlatformCapabilities,
  readHostRuntimeProcessStart,
  resolveHostRuntimePaths,
  ServicePolicyStore,
  writeHostInfoReceipt,
  writeBridgeSecretProjection,
  type HostRuntimeBackupOutcome,
  type HostRuntimeControlPayload,
  type HostRuntimeDiagnostics,
  type HostRuntimeLocalControlRequest,
  type HostRuntimeOwner,
  type HostRuntimePaths,
} from "@octant/host-runtime";
import { parseServerLaunchConfig } from "./serverConfig";
import { runStartupArtifactInspection } from "./startupArtifactInspection";
import { watchDesktopParent } from "./desktopParentWatch";

// Validate launch config before loading server modules that transitively
// import native dependencies (node-pty). This makes the packaged-runtime
// dev-bootstrap guard observable in the real built artifact, even in
// environments where node-pty's NAPI module crashes Bun at import time.
const launchConfig = parseServerLaunchConfig(process.env);
const abortController = new AbortController();
const stop = () => abortController.abort();
const stopWatchingDesktopParent = watchDesktopParent({
  enabled: process.env.OCTANT_DESKTOP_PARENT_WATCH === "1",
  input: process.stdin,
  onDisconnect: stop,
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let owner: HostRuntimeOwner | undefined;
let ownerPaths: HostRuntimePaths | undefined;
let diagnostics: (() => HostRuntimeDiagnostics) | undefined;
let ownerBackup: ((label?: string) => HostRuntimeBackupOutcome) | undefined;
let serviceLogs: BoundedHostLogStore | undefined;

try {
  // Packaged-artifact startup inspection runs before ownership and before any
  // native/persistence module loads. A rejected artifact never binds the owner
  // socket and never touches the store.
  const artifactInspection = await runStartupArtifactInspection({ env: process.env });
  if (artifactInspection !== undefined && !artifactInspection.ok) {
    console.error(
      `Octant refused to start from this artifact: ${artifactInspection.rejection.code}.`,
    );
    process.exit(1);
  }
  const paths = resolveHostRuntimePaths({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    temporaryDirectory: canonicalTemporaryDirectory(),
    uid: process.getuid?.() ?? 0,
  });
  ownerPaths = paths;
  await prepareHostRuntimePaths(paths);
  const hostLogs = new BoundedHostLogStore({ path: paths.serviceLogPath });
  serviceLogs = hostLogs;
  process.env.OCTANT_DATA_DIR = paths.dataDirectory;
  const instanceId = launchConfig.instanceId ?? randomUUID();
  const hostId = deriveHostRuntimeHostId(paths.dataDirectory);
  const serverVersion = process.env.npm_package_version ?? "0.0.0-dev";
  const ownership = await acquireHostRuntimeOwner({
    paths,
    hostId,
    instanceId,
    serverVersion,
    wireVersion: "1",
    serviceMode: launchConfig.hostServiceMode,
    processStart: await readHostRuntimeProcessStart(process.pid),
    onStopRequested: stop,
    onControlRequest: async (
      request: HostRuntimeLocalControlRequest,
    ): Promise<HostRuntimeControlPayload | undefined> => {
      if (request.type === "diagnostics") {
        return diagnostics === undefined ? undefined : { diagnostics: diagnostics() };
      }
      if (request.type === "logs") {
        return {
          logs: await hostLogs.read({
            ...(request.since === undefined ? {} : { since: request.since }),
            ...(request.limit === undefined ? {} : { limit: request.limit }),
            ...(request.follow === undefined ? {} : { follow: request.follow }),
          }),
        };
      }
      if (request.type === "backup") {
        return ownerBackup === undefined ? undefined : { backup: ownerBackup(request.label) };
      }
      if (request.type === "restore") {
        // Destructive restore never runs against a live store: it requires an
        // offline exclusive owner lease with typed confirmation.
        return {
          restore: {
            outcome: "refused-online",
            guidance: "Stop the Octant host, then run the offline restore command with --confirm.",
          },
        };
      }
      return undefined;
    },
  });

  if (ownership.kind === "attached") {
    console.info(
      `Octant attached to ${ownership.owner.serviceMode} owner ${ownership.owner.instanceId}.`,
    );
  } else {
    owner = ownership;
    if (launchConfig.desktopBridgeSecret !== undefined) {
      await writeBridgeSecretProjection(paths, launchConfig.desktopBridgeSecret);
    }
    // Dynamically import server and persistence modules only after the control socket is bound.
    // Native dependencies and SQLite therefore cannot initialize before runtime ownership.
    const [{ PersistenceLive }, { fatalStartupOutput, startOctantServer }, { loadRuntimeServe }] =
      await Promise.all([
        import("./persistence/persistenceService"),
        import("./server"),
        import("./serveRuntime"),
      ]);
    const serve = await loadRuntimeServe();
    // Honest platform capability observation: only tools whose probe succeeded
    // are reported; unavailable native tools fail closed out of the report.
    const platformCapabilityReport = await probeHostPlatformCapabilities({
      platform: process.platform,
      uid: paths.uid,
    });
    const program = Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startOctantServer({
          hostname: "127.0.0.1",
          ...launchConfig,
          version: serverVersion,
          instanceId,
          hostId,
          controlEndpoint: paths.socketPath,
          serviceMode: launchConfig.hostServiceMode,
          platformCapabilities: availablePlatformCapabilityNames(platformCapabilityReport).map(
            (name) => `platform:${name}`,
          ),
          // The web Settings host card acts through the same authority as the
          // owner control socket: policy writes go to the shared service
          // policy store and stop/restart request this owner's graceful drain.
          hostControl: {
            servicePolicy: new ServicePolicyStore({ path: paths.servicePolicyPath }),
            requestOwnerStop: stop,
          },
          serve,
        });
        diagnostics = server.diagnostics;
        const serverBackup = server.backup;
        ownerBackup =
          serverBackup === undefined
            ? undefined
            : (label) => ({ outcome: "created", ...serverBackup(label) });
        yield* Effect.promise(() =>
          writeHostInfoReceipt(paths, {
            schemaVersion: 1,
            hostId,
            instanceId,
            url: server.url.toString(),
            controlEndpoint: paths.socketPath,
            serviceMode: launchConfig.hostServiceMode,
            serverVersion,
            wireVersion: "1",
            updatedAt: new Date().toISOString(),
          }),
        );
        yield* Effect.promise(() =>
          hostLogs.append({
            timestamp: new Date().toISOString(),
            level: "info",
            event: "server.ready",
            message: "Octant service owner is ready.",
          }),
        );
        console.info(`Octant server listening on ${server.url}`);
        return yield* Effect.never;
      }).pipe(Effect.provide(PersistenceLive)),
    );
    const exit = await Effect.runPromiseExit(program, { signal: abortController.signal });
    if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
      const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
      console.error(fatalStartupOutput(failure));
      process.exitCode = 1;
    }
  }
} catch (error) {
  await serviceLogs
    ?.append({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "server.failure",
      message: formatHostRuntimeError(error),
    })
    .catch(() => undefined);
  console.error(formatHostRuntimeError(error));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  stopWatchingDesktopParent();
  if (owner !== undefined && ownerPaths !== undefined) {
    await clearHostRuntimeProjections(ownerPaths, {
      instanceId: owner.receipt.instanceId,
      bridgeSecret: launchConfig.desktopBridgeSecret,
    }).catch(() => undefined);
    await owner.release();
  }
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}
