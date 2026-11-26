import type { ProjectSummary } from "@octant/contracts/projects";

/**
 * How long a Project's GitHub repository is trusted. Reading it observes every
 * Code Project's Git remotes, which a list that refreshes on every change must
 * not do each time; a repository a remote change moves shows a minute late.
 */
const REPOSITORY_MAX_AGE_MS = 60_000;

type StoredProject = Pick<ProjectSummary, "id" | "type" | "name" | "lifecycle">;

/**
 * What a repository was read for: the folder the Project is bound to. A
 * relink changes it, so the repository read for the folder it left is never
 * given to the folder it is bound to now.
 */
function folderOf(project: StoredProject): string {
  return "binding" in project &&
    typeof project.binding === "object" &&
    project.binding !== null &&
    "canonicalRoot" in project.binding
    ? String(project.binding.canonicalRoot)
    : "";
}

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
    | {
        readonly at: number;
        readonly byProject: ReadonlyMap<string, unknown>;
        /** Each Project's folder when the repositories were read. */
        readonly folders: ReadonlyMap<string, string>;
      }
    | undefined;
  let reading: Promise<void> | undefined;
  const refresh = async () => {
    const at = now();
    const folders = new Map(
      sources.readProjects().map((project) => [String(project.id), folderOf(project)] as const),
    );
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
        folders,
      };
    } catch {
      // The repositories read for folders that did not move still hold; the
      // rest are dropped, so a failed read is not asked again on every call.
      const before = repositories;
      repositories = {
        at,
        byProject: new Map(
          [...(before?.byProject ?? new Map<string, unknown>())].filter(
            ([projectId]) => before?.folders.get(projectId) === folders.get(projectId),
          ),
        ),
        folders,
      };
    }
  };
  return async () => {
    const stored = sources.readProjects().filter((project) => project.lifecycle === "active");
    const read = repositories;
    if (
      read === undefined ||
      now() - read.at >= REPOSITORY_MAX_AGE_MS ||
      stored.some((project) => read.folders.get(String(project.id)) !== folderOf(project))
    ) {
      reading ??= refresh().finally(() => {
        reading = undefined;
      });
      await reading;
    }
    const byProject = repositories?.byProject ?? new Map();
    const folders = repositories?.folders ?? new Map<string, string>();
    return new Map(
      stored.map((project) => {
        // A Project bound elsewhere than when its repository was read gets
        // none until the next read, rather than the one it left.
        const connectedRepository =
          folders.get(String(project.id)) === folderOf(project)
            ? byProject.get(String(project.id))
            : undefined;
        return [
          String(project.id),
          connectedRepository === undefined ? project : { ...project, connectedRepository },
        ] as const;
      }),
    );
  };
}
