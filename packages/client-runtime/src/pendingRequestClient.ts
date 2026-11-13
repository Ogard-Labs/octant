import type { PendingQuestionDeferral } from "@octant/contracts/pending-requests";
import { PendingRequestFailure, PendingRequestList, decodeHostAnswer } from "@octant/contracts";

export interface PendingRequestClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/**
 * Reads every approval, question and other waiting ask this window or paired
 * device can answer, across modes and Projects. Answers go through each
 * mode's or ask's own client; this client lists them and, at a local window,
 * changes question attention preferences. A paired device reads the same list
 * under its own scope and has no `defer`: the host keeps deferral with a
 * local window.
 */
export interface PendingRequestClient {
  defer?(change: PendingQuestionDeferral): Promise<boolean>;
  list(signal?: AbortSignal): Promise<PendingRequestList>;
}

export class PendingRequestClientFailure extends Error {
  readonly code: PendingRequestFailure["code"];

  constructor(failure: PendingRequestFailure) {
    super(failure.message);
    this.name = "PendingRequestClientFailure";
    this.code = failure.code;
  }
}

export function createPendingRequestClient(
  options: PendingRequestClientOptions,
): PendingRequestClient {
  const { url, local } = hostUrl(options.baseUrl);
  const defer = async (change: PendingQuestionDeferral): Promise<boolean> => {
    const response = await options.fetch(`${url}/defer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(change),
    });
    return response.ok;
  };
  return {
    ...(local ? { defer } : {}),
    async list(signal) {
      let response: Response;
      try {
        response = await options.fetch(url, {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        throw unavailable("Octant pending requests are unavailable.");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw malformedResponse();
      }
      if (!response.ok) {
        let failure: PendingRequestFailure;
        try {
          failure = decodeHostAnswer(PendingRequestFailure)(body);
        } catch {
          throw malformedResponse();
        }
        throw new PendingRequestClientFailure(failure);
      }
      try {
        return decodeHostAnswer(PendingRequestList)(body);
      } catch {
        throw malformedResponse();
      }
    },
  };
}

function hostUrl(baseUrl: string): { readonly url: string; readonly local: boolean } {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return {
        url: new URL("/api/pending-requests", url).toString(),
        local:
          url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" ||
            url.hostname === "localhost" ||
            url.hostname === "[::1]"),
      };
    }
  } catch {
    // Fall through to the refusal below.
  }
  throw unavailable("Pending requests are read from an Octant host.");
}

function unavailable(message: string): PendingRequestClientFailure {
  return new PendingRequestClientFailure({ code: "unavailable", message });
}

function malformedResponse(): PendingRequestClientFailure {
  return unavailable("Pending request service returned an invalid response.");
}
