import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createProviderRuntimeEgress } from "../sshTarget/providerRuntimeEgress";
import { placeableRuntimesOn, type RemoteRuntimeSource } from "../sshTarget/sshRemoteCodeThreads";
import { SshTargetConnectionService } from "../sshTarget/sshTargetConnectionService";
import { SshTargetStore } from "../sshTarget/sshTargetStore";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";

export type SshTargetsDependencies = Pick<ServerStart, "persistence" | "version"> &
  Pick<ProvidersWiring, "configuredDriverOptions" | "providerDataDirectory">;

/**
 * SSH targets and this host's one session to each. Their local administration
 * (remote wiring) and the native harness's tools for a Project bound to a
 * remote root (harness wiring) share the same sessions, so a turn's tools
 * travel only on a session that attested and end with it.
 */
export function wireSshTargets(deps: SshTargetsDependencies) {
  const sshTargetStore = new SshTargetStore({
    journal: deps.persistence.journal,
    connection: deps.persistence.connection,
    dataDirectory: deps.providerDataDirectory,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  // A provider runtime placed on a target reaches the network only through
  // a proxy of its own on this host, as a harness command's does: on
  // loopback on macOS and as a Unix socket in a private directory on Linux.
  // Without one, no runtime is placed at all.
  const runtimeEgressDirectory = join(deps.providerDataDirectory, "harness", "egress");
  const runtimeEgressEndpoint =
    process.platform === "darwin"
      ? ({ kind: "loopback" } as const)
      : process.platform === "linux"
        ? ({ kind: "unix-socket", parentDirectory: runtimeEgressDirectory } as const)
        : undefined;
  if (runtimeEgressEndpoint?.kind === "unix-socket") {
    mkdirSync(runtimeEgressDirectory, { recursive: true, mode: 0o700 });
  }
  // The driver a turn of each enabled ACP instance would acquire, built as
  // the Code turn runtime builds it, so a target's status lists only the
  // agents a turn would place. A window reads the status every few seconds,
  // so a driver is built again only when its instance changes.
  const drivers = new Map<string, { readonly version: number; readonly driver: ProviderDriver }>();
  const runtimeSources = (): ReadonlyArray<RemoteRuntimeSource> => {
    const instances = deps.persistence.readProviderInstances();
    const listed = new Set(instances.map((instance) => String(instance.id)));
    for (const key of drivers.keys()) if (!listed.has(key)) drivers.delete(key);
    return instances.flatMap((instance) => {
      if (!instance.enabled || !isAcpAgentKind(instance.driverKind)) return [];
      const key = String(instance.id);
      const held = drivers.get(key);
      if (held?.version === instance.version) {
        return [{ providerInstanceId: instance.id, driver: held.driver }];
      }
      try {
        const driver = makeConfiguredProviderDriver(instance, deps.configuredDriverOptions);
        drivers.set(key, { version: instance.version, driver });
        return [{ providerInstanceId: instance.id, driver }];
      } catch {
        // An instance whose driver cannot be built runs no turn anywhere.
        return [];
      }
    });
  };
  const sshTargetConnections: SshTargetConnectionService = new SshTargetConnectionService({
    store: sshTargetStore,
    buildVersion: deps.version,
    placeableRuntimes: (targetId) =>
      placeableRuntimesOn(
        { connections: sshTargetConnections, store: sshTargetStore, runtimes: runtimeSources },
        targetId,
      ),
    ...(runtimeEgressEndpoint === undefined
      ? {}
      : {
          runtimeEgress: createProviderRuntimeEgress({
            journal: deps.persistence.journal,
            endpoint: runtimeEgressEndpoint,
            hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
            uuid: randomUUID,
            clock: () => new Date().toISOString(),
          }),
        }),
  });
  return { sshTargetStore, sshTargetConnections };
}

export type SshTargetsWiring = ReturnType<typeof wireSshTargets>;
