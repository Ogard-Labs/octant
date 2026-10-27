import { useEffect, useMemo, useState } from "react";
import { createSshTargetClient } from "../host/sshTargetClient";
import { sshTargetAdministrationOf, type OctantHostBridge } from "../shell/hostBridge";
import type { ComposerProjectEntry } from "./ComposerProjectSelector";

/**
 * Why a remote-bound Project cannot be chosen for a new thread yet: its
 * terminals and worktrees run on the target, and its threads arrive with the
 * Code turn runtime's remote composition.
 */
export const REMOTE_PROJECT_THREADS_UNAVAILABLE =
  "Threads on SSH targets are not available yet. Open its terminal in Settings › SSH targets.";

/**
 * The Code Projects bound to folders on this host's SSH targets, as the
 * composer's Project picker lists them. Only a desktop window can read them;
 * any other window, or a read that fails, lists none.
 */
export function useSshRemoteProjectEntries(
  bridge: OctantHostBridge | undefined,
): ReadonlyArray<ComposerProjectEntry> {
  const administration = sshTargetAdministrationOf(bridge);
  const request = administration?.sshTargetRequest;
  const client = useMemo(
    () =>
      request === undefined ? undefined : createSshTargetClient({ sshTargetRequest: request }),
    [request],
  );
  const [entries, setEntries] = useState<ReadonlyArray<ComposerProjectEntry>>([]);
  useEffect(() => {
    if (client === undefined) {
      setEntries([]);
      return;
    }
    let current = true;
    void Promise.all([client.projects(), client.list()]).then(([projects, targets]) => {
      if (!current || projects.status !== "ok") return;
      const destinations = new Map(
        (targets.status === "ok" ? targets.value : []).map((status) => [
          String(status.target.id),
          status.target.destination,
        ]),
      );
      setEntries(
        projects.value.map((project) => ({
          kind: "remote-project",
          projectId: project.id,
          displayName: project.name,
          location: `${destinations.get(String(project.targetId)) ?? "Removed target"}:${project.remoteRoot}`,
          disabledReason: REMOTE_PROJECT_THREADS_UNAVAILABLE,
        })),
      );
    });
    return () => {
      current = false;
    };
  }, [client]);
  return entries;
}
