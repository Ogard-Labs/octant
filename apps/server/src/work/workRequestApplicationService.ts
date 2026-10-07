import {
  decodeWorkRequestList,
  type PendingRequest,
  type WorkRequest,
  type WorkRequestCommand,
  type WorkRequestCommandResult,
  type WorkRequestList,
  type WorkThreadId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { WorkRequestService, WorkRequestServiceResult } from "./workRequestService";

const MAX_WORK_REQUEST_LIST_LIMIT = 128;

type WorkProjectBootstrap = {
  readonly active: ReadonlyArray<{ readonly id: ProjectId; readonly type: string }>;
};

export interface WorkRequestApplicationProjectsPort {
  bootstrap(windowId: WindowId): Promise<WorkProjectBootstrap>;
}

export interface WorkRequestApplicationThreadsPort {
  bootstrap(windowId: WindowId): Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: WorkThreadId;
      readonly projectId: ProjectId;
      readonly title: string;
    }>;
  }>;
}

export class WorkRequestApplicationError extends Error {
  readonly failure: { readonly code: "unauthorized" | "not-found"; readonly message: string };

  constructor(code: "unauthorized" | "not-found", message: string) {
    super(message);
    this.name = "WorkRequestApplicationError";
    this.failure = { code, message };
  }
}

export interface WorkRequestApplicationServiceOptions {
  readonly requests: Pick<
    WorkRequestService,
    "lookup" | "listPending" | "listForThread" | "resolve" | "cancel"
  >;
  readonly projects: WorkRequestApplicationProjectsPort;
  readonly threads: WorkRequestApplicationThreadsPort;
}

/**
 * Window-scoped Work request application service. Enforces window, Project,
 * and (for thread-scoped reads) thread access before delegating to the
 * authoritative request service. Never exposes a request outside the exact
 * Work Project (and, when scoped, exact thread) the authenticated window is
 * authorized for.
 */
export class WorkRequestApplicationService {
  readonly #requests: WorkRequestApplicationServiceOptions["requests"];
  readonly #projects: WorkRequestApplicationProjectsPort;
  readonly #threads: WorkRequestApplicationThreadsPort;

  constructor(options: WorkRequestApplicationServiceOptions) {
    this.#requests = options.requests;
    this.#projects = options.projects;
    this.#threads = options.threads;
  }

  async list(
    windowId: WindowId,
    projectId: ProjectId,
    threadId?: WorkThreadId,
  ): Promise<WorkRequestList> {
    await this.#assertWorkProjectAccess(windowId, projectId);
    let requests: ReadonlyArray<WorkRequest>;
    if (threadId === undefined) {
      requests = this.#requests.listPending(projectId);
    } else {
      const threadBootstrap = await this.#threads.bootstrap(windowId);
      const thread = threadBootstrap.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (thread === undefined || String(thread.projectId) !== String(projectId)) {
        throw new WorkRequestApplicationError(
          "unauthorized",
          "Work request list is unauthorized for this thread.",
        );
      }
      requests = this.#requests
        .listForThread(projectId, threadId)
        .filter((request) => request.status === "pending");
    }
    return decodeWorkRequestList({ requests: boundWorkRequestList(requests) });
  }

  /**
   * Every pending request this window could answer through `execute`, across
   * its Work Projects: the same Project access `execute` checks, narrowed to
   * threads the window's thread list holds, so a request on a thread it
   * cannot open is never offered. The caller orders and bounds the result.
   */
  async listPendingForWindow(windowId: WindowId): Promise<ReadonlyArray<PendingRequest>> {
    const [projects, { threads }] = await Promise.all([
      this.#projects.bootstrap(windowId),
      this.#threads.bootstrap(windowId),
    ]);
    const pending: PendingRequest[] = [];
    for (const project of projects.active) {
      if (!isWorkProjectOf(projects, project.id)) continue;
      for (const request of this.#requests.listPending(project.id)) {
        const thread = threads.find(
          (candidate) =>
            String(candidate.id) === String(request.threadId) &&
            String(candidate.projectId) === String(request.projectId),
        );
        if (thread === undefined) continue;
        pending.push(pendingRequestFrom(request, thread.title));
      }
    }
    return pending;
  }

  async execute(
    windowId: WindowId,
    command: WorkRequestCommand,
  ): Promise<WorkRequestCommandResult> {
    const entry = this.#requests.lookup(command.requestId);
    if (entry === undefined) {
      throw new WorkRequestApplicationError("not-found", "Work request was not found.");
    }
    await this.#assertWorkProjectAccess(windowId, entry.projectId);
    const result: WorkRequestServiceResult =
      command.kind === "resolve-work-request"
        ? await this.#requests.resolve(command)
        : await this.#requests.cancel(command);
    return unwrap(result, command.kind);
  }

  async #assertWorkProjectAccess(windowId: WindowId, projectId: ProjectId): Promise<void> {
    if (!isWorkProjectOf(await this.#projects.bootstrap(windowId), projectId)) {
      throw new WorkRequestApplicationError(
        "unauthorized",
        "Work request access is unauthorized for this Project.",
      );
    }
  }
}

function isWorkProjectOf(bootstrap: WorkProjectBootstrap, projectId: ProjectId): boolean {
  const project = bootstrap.active.find((candidate) => String(candidate.id) === String(projectId));
  return project !== undefined && project.type === "work";
}

function pendingRequestFrom(request: WorkRequest, threadTitle: string): PendingRequest {
  const shared = {
    mode: "work",
    projectId: request.projectId,
    threadId: request.threadId,
    threadTitle,
    requestedAt: request.requestedAt,
    answer: { requestId: request.requestId, expectedVersion: request.version },
  } as const;
  return request.detail.kind === "approval"
    ? { ...shared, kind: "approval", text: request.detail.description }
    : {
        ...shared,
        kind: "question",
        text: request.detail.prompt,
        options: request.detail.options.map((label) => ({ label })),
      };
}

function unwrap(
  result: WorkRequestServiceResult,
  kind: WorkRequestCommand["kind"],
): WorkRequestCommandResult {
  if (result.status === "ok") {
    return {
      kind: kind === "resolve-work-request" ? "work-request-resolved" : "work-request-cancelled",
      request: result.request,
    } as WorkRequestCommandResult;
  }
  const error = new Error(result.failure.message) as Error & {
    failure: typeof result.failure;
  };
  error.failure = result.failure;
  throw error;
}

/**
 * Bound the request list to the contract's `WorkRequestList` limit before
 * decoding, most recently requested first, so a runaway pending backlog can
 * never make the list decode fail and surface as a service outage.
 */
function boundWorkRequestList(requests: ReadonlyArray<WorkRequest>): ReadonlyArray<WorkRequest> {
  return [...requests]
    .sort(
      (left, right) =>
        right.requestedAt.localeCompare(left.requestedAt) ||
        String(right.requestId).localeCompare(String(left.requestId)),
    )
    .slice(0, MAX_WORK_REQUEST_LIST_LIMIT);
}
