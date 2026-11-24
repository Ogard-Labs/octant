import {
  createRemoteProductFetch,
  readRemoteSessionStanding,
  type RemoteConnection,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import type {
  RepositoryBootstrapClient,
  RepositoryBootstrapClientOptions,
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
  readonly bootstrapPort?: RepositoryBootstrapClientOptions;
  readonly bootstrapClient?: RepositoryBootstrapClient;
  readonly projectClient: ProjectClient;
  /** Lowercased names and connected `owner/repo` keys already bound on that computer. */
  readonly boundRepositoryKeys: ReadonlySet<string>;
}

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

const connectionTokens = new WeakMap<RemoteConnection, number>();
let nextConnectionToken = 1;

function connectionIdentity(connection: RemoteConnection | undefined): number {
  if (connection === undefined) return 0;
  let token = connectionTokens.get(connection);
  if (token === undefined) {
    token = nextConnectionToken;
    nextConnectionToken += 1;
    connectionTokens.set(connection, token);
  }
  return token;
}

function readyRemoteSignature(transports: HostFederationTransports): string {
  const parts: string[] = [];
  for (const slot of transports.list()) {
    if (slot.kind !== "remote" || slot.bridge === undefined || slot.state.kind !== "ready") {
      continue;
    }
    parts.push(
      `${String(slot.hostId)}:${slot.displayName}:${String(connectionIdentity(slot.bridge.connection()))}`,
    );
  }
  return parts.sort().join("|");
}

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
  const port: RepositoryBootstrapClientOptions = {
    baseUrl: REMOTE_CLIENT_BASE_URL,
    fetch: createRemoteProductFetch({ bridge: input.bridge }),
    windowCapability: "",
  };
  return {
    hostId: input.hostId,
    displayName: input.displayName,
    connected: input.connected,
    actsAsHostPerson: input.actsAsHostPerson,
    bootstrapPort: port,
    projectClient: createProjectClient(port),
    boundRepositoryKeys: input.boundRepositoryKeys ?? new Set(),
  };
}

/**
 * Tracks connected paired computers where this window acts as that computer's
 * own person (`actsAsHostPerson`), along with which Code Projects are already
 * bound on each computer. Subscribes to transport updates so computers that
 * connect or reconnect after initial mount become eligible immediately.
 */
export function useBootstrapDestinations(
  transports: HostFederationTransports | undefined,
  refreshKey?: number,
): ReadonlyArray<BootstrapDestinationTarget> {
  const [targets, setTargets] = useState<ReadonlyArray<BootstrapDestinationTarget>>([]);
  const [readySignature, setReadySignature] = useState<string>(() =>
    transports === undefined ? "" : readyRemoteSignature(transports),
  );

  useEffect(() => {
    if (transports === undefined) {
      setReadySignature("");
      return;
    }
    const syncSignature = () => {
      const next = readyRemoteSignature(transports);
      setReadySignature((current) => (current === next ? current : next));
    };
    syncSignature();
    return transports.subscribe(syncSignature);
  }, [transports]);

  useEffect(() => {
    if (transports === undefined || readySignature === "") {
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
  }, [transports, readySignature, refreshKey]);

  return targets;
}

/** Lazy-mounted observer that keeps paired-computer destination discovery off the initial bundle. */
export function BootstrapDestinationsBridge(props: {
  readonly transports: HostFederationTransports;
  readonly refreshKey: number;
  readonly onTargetsChange: (targets: ReadonlyArray<BootstrapDestinationTarget>) => void;
}) {
  const targets = useBootstrapDestinations(props.transports, props.refreshKey);
  useEffect(() => {
    props.onTargetsChange(targets);
  }, [targets, props.onTargetsChange]);
  return null;
}
