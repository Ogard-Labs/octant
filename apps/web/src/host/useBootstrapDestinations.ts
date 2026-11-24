import {
  createRemoteProductFetch,
  readRemoteSessionStanding,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import {
  createRepositoryBootstrapClient,
  type RepositoryBootstrapClient,
} from "@octant/client-runtime/repository-bootstrap-client";
import type { HostId } from "@octant/contracts/host";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useEffect, useState } from "react";

const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";

export interface BootstrapDestinationTarget {
  readonly hostId: HostId;
  readonly displayName: string;
  readonly connected: boolean;
  readonly actsAsHostPerson: boolean;
  readonly bootstrapClient: RepositoryBootstrapClient;
  readonly projectClient: ProjectClient;
  /** Lowercased names and connected `owner/repo` keys already bound on that computer. */
  readonly boundRepositoryKeys: ReadonlySet<string>;
}

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

/** Canonical matching keys for comparing whether a Code Project is already bound on a destination computer. */
export function codeProjectRepositoryKeys(
  project: Pick<CodeProjectSummary, "name" | "connectedRepository">,
): ReadonlyArray<string> {
  const keys: string[] = [];
  if (project.connectedRepository !== undefined) {
    keys.push(
      `gh:${project.connectedRepository.owner.toLowerCase()}/${project.connectedRepository.repository.toLowerCase()}`,
    );
  }
  const normalizedName = project.name.trim().toLowerCase();
  if (normalizedName !== "") keys.push(`name:${normalizedName}`);
  return keys;
}

/** True when the destination computer does not already have this local Code Project bound. */
export function destinationNeedsProject(
  destination: BootstrapDestinationTarget,
  project: Pick<CodeProjectSummary, "name" | "connectedRepository">,
): boolean {
  const keys = codeProjectRepositoryKeys(project);
  if (keys.length === 0) return true;
  if (project.connectedRepository !== undefined) {
    const ghKey = `gh:${project.connectedRepository.owner.toLowerCase()}/${project.connectedRepository.repository.toLowerCase()}`;
    return !destination.boundRepositoryKeys.has(ghKey);
  }
  return !keys.some((key) => destination.boundRepositoryKeys.has(key));
}

export function createBootstrapTargetForBridge(input: {
  readonly hostId: HostId;
  readonly displayName: string;
  readonly bridge: RemoteSessionBridge;
  readonly connected: boolean;
  readonly actsAsHostPerson: boolean;
  readonly boundRepositoryKeys?: ReadonlySet<string>;
}): BootstrapDestinationTarget {
  const port = {
    baseUrl: REMOTE_CLIENT_BASE_URL,
    fetch: createRemoteProductFetch({ bridge: input.bridge }),
    windowCapability: "",
  };
  return {
    hostId: input.hostId,
    displayName: input.displayName,
    connected: input.connected,
    actsAsHostPerson: input.actsAsHostPerson,
    bootstrapClient: createRepositoryBootstrapClient(port),
    projectClient: createProjectClient(port),
    boundRepositoryKeys: input.boundRepositoryKeys ?? new Set(),
  };
}

/**
 * Tracks connected paired computers where this window acts as that computer's
 * own person (`actsAsHostPerson`), along with which Code Projects are already
 * bound on each computer. Refreshes cleanly when the transport list changes.
 */
export function useBootstrapDestinations(
  transports: HostFederationTransports | undefined,
  refreshKey?: number,
): ReadonlyArray<BootstrapDestinationTarget> {
  const [targets, setTargets] = useState<ReadonlyArray<BootstrapDestinationTarget>>([]);

  useEffect(() => {
    if (transports === undefined) {
      setTargets([]);
      return;
    }
    let active = true;
    const readySlots = transports
      .list()
      .filter(
        (slot): slot is typeof slot & { readonly bridge: RemoteSessionBridge } =>
          slot.kind === "remote" && slot.bridge !== undefined && slot.state.kind === "ready",
      );

    if (readySlots.length === 0) {
      setTargets([]);
      return;
    }

    void Promise.all(
      readySlots.map(async (slot): Promise<BootstrapDestinationTarget | undefined> => {
        const connection = slot.bridge.connection();
        if (connection === undefined) return undefined;
        const standing = await readRemoteSessionStanding(connection).catch(() => ({
          actsAsHostPerson: false,
        }));
        if (!standing.actsAsHostPerson) return undefined;

        const target = createBootstrapTargetForBridge({
          hostId: slot.hostId,
          displayName: slot.displayName,
          bridge: slot.bridge,
          connected: true,
          actsAsHostPerson: true,
        });
        const bootstrap = await target.projectClient.bootstrap().catch(() => undefined);
        const boundKeys = new Set<string>();
        for (const project of bootstrap?.active ?? []) {
          if (project.type !== "code") continue;
          for (const key of codeProjectRepositoryKeys(project)) boundKeys.add(key);
        }
        return { ...target, boundRepositoryKeys: boundKeys };
      }),
    ).then((resolved) => {
      if (!active) return;
      setTargets(resolved.filter((item): item is BootstrapDestinationTarget => item !== undefined));
    });

    return () => {
      active = false;
    };
  }, [transports, refreshKey]);

  return targets;
}
