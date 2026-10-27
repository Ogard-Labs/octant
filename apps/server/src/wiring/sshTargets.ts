import { randomUUID } from "node:crypto";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
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
  const sshTargetConnections = new SshTargetConnectionService({
    store: sshTargetStore,
    buildVersion: deps.version,
  });
  return { sshTargetStore, sshTargetConnections };
}

export type SshTargetsWiring = ReturnType<typeof wireSshTargets>;
