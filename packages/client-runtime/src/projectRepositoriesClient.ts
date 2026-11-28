import { decodeHostAnswer, type ProjectId } from "@octant/contracts";
import { ProjectRepositoriesList } from "@octant/contracts/project-repositories";
import { bindFetchPort } from "./bindFetchPort";

export interface ProjectRepositoriesClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProjectRepositoriesClient {
  list(projectId: ProjectId, signal?: AbortSignal): Promise<ProjectRepositoriesList>;
}

/**
 * Client for discovering Git repositories and `.code-workspace` entries inside
 * a Code Project's already-granted folders. Kept outside `projectClient` so its
 * schemas load with Project overview rather than the initial renderer bundle.
 */
export function createProjectRepositoriesClient(
  options: ProjectRepositoriesClientOptions,
): ProjectRepositoriesClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = {
    "x-octant-window-capability": options.windowCapability,
  };
  const decode = decodeHostAnswer(ProjectRepositoriesList);

  return {
    async list(projectId, signal) {
      const response = await fetch(
        new URL(
          `/api/projects/${encodeURIComponent(projectId)}/repositories`,
          options.baseUrl,
        ).toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
      );
      if (!response.ok) {
        throw new Error(`Project repositories request failed with ${response.status}.`);
      }
      const body: unknown = await response.json();
      return decode(body);
    },
  };
}
