import {
  decodeNativeHarnessFollowUpActivationResult,
  decodeNativeHarnessFollowUpPreview,
  decodeThreadFollowUpSuggestions,
  type ActivateNativeHarnessFollowUp,
  type NativeHarnessFollowUpActivationResult,
  type NativeHarnessFollowUpPreview,
  type ThreadFollowUpSuggestions,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface FollowUpSuggestionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface FollowUpSuggestionClient {
  suggestions(threadId: string, signal?: AbortSignal): Promise<ThreadFollowUpSuggestions | null>;
  preview(
    threadId: string,
    suggestionId: string,
    signal?: AbortSignal,
  ): Promise<NativeHarnessFollowUpPreview | NativeHarnessFollowUpActivationResult>;
  activate(
    threadId: string,
    activation: ActivateNativeHarnessFollowUp,
    signal?: AbortSignal,
  ): Promise<NativeHarnessFollowUpActivationResult>;
}

export class FollowUpSuggestionClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FollowUpSuggestionClientFailure";
    this.status = status;
  }
}

const PATH = "/api/follow-up-suggestions";

/**
 * A thread's follow-up suggestions on any provider. A refusal comes back as a
 * value; only a transport or authorization failure throws.
 */
export function createFollowUpSuggestionClient(
  options: FollowUpSuggestionClientOptions,
): FollowUpSuggestionClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  const url = (threadId: string, action = "") =>
    new URL(
      `${PATH}/${encodeURIComponent(threadId)}${action === "" ? "" : `/${action}`}`,
      options.baseUrl,
    ).toString();
  const post = (threadId: string, action: string, body: unknown, signal?: AbortSignal) =>
    send(fetch, url(threadId, action), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });

  return {
    async suggestions(threadId, signal) {
      const body = await send(fetch, url(threadId), {
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      const suggestions = (body as { suggestions?: unknown }).suggestions;
      return suggestions === null || suggestions === undefined
        ? null
        : decodeThreadFollowUpSuggestions(suggestions);
    },
    async preview(threadId, suggestionId, signal) {
      const body = await post(threadId, "preview", { suggestionId }, signal);
      const preview = (body as { preview?: unknown }).preview;
      return preview === undefined
        ? decodeNativeHarnessFollowUpActivationResult(body)
        : decodeNativeHarnessFollowUpPreview(preview);
    },
    async activate(threadId, activation, signal) {
      return decodeNativeHarnessFollowUpActivationResult(
        await post(threadId, "activate", activation, signal),
      );
    },
  };
}

async function send(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new FollowUpSuggestionClientFailure("Follow-up suggestions are unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FollowUpSuggestionClientFailure(
      "The follow-up suggestion response is malformed.",
      response.status,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new FollowUpSuggestionClientFailure(
      "The follow-up suggestion request is unauthorized.",
      response.status,
    );
  }
  const refused =
    typeof body === "object" &&
    body !== null &&
    (body as { kind?: unknown }).kind === "follow-up-refused";
  if (!response.ok && !refused) {
    const message =
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "The follow-up suggestion request failed.";
    throw new FollowUpSuggestionClientFailure(message, response.status);
  }
  return body;
}
