import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ServerProjectsClient } from "@octant/client-runtime/server-projects-client";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type { BindingRevisionId, ProjectId } from "@octant/contracts/projects";
import type { ComposerProjectEntry } from "./ComposerProjectSelector";

/**
 * The Code and Work Projects bound to a folder on one of the person's registered
 * servers, as the host's server Project catalog lists them. Canonical:
 * docs/design/server-projects.md.
 *
 * The window only shows what the host reported. It grants nothing: the host
 * binds the window, creates the thread, and refuses whatever a server Project
 * does not take.
 */
export interface ServerCodeProject {
  readonly projectId: ProjectId;
  readonly name: string;
  /** `alias:folder`, or the folder alone once the server left the registry. */
  readonly location: string;
}

/** A Work Project on a server, with the binding its Work threads are created against. */
export interface ServerWorkProject extends ServerCodeProject {
  readonly bindingRevisionId: BindingRevisionId;
}

export interface ServerCodeProjects {
  readonly projects: ReadonlyArray<ServerCodeProject>;
  readonly workProjects: ReadonlyArray<ServerWorkProject>;
  /** Reads the host again, as after the person binds a folder in Settings. */
  readonly refresh: () => void;
}

const NONE: ServerCodeProjects = { projects: [], workProjects: [], refresh: () => undefined };

/** What every surface of a window reads; one source per window polls the host. */
export const ServerCodeProjectsContext = createContext<ServerCodeProjects>(NONE);

export function useServerCodeProjects(): ServerCodeProjects {
  return useContext(ServerCodeProjectsContext);
}

export function serverCodeProjectFor<Project extends ServerCodeProject>(
  projects: ReadonlyArray<Project>,
  projectId: ProjectId | string | undefined,
): Project | undefined {
  if (projectId === undefined) return undefined;
  return projects.find((project) => String(project.projectId) === String(projectId));
}

/** The catalog changes outside any request this window makes (Settings binds a folder). */
const SERVER_PROJECT_REFRESH_MS = 15_000;

/** Reads the server Projects and the registry that names their servers. */
export function useServerCodeProjectsSource(
  client: Pick<ServerProjectsClient, "read"> | undefined,
  servers: Pick<ShieldServersClient, "read"> | undefined,
): ServerCodeProjects {
  const [projects, setProjects] = useState<ReadonlyArray<ServerCodeProject>>([]);
  const [workProjects, setWorkProjects] = useState<ReadonlyArray<ServerWorkProject>>([]);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    if (client === undefined) {
      setProjects([]);
      setWorkProjects([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const [view, registry] = await Promise.all([
          client.read(controller.signal),
          servers === undefined
            ? Promise.resolve(undefined)
            : servers.read(undefined, controller.signal).catch(() => undefined),
        ]);
        if (controller.signal.aborted) return;
        const aliases = new Map(
          (registry?.servers ?? []).map((server) => [String(server.serverId), server.alias]),
        );
        const entryOf = (project: (typeof view.projects)[number]): ServerCodeProject => {
          const alias = aliases.get(String(project.serverId));
          return {
            projectId: project.id,
            name: project.name,
            location: alias === undefined ? project.folder : `${alias}:${project.folder}`,
          };
        };
        // A Work Project on a server holds Work threads, never Code ones.
        const next = view.projects.filter((project) => project.mode !== "work").map(entryOf);
        const nextWork = view.projects.flatMap(
          (project): ReadonlyArray<ServerWorkProject> =>
            project.mode === "work" && project.workBindingRevisionId !== undefined
              ? [{ ...entryOf(project), bindingRevisionId: project.workBindingRevisionId }]
              : [],
        );
        // An unchanged answer keeps its identity, so a poll that found nothing
        // new re-renders nothing that reads it.
        setProjects((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        setWorkProjects((previous) =>
          JSON.stringify(previous) === JSON.stringify(nextWork) ? previous : nextWork,
        );
      } catch {
        if (controller.signal.aborted) return;
        setProjects((previous) => (previous.length === 0 ? previous : []));
        setWorkProjects((previous) => (previous.length === 0 ? previous : []));
      }
    })();
    return () => controller.abort();
  }, [client, servers, revision]);
  useEffect(() => {
    if (client === undefined) return;
    const timer = window.setInterval(refresh, SERVER_PROJECT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [client, refresh]);
  return useMemo(() => ({ projects, workProjects, refresh }), [projects, workProjects, refresh]);
}

/** The composer's Project picker rows for the server Projects. */
export function serverProjectEntries(
  projects: ReadonlyArray<ServerCodeProject>,
): ReadonlyArray<ComposerProjectEntry> {
  return projects.map((project) => ({
    kind: "server-project",
    projectId: project.projectId,
    displayName: project.name,
    location: project.location,
  }));
}
