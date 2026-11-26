import { decodeHostAnswer, type PullRequestReviewTarget } from "@octant/contracts";
import { PullRequestGuideView, PullRequestViewedView } from "@octant/contracts/pull-request-guide";
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
