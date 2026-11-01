import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { decodeCodeThreadId, decodeProjectId } from "@octant/contracts";
import type { ToolEgressRules } from "../harness/nativeHarnessEgressRules";
import {
  ProviderRuntimeNetwork,
  type RuntimeNetworkReviewer,
} from "../network/providerRuntimeNetwork";
import { SafeNetworkStore } from "../network/safeNetworkStore";
import type { PersistenceService } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

/** The folder name managed worktrees sit under, beside the repository they come from. */
const MANAGED_WORKTREES_FOLDER = ".octant-worktrees";

/**
 * Safe networks and the provider runtime network. Both rebuild from the
 * journal here, before any provider launch is admitted. Runtimes run on the
 * proxy on macOS only: on Linux a runtime's private network namespace would
 * also cut the host loopback its tool bridge and OpenCode's own server use,
 * so Linux keeps open network for runtimes until the forwarder carries those
 * too (docs/architecture.md § Provider runtime network).
 */
export function wireRuntimeNetwork(input: {
  readonly persistence: Pick<
    PersistenceService,
    "journal" | "readProject" | "readProjects" | "readCodeThread"
  >;
  readonly toolEgressRules: Pick<ToolEgressRules, "projectRules" | "joinRecheck">;
  /** Octant Shield, for an unlisted host a runtime at Auto asks for. */
  readonly reviewer?: RuntimeNetworkReviewer;
  readonly platform?: NodeJS.Platform;
}) {
  const { persistence, toolEgressRules } = input;
  const projectExists = (projectId: string): boolean => {
    try {
      return persistence.readProject(decodeProjectId(projectId)) !== undefined;
    } catch {
      return false;
    }
  };
  const safeNetworkStore = new SafeNetworkStore({
    journal: persistence.journal,
    projectExists,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  safeNetworkStore.load();
  const providerRuntimeNetwork = new ProviderRuntimeNetwork({
    journal: persistence.journal,
    safeNetworks: safeNetworkStore,
    projectRules: (projectId) => toolEgressRules.projectRules(projectId),
    joinRecheck: (proxy) => toolEgressRules.joinRecheck(proxy),
    resolveProject: (root) => resolveRuntimeProject(persistence, root),
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
    enforced: (input.platform ?? process.platform) === "darwin",
    hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  providerRuntimeNetwork.load();
  return { safeNetworkStore, providerRuntimeNetwork, projectExists };
}

/**
 * The Project whose rules and places a runtime's folder gets: a managed
 * worktree's own thread's Project, else the active Work or Code Project whose
 * bound folder holds it. A folder no Project holds (a Chat scratch folder, a
 * probe's home) gets the account default and no Project rules.
 */
export function resolveRuntimeProject(
  persistence: Pick<PersistenceService, "readProjects" | "readCodeThread">,
  root: string,
): string | undefined {
  let folder = root;
  try {
    folder = realpathSync(root);
  } catch {
    // A folder that does not resolve is compared as written.
  }
  if (basename(dirname(dirname(folder))) === MANAGED_WORKTREES_FOLDER) {
    try {
      const thread = persistence.readCodeThread(decodeCodeThreadId(basename(folder)));
      if (thread !== undefined) return String(thread.projectId);
    } catch {
      // Not a thread id: fall through to the bound folders.
    }
  }
  let best: { readonly id: string; readonly length: number } | undefined;
  for (const project of persistence.readProjects()) {
    if (project.type === "chat" || project.lifecycle !== "active") continue;
    const bound = project.binding.canonicalRoot;
    if (folder !== bound && !folder.startsWith(bound.endsWith(sep) ? bound : `${bound}${sep}`)) {
      continue;
    }
    // The innermost bound folder wins when one Project's folder holds another's.
    if (best === undefined || bound.length > best.length) {
      best = { id: String(project.id), length: bound.length };
    }
  }
  return best?.id;
}
