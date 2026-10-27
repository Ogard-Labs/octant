import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ProjectId } from "@octant/contracts/projects";
import type { SshTargetStatus } from "@octant/contracts/ssh-target";
import { createSshTargetClient } from "../host/sshTargetClient";
import { sshTargetAdministrationOf, type OctantHostBridge } from "../shell/hostBridge";
import type { ComposerProjectEntry } from "./ComposerProjectSelector";

/**
 * The Code Projects bound to folders on this host's SSH targets, as a desktop
 * window reads them through its main process. Canonical:
 * docs/design/remote-ssh-environments.md § Remote-bound Code threads.
 *
 * The window only shows what the host reported: each Project, where it is,
 * and its target's connection and admission now. It grants nothing; the host
 * binds the window, creates the thread, and admits every turn itself.
 */
export interface RemoteCodeProject {
  readonly projectId: ProjectId;
  readonly name: string;
  /** `destination:folder`, as the target names it. */
  readonly location: string;
  /** The target's `user@host`, absent once the target was removed. */
  readonly destination?: string;
  /** The host's status of the Project's target, absent once it was removed. */
  readonly target?: SshTargetStatus;
}

export interface RemoteCodeProjects {
  readonly projects: ReadonlyArray<RemoteCodeProject>;
  /** Reads the host again, as after the person connects a target. */
  readonly refresh: () => void;
}

const NONE: RemoteCodeProjects = { projects: [], refresh: () => undefined };

/** What every surface of a window reads; one source per window polls the host. */
export const RemoteCodeProjectsContext = createContext<RemoteCodeProjects>(NONE);

export function useRemoteCodeProjects(): RemoteCodeProjects {
  return useContext(RemoteCodeProjectsContext);
}

export function remoteCodeProjectFor(
  projects: ReadonlyArray<RemoteCodeProject>,
  projectId: ProjectId | string | undefined,
): RemoteCodeProject | undefined {
  if (projectId === undefined) return undefined;
  return projects.find((project) => String(project.projectId) === String(projectId));
}

/**
 * A target's connection changes outside any request this window makes (a
 * session drops, the person connects it in Settings), so the source reads
 * the host again on this cadence while it has Projects to report on.
 */
const REMOTE_PROJECT_REFRESH_MS = 5_000;
const REMOTE_PROJECT_DISCOVERY_MS = 30_000;

/**
 * Reads the remote-bound Projects and their targets' status. Only a desktop
 * window can read them; any other window, or a read that fails, has none.
 */
export function useRemoteCodeProjectsSource(
  bridge: OctantHostBridge | undefined,
): RemoteCodeProjects {
  const request = sshTargetAdministrationOf(bridge)?.sshTargetRequest;
  const client = useMemo(
    () =>
      request === undefined ? undefined : createSshTargetClient({ sshTargetRequest: request }),
    [request],
  );
  const [projects, setProjects] = useState<ReadonlyArray<RemoteCodeProject>>([]);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    if (client === undefined) {
      setProjects([]);
      return;
    }
    let current = true;
    void Promise.all([client.projects(), client.list()]).then(([listed, targets]) => {
      if (!current) return;
      if (listed.status !== "ok") {
        setProjects((previous) => (previous.length === 0 ? previous : []));
        return;
      }
      const statuses = new Map(
        (targets.status === "ok" ? targets.value : []).map((status) => [
          String(status.target.id),
          status,
        ]),
      );
      const next = listed.value.map((project): RemoteCodeProject => {
        const target = statuses.get(String(project.targetId));
        return {
          projectId: project.id,
          name: project.name,
          location: `${target?.target.destination ?? "Removed target"}:${project.remoteRoot}`,
          ...(target === undefined ? {} : { destination: target.target.destination, target }),
        };
      });
      // An unchanged answer keeps its identity, so a poll that found nothing
      // new re-renders nothing that reads it.
      setProjects((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    });
    return () => {
      current = false;
    };
  }, [client, revision]);
  // With no remote-bound Project yet there is no connection to follow, only a
  // binding made in Settings to notice, so the window looks far less often.
  const interval =
    client === undefined
      ? undefined
      : projects.length > 0
        ? REMOTE_PROJECT_REFRESH_MS
        : REMOTE_PROJECT_DISCOVERY_MS;
  useEffect(() => {
    if (interval === undefined) return;
    const timer = window.setInterval(refresh, interval);
    return () => window.clearInterval(timer);
  }, [interval, refresh]);
  return useMemo(() => ({ projects, refresh }), [projects, refresh]);
}

/** The composer's Project picker rows for the remote-bound Projects. */
export function remoteProjectEntries(
  projects: ReadonlyArray<RemoteCodeProject>,
): ReadonlyArray<ComposerProjectEntry> {
  return projects.map((project) => ({
    kind: "remote-project",
    projectId: project.projectId,
    displayName: project.name,
    location: project.location,
  }));
}
