import { decodeHostAnswer, type PullRequestReviewTarget } from "@octant/contracts";
import { PullRequestGuideView, PullRequestViewedView } from "@octant/contracts/pull-request-guide";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import type { PullRequestReviewClientOptions } from "./pullRequestReviewClient";

/** A refusal from the guide routes, with the host's own words and reason. */
export class PullRequestGuideClientFailure extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "PullRequestGuideClientFailure";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Posts to the guide routes. It repeats the review client's poster rather
 * than importing it: importing that module from this lazy one made the
 * bundler split a shared contracts chunk and grew first paint by about
 * 860 bytes gzip.
 */
async function postPullRequestReviewJson(
  options: PullRequestReviewClientOptions,
  path: string,
  payload: unknown,
  fallback: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(new URL(path, options.baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new PullRequestGuideClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PullRequestGuideClientFailure(fallback, response.status);
  }
  if (response.ok) return body;
  const field = (name: string) =>
    typeof body === "object" && body !== null && name in body ? Reflect.get(body, name) : undefined;
  const error = field("error");
  const reason = field("reason");
  throw new PullRequestGuideClientFailure(
    typeof error === "string" ? error : fallback,
    response.status,
    typeof reason === "string" ? reason : undefined,
  );
}

export interface PullRequestGuideClient {
  read(
    input: { readonly target: PullRequestReviewTarget; readonly headSha?: string },
    signal?: AbortSignal,
  ): Promise<PullRequestGuideView>;
  /** Starts a guide run for the current head; answers with the view while it runs. */
  write(target: PullRequestReviewTarget, signal?: AbortSignal): Promise<PullRequestGuideView>;
  readViewed(target: PullRequestReviewTarget, signal?: AbortSignal): Promise<PullRequestViewedView>;
  setViewed(
    input: {
      readonly target: PullRequestReviewTarget;
      readonly path: string;
      readonly viewed: boolean;
      readonly headSha?: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export function createPullRequestGuideClient(
  options: PullRequestReviewClientOptions,
): PullRequestGuideClient {
  return {
    async read(input, signal) {
      const body = await postPullRequestReviewJson(
        options,
        "/api/code/pull-request-guides/query",
        input,
        "The review guide is unavailable.",
        signal,
      );
      return decodeHostAnswer(PullRequestGuideView)(body);
    },
    async write(target, signal) {
      const body = await postPullRequestReviewJson(
        options,
        "/api/code/pull-request-guides/write",
        { target },
        "The guide could not be started.",
        signal,
      );
      return decodeHostAnswer(PullRequestGuideView)(body);
    },
    async readViewed(target, signal) {
      const body = await postPullRequestReviewJson(
        options,
        "/api/code/pull-request-guides/viewed/query",
        { target },
        "Viewed files are unavailable.",
        signal,
      );
      return decodeHostAnswer(PullRequestViewedView)(body);
    },
    async setViewed(input, signal) {
      await postPullRequestReviewJson(
        options,
        "/api/code/pull-request-guides/viewed",
        input,
        "GitHub did not take the change.",
        signal,
      );
    },
  };
}

const GUIDE_GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

/**
 * Reads a pull request's review guide over a paired mobile transport.
 * Paired devices only read guides: writing stays on a local host window.
 */
export async function loadMobilePullRequestGuide(input: {
  readonly transport: MobileRemoteTransport;
  readonly target: {
    readonly projectId: string;
    readonly baseRepository: string;
    readonly number: number;
  };
  readonly headSha?: string;
}): Promise<PullRequestGuideView> {
  const [owner, name, ...rest] = input.target.baseRepository.split("/");
  if (
    owner === undefined ||
    name === undefined ||
    owner.length === 0 ||
    name.length === 0 ||
    rest.length > 0
  ) {
    throw new PullRequestGuideClientFailure("The pull request's repository is unreadable.", 0);
  }
  const headSha =
    input.headSha !== undefined && GUIDE_GIT_OBJECT_ID.test(input.headSha)
      ? input.headSha.toLowerCase()
      : undefined;
  let response: Response;
  try {
    response = await input.transport.authenticatedFetch({
      method: "POST",
      path: "/api/code/pull-request-guides/query",
      contentType: "application/json",
      body: JSON.stringify({
        target: {
          projectId: input.target.projectId,
          repositoryOwner: owner,
          repositoryName: name,
          number: input.target.number,
        },
        ...(headSha === undefined ? {} : { headSha }),
      }),
    });
  } catch {
    throw new PullRequestGuideClientFailure("The review guide is unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PullRequestGuideClientFailure("The review guide is unavailable.", response.status);
  }
  if (!response.ok) {
    const field = (key: string) =>
      typeof body === "object" && body !== null && key in body ? Reflect.get(body, key) : undefined;
    const error = field("error");
    const reason = field("reason");
    throw new PullRequestGuideClientFailure(
      typeof error === "string" ? error : "The review guide is unavailable.",
      response.status,
      typeof reason === "string" ? reason : undefined,
    );
  }
  return decodeHostAnswer(PullRequestGuideView)(body);
}
