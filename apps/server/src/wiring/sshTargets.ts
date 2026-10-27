import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createProviderRuntimeEgress } from "../sshTarget/providerRuntimeEgress";
import { SshTargetConnectionService } from "../sshTarget/sshTargetConnectionService";
import { SshTargetStore } from "../sshTarget/sshTargetStore";
import type { ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";

export type SshTargetsDependencies = Pick<ServerStart, "persistence" | "version"> &
  Pick<ProvidersWiring, "providerDataDirectory">;

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
  const sshTargetConnections = new SshTargetConnectionService({
    store: sshTargetStore,
    buildVersion: deps.version,
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
