import {
  CodeEnvironmentObservation,
  type CodeThreadId,
  type MemoryCommand,
  MemoryCommandResult,
  ProjectBootstrap,
  type ProjectCommand,
  ProjectCommandResult,
  ProjectFailure,
  type ProjectId,
  ProjectMemoryProposalDecisionResult,
  ProjectMemoryProposalList,
  ProjectMemoryView,
  ProjectSummary,
  decodeHostAnswer,
  DesignSystemDocument,
  DesignSystemList,
  DesignSystemWriteResult,
  type DesignSystemLocation,
  type DesignSystemWriteRequest,
  type ProjectMemoryProposal,
  type ProjectMemoryProposalDecision,
} from "@octant/contracts";

export interface ProjectClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProjectClient {
  bootstrap(): Promise<ProjectBootstrap>;
  search(query: string): Promise<ReadonlyArray<ProjectSummary>>;
  executeProject(command: ProjectCommand): Promise<ProjectCommandResult>;
  memory(projectId: ProjectId): Promise<ProjectMemoryView>;
  environment(
    projectId: ProjectId,
    signal?: AbortSignal,
    fresh?: boolean,
  ): Promise<CodeEnvironmentObservation>;
  environmentForThread(
    projectId: ProjectId,
    threadId: CodeThreadId,
    signal?: AbortSignal,
    fresh?: boolean,
  ): Promise<CodeEnvironmentObservation>;
  executeMemory(command: MemoryCommand): Promise<MemoryCommandResult>;
  /** Memory changes this window's agents asked for, waiting for the person. */
  listMemoryProposals(signal?: AbortSignal): Promise<ReadonlyArray<ProjectMemoryProposal>>;
  decideMemoryProposal(
    decision: ProjectMemoryProposalDecision,
  ): Promise<ProjectMemoryProposalDecisionResult>;
  /** The `DESIGN.md` files in a Work or Code Project's folders. */
  listDesignSystems(projectId: ProjectId, signal?: AbortSignal): Promise<DesignSystemList>;
  readDesignSystem(
    projectId: ProjectId,
    location: DesignSystemLocation,
    signal?: AbortSignal,
  ): Promise<DesignSystemDocument>;
  /** Create (no base revision) or replace exactly the revision it was edited from. */
  saveDesignSystem(request: DesignSystemWriteRequest): Promise<DesignSystemWriteResult>;
}

export class ProjectClientFailure extends Error {
  readonly category: ProjectFailure["category"];
  readonly currentVersion?: Extract<ProjectFailure, { category: "conflict" }>["currentVersion"];
  constructor(failure: ProjectFailure) {
    super(failure.message);
    this.name = "ProjectClientFailure";
    this.category = failure.category;
    if (failure.category === "conflict") this.currentVersion = failure.currentVersion;
  }
}

export function createProjectClient(options: ProjectClientOptions): ProjectClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    bootstrap() {
      return request(
        options.fetch,
        new URL("/api/projects/bootstrap", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(ProjectBootstrap),
      );
    },
    search(query) {
      const url = new URL("/api/projects/search", options.baseUrl);
      url.searchParams.set("q", query);
      return request(options.fetch, url.toString(), { method: "GET", headers }, decodeSummaryArray);
    },
    executeProject(command) {
      return request(
        options.fetch,
        new URL("/api/projects/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeHostAnswer(ProjectCommandResult),
      );
    },
    memory(projectId) {
      return request(
        options.fetch,
        new URL(
          `/api/projects/${encodeURIComponent(projectId)}/memory`,
          options.baseUrl,
        ).toString(),
        { method: "GET", headers },
        decodeHostAnswer(ProjectMemoryView),
      );
    },
    environment(projectId, signal, fresh = false) {
      const url = new URL(
        `/api/projects/${encodeURIComponent(projectId)}/environment`,
        options.baseUrl,
      );
      if (fresh) url.searchParams.set("fresh", "1");
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        decodeHostAnswer(CodeEnvironmentObservation),
      );
    },
    environmentForThread(projectId, threadId, signal, fresh = false) {
      const url = new URL(
        `/api/projects/${encodeURIComponent(projectId)}/environment`,
        options.baseUrl,
      );
      url.searchParams.set("threadId", threadId);
      if (fresh) url.searchParams.set("fresh", "1");
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        decodeHostAnswer(CodeEnvironmentObservation),
      );
    },
    executeMemory(command) {
      return request(
        options.fetch,
        new URL("/api/projects/memory/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeHostAnswer(MemoryCommandResult),
      );
    },
    listMemoryProposals(signal) {
      return request(
        options.fetch,
        new URL("/api/projects/memory/proposals", options.baseUrl).toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        (value) => decodeHostAnswer(ProjectMemoryProposalList)(value).proposals,
      );
    },
    decideMemoryProposal(decision) {
      return request(
        options.fetch,
        new URL("/api/projects/memory/proposals/decide", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(decision),
        },
        decodeHostAnswer(ProjectMemoryProposalDecisionResult),
      );
    },
    listDesignSystems(projectId, signal) {
      const url = new URL("/api/design-systems", options.baseUrl);
      url.searchParams.set("projectId", projectId);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        decodeHostAnswer(DesignSystemList),
      );
    },
    readDesignSystem(projectId, location, signal) {
      const url = new URL("/api/design-systems/file", options.baseUrl);
      url.searchParams.set("projectId", projectId);
      url.searchParams.set("folder", location.folder);
      url.searchParams.set("path", location.path);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
        decodeHostAnswer(DesignSystemDocument),
      );
    },
    saveDesignSystem(body) {
      return request(
        options.fetch,
        new URL("/api/design-systems/file", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(DesignSystemWriteResult),
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable("Octant Project service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unavailable("Project service returned an invalid response.");
  }
  if (!response.ok) {
    try {
      throw new ProjectClientFailure(decodeHostAnswer(ProjectFailure)(body));
    } catch (error) {
      if (error instanceof ProjectClientFailure) throw error;
      throw unavailable("Project service returned an invalid response.");
    }
  }
  try {
    return decode(body);
  } catch {
    throw unavailable("Project service returned an invalid response.");
  }
}

function decodeSummaryArray(value: unknown): ReadonlyArray<ProjectSummary> {
  if (!Array.isArray(value)) throw new Error("invalid");
  return value.map((item) => decodeHostAnswer(ProjectSummary)(item));
}

function unavailable(message: string): ProjectClientFailure {
  return new ProjectClientFailure({ category: "unavailable", message });
}
