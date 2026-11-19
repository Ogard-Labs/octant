import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useCallback, useState } from "react";
import { createRemoteProductClients } from "../remote/remoteProductClients";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

export interface RemoteTodoProject {
  readonly hostId: string;
  readonly hostName: string;
  readonly bridge: RemoteSessionBridge;
  readonly project: ProjectSummary;
}

export function useRemoteTodoProjects(
  transports: HostFederationTransports | undefined,
  revision: number,
): ReadonlyArray<RemoteTodoProject> {
  const [projects, setProjects] = useState<ReadonlyArray<RemoteTodoProject>>([]);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const results = await Promise.allSettled(
        (transports?.list() ?? []).flatMap((slot) => {
          if (slot.kind !== "remote" || slot.bridge === undefined || slot.state.kind !== "ready")
            return [];
          const bridge = slot.bridge;
          return [
            createRemoteProductClients(bridge)
              .project.bootstrap()
              .then((view) =>
                view.active
                  .filter((project) => project.lifecycle === "active")
                  .map((project) => ({
                    hostId: String(slot.hostId),
                    hostName: slot.displayName,
                    bridge,
                    project,
                  })),
              ),
          ];
        }),
      );
      if (!signal.aborted)
        setProjects(
          results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        );
    },
    [transports],
  );
  useVisibleRefresh(refresh, revision, 30_000);
  return projects;
}
