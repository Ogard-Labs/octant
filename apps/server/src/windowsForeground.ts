import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lstatSync } from "node:fs";
import { Cause, Effect, Exit, Option } from "effect";
import {
  acquireWindowsHostProfileOwner,
  createWindowsAuthorityStateFiles,
  createWindowsHostStartup,
  createWindowsListenerTlsFiles,
  createWindowsRosterSigningKeyFile,
  createWindowsServerIdentityFiles,
  createWindowsSqliteStores,
  decodeKeychainServiceFamily,
  KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
  loadWindowsHostProfileNative,
  makeWindowsCredentialStore,
  resolveReportedHostVersion,
  startCredentialBroker,
  type HostRuntimeBackupOutcome,
  type HostRuntimeDiagnostics,
  type WindowsCredentialNamespace,
} from "@octant/host-runtime";
import type { ServerLaunchConfig } from "./serverConfig";
import { configureSecretGuardLocations } from "./process/secretGuard";

/** Windows composes native authority directly; it never manufactures Unix runtime paths. */
export async function runWindowsForeground(
  launchConfig: ServerLaunchConfig,
  signal: AbortSignal,
  stop: () => void,
): Promise<void> {
  const nativePath = fileURLToPath(
    new URL("../../../../native/octant-windows-host-owner.node", import.meta.url),
  );
  const helperPath = fileURLToPath(
    new URL("../../../../native/octant-credential-helper.exe", import.meta.url),
  );
  const helperMetadata = lstatSync(helperPath);
  if (!helperMetadata.isFile() || helperMetadata.isSymbolicLink())
    throw new Error("The native Windows credential artifact is unavailable.");
  const native = loadWindowsHostProfileNative(nativePath);
  if (native === undefined) throw new Error("The native Windows host artifact is unavailable.");
  const family = decodeKeychainServiceFamily(process.env[KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]);
  if (family === undefined) throw new Error("The native Windows profile is unavailable.");
  const instanceId = launchConfig.instanceId ?? randomUUID();
  const version = resolveReportedHostVersion(process.env);
  let diagnostics: (() => HostRuntimeDiagnostics) | undefined;
  let backup: ((label?: string) => HostRuntimeBackupOutcome) | undefined;
  let startup: ReturnType<typeof createWindowsHostStartup>;
  const held = await acquireWindowsHostProfileOwner({
    native,
    profile: family === "octant" ? "octant" : "nightly-test-data",
    env: process.env,
    instanceId,
    serverVersion: version,
    wireVersion: "1",
    serviceMode: launchConfig.hostServiceMode,
    onStopRequested: stop,
    onControlRequest: async (request) => {
      if (request.type === "diagnostics")
        return diagnostics === undefined ? undefined : { diagnostics: diagnostics() };
      if (request.type === "logs")
        return startup === undefined ? undefined : { logs: await startup.logs.read(request) };
      if (request.type === "backup")
        return backup === undefined ? undefined : { backup: backup(request.label) };
      if (request.type === "restore")
        return {
          restore: {
            outcome: "refused-online",
            guidance: "Stop the Octant host before restoring its store.",
          },
        };
      return undefined;
    },
  });
  if (held.status !== "ready") throw new Error("The native Windows profile owner was refused.");
  if (held.ownership.kind === "attached") {
    console.info(
      `Octant attached to ${held.ownership.owner.serviceMode} owner ${held.ownership.owner.instanceId}.`,
    );
    return;
  }
  const owner = held.ownership;
  const paths = held.paths;
  let broker: Awaited<ReturnType<typeof startCredentialBroker>> | undefined;
  try {
    startup = createWindowsHostStartup(native, paths);
    const files = createWindowsSqliteStores(native, paths);
    const serverIdentityFiles = createWindowsServerIdentityFiles(native, paths);
    const listenerTlsFiles = createWindowsListenerTlsFiles(native, paths);
    const authorityStateFiles = createWindowsAuthorityStateFiles(native, paths);
    const rosterSigningKeyFile = createWindowsRosterSigningKeyFile(native, paths);
    if (
      startup === undefined ||
      files === undefined ||
      serverIdentityFiles === undefined ||
      listenerTlsFiles === undefined ||
      authorityStateFiles === undefined ||
      rosterSigningKeyFile === undefined
    )
      throw new Error("Native Windows host storage is unavailable.");
    const ownedStartup = startup;
    configureSecretGuardLocations({ dataDirectory: paths.dataDirectory });
    process.env.OCTANT_DATA_DIR = paths.dataDirectory;
    if (launchConfig.desktopBridgeSecret !== undefined)
      await ownedStartup.writeBridgeSecret(launchConfig.desktopBridgeSecret);
    const store = (namespace: WindowsCredentialNamespace) =>
      makeWindowsCredentialStore({
        helperPath,
        storeScope: paths.profileId,
        serviceFamily: family,
        namespace,
      });
    broker = await startCredentialBroker(
      store("provider"),
      undefined,
      undefined,
      store("replica-device-key"),
      store("replica-store-credential"),
      store("canvas-public-share-secret"),
      store("mcp-server-credential"),
      store("desktop-provider-credential"),
      store("push-platform-credential"),
      undefined,
      store("ssh-key"),
    );
    // Server/native persistence imports follow the actual native owner claim.
    const [
      { makePersistenceLive },
      { fatalStartupOutput, startOctantServer },
      { loadRuntimeServe },
    ] = await Promise.all([
      import("./persistence/persistenceService"),
      import("./server"),
      import("./serveRuntime"),
    ]);
    const serve = await loadRuntimeServe();
    const ownedBroker = broker;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startOctantServer({
          ...launchConfig,
          hostname: "127.0.0.1",
          instanceId,
          version,
          hostId: paths.profileId,
          controlEndpoint: owner.receipt.endpoint,
          platformCapabilities: [],
          serverIdentityFiles,
          listenerTlsFiles,
          authorityStateFiles,
          rosterSigningKeyFile,
          usageCacheFile: files.usageCache,
          credentialBrokerUrl: ownedBroker.url,
          credentialBrokerToken: ownedBroker.token,
          hostControl: {
            servicePolicy: ownedStartup.servicePolicy,
            requestOwnerStop: stop,
            readServiceLog: async () => (await ownedStartup.logs.read({ limit: 200 })).entries,
          },
          serve,
        });
        diagnostics = server.diagnostics;
        const serverBackup = server.backup;
        backup =
          serverBackup === undefined
            ? undefined
            : (label) => ({ outcome: "created", ...serverBackup(label) });
        yield* Effect.promise(() =>
          ownedStartup.writeHostInfo({
            schemaVersion: 1,
            hostId: paths.profileId,
            instanceId,
            url: server.url.toString(),
            controlEndpoint: owner.receipt.endpoint,
            serviceMode: launchConfig.hostServiceMode,
            serverVersion: version,
            wireVersion: "1",
            updatedAt: new Date().toISOString(),
          }),
        );
        yield* Effect.promise(() =>
          ownedStartup.logs.append({
            timestamp: new Date().toISOString(),
            level: "info",
            event: "server.ready",
            message: "Octant service owner is ready.",
          }),
        );
        console.info(`Octant server listening on ${server.url}`);
        return yield* Effect.never;
      }),
    ).pipe(Effect.provide(makePersistenceLive({ windowsProfile: { paths, files } })));
    const exit = await Effect.runPromiseExit(program, { signal });
    if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
      const failure =
        Option.getOrUndefined(Cause.failureOption(exit.cause)) ?? Cause.squash(exit.cause);
      console.error(fatalStartupOutput(failure));
      process.exitCode = 1;
    }
  } finally {
    await startup
      ?.clearProjections({
        instanceId,
        ...(launchConfig.desktopBridgeSecret === undefined
          ? {}
          : { bridgeSecret: launchConfig.desktopBridgeSecret }),
      })
      .catch(() => {
        console.error("The native Windows discovery cleanup could not be confirmed.");
        process.exitCode = 1;
      });
    try {
      await broker?.close();
    } finally {
      await owner.release();
    }
  }
}
