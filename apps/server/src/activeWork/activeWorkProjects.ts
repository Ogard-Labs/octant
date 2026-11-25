import type { ProjectSummary } from "@octant/contracts/projects";

/**
 * How long a Project's GitHub repository is trusted. Reading it observes every
 * Code Project's Git remotes, which a list that refreshes on every change must
 * not do each time; a repository a remote change moves shows a minute late.
 */
const REPOSITORY_MAX_AGE_MS = 60_000;

type StoredProject = Pick<ProjectSummary, "id" | "type" | "name" | "lifecycle">;

/**
 * Active work's Projects by id: each name and lifecycle as stored, read at
 * every call, and the repository from a Projects read at most once a minute.
 * A failed repository read leaves repositories out rather than the Projects.
 */
export function createActiveWorkProjects<T extends StoredProject>(sources: {
  readonly readProjects: () => ReadonlyArray<T>;
  readonly bootstrap: () => Promise<{ readonly active: ReadonlyArray<ProjectSummary> }>;
  readonly now?: () => number;
}): () => Promise<
  ReadonlyMap<string, T | (T & Pick<ProjectSummary & { type: "code" }, "connectedRepository">)>
> {
  const now = sources.now ?? Date.now;
  let repositories:
    | { readonly at: number; readonly byProject: ReadonlyMap<string, unknown> }
    | undefined;
  let reading: Promise<void> | undefined;
  const refresh = async () => {
    const at = now();
    try {
      const { active } = await sources.bootstrap();
      repositories = {
        at,
        byProject: new Map(
          active.flatMap((project) =>
            project.type === "code" && project.connectedRepository !== undefined
              ? [[String(project.id), project.connectedRepository] as const]
              : [],
          ),
        ),
      };
    } catch {
      repositories = { at, byProject: repositories?.byProject ?? new Map() };
    }
  };
  return async () => {
    if (repositories === undefined || now() - repositories.at >= REPOSITORY_MAX_AGE_MS) {
      reading ??= refresh().finally(() => {
        reading = undefined;
      });
      await reading;
    }
    const byProject = repositories?.byProject ?? new Map();
    return new Map(
      sources
        .readProjects()
        .filter((project) => project.lifecycle === "active")
        .map((project) => {
          const connectedRepository = byProject.get(String(project.id));
          return [
            String(project.id),
            connectedRepository === undefined ? project : { ...project, connectedRepository },
          ] as const;
        }),
    );
  };
}
