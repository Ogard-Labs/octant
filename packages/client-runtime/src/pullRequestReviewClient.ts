import {
  PullRequestReviewProjectView,
  PullRequestReviewPullRequestView,
  PullRequestReviewThreadView,
  decodeHostAnswer,
  type CodeThreadId,
  type ProjectId,
  type PullRequestReviewProjectSettingsCommand,
  type PullRequestReviewPullRequestSettingsCommand,
  type PullRequestReviewTarget,
  type PullRequestReviewThreadOverrideCommand,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface PullRequestReviewClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class PullRequestReviewClientFailure extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "PullRequestReviewClientFailure";
    this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}

export interface PullRequestReviewClient {
  queryProject(projectId: ProjectId, signal?: AbortSignal): Promise<PullRequestReviewProjectView>;
  updateProject(
    command: PullRequestReviewProjectSettingsCommand,
    signal?: AbortSignal,
  ): Promise<PullRequestReviewProjectView>;
  queryThread(threadId: CodeThreadId, signal?: AbortSignal): Promise<PullRequestReviewThreadView>;
  updateThread(
    command: PullRequestReviewThreadOverrideCommand,
    signal?: AbortSignal,
  ): Promise<PullRequestReviewThreadView>;
  queryPullRequest(
    input: { readonly target: PullRequestReviewTarget; readonly threadId?: CodeThreadId },
    signal?: AbortSignal,
  ): Promise<PullRequestReviewPullRequestView>;
  updatePullRequest(
    command: PullRequestReviewPullRequestSettingsCommand,
    signal?: AbortSignal,
  ): Promise<PullRequestReviewPullRequestView>;
  /**
   * Where this client posts. The Guide tab builds its own client from it
   * (`createPullRequestGuideClient`) inside its lazily loaded module, so the
   * renderer's first paint carries neither that client nor its schemas.
   */
  readonly transport: PullRequestReviewClientOptions;
}

export function createPullRequestReviewClient(
  options: PullRequestReviewClientOptions,
): PullRequestReviewClient {
  const fetch = bindFetchPort(options.fetch);

  const post = async (
    path: string,
    payload: unknown,
    fallback: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, options.baseUrl).toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new PullRequestReviewClientFailure(fallback, 0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PullRequestReviewClientFailure(fallback, response.status);
    }
    if (!response.ok) {
      const error =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : fallback;
      const reason =
        typeof body === "object" &&
        body !== null &&
        "reason" in body &&
        typeof body.reason === "string"
          ? body.reason
          : undefined;
      throw new PullRequestReviewClientFailure(error, response.status, reason);
    }
    return body;
  };

  return {
    async queryProject(projectId, signal) {
      const body = await post(
        "/api/code/pull-request-reviews/project/query",
        { projectId },
        "Pull request reviewer settings are unavailable.",
        signal,
      );
      return decodeHostAnswer(PullRequestReviewProjectView)(body);
    },
    async updateProject(command, signal) {
      const body = await post(
        "/api/code/pull-request-reviews/project",
        command,
        "Pull request reviewer settings could not be saved.",
        signal,
      );
      return decodeHostAnswer(PullRequestReviewProjectView)(body);
    },
    async queryThread(threadId, signal) {
      const body = await post(
        "/api/code/pull-request-reviews/thread/query",
        { threadId },
        "Thread pull request review settings are unavailable.",
        signal,
      );
      return decodeHostAnswer(PullRequestReviewThreadView)(body);
    },
    async updateThread(command, signal) {
      const body = await post(
        "/api/code/pull-request-reviews/thread",
        command,
        "Thread pull request review override could not be saved.",
        signal,
      );
      return decodeHostAnswer(PullRequestReviewThreadView)(body);
    },
    async queryPullRequest(input, signal) {
      const body = await post(
        "/api/code/pull-request-reviews/pr/query",
        input,
        "Pull request review status is unavailable.",
        signal,
      );
      return decodeHostAnswer(PullRequestReviewPullRequestView)(body);
    },
    async updatePullRequest(command, signal) {
      const body = await post(
        "/api/code/pull-request-reviews/pr",
        command,
        "Pull request review hand-back setting could not be saved.",
        signal,
      );
      return decodeHostAnswer(PullRequestReviewPullRequestView)(body);
    },
    transport: { ...options, fetch },
  };
}
