import type { PendingQuestionDeferral } from "@octant/contracts/pending-requests";
import { PendingRequestFailure, PendingRequestList, decodeHostAnswer } from "@octant/contracts";

export interface PendingRequestClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/**
 * Reads every approval and question this window can answer, across modes and
 * Projects. Answers go through each mode's own client; this client lists requests and changes question attention preferences.
 * Local windows only: the host refuses a paired device, so the client refuses
 * a non-loopback host before asking.
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
  const url = loopbackUrl(options.baseUrl);
  return {
    async defer(change) {
      const response = await options.fetch(`${url}/defer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(change),
      });
      return response.ok;
    },
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

function loopbackUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    ) {
      return new URL("/api/pending-requests", url).toString();
    }
  } catch {
    // Fall through to the refusal below.
  }
  throw unavailable("Pending requests are read from a local Octant host only.");
}

function unavailable(message: string): PendingRequestClientFailure {
  return new PendingRequestClientFailure({ code: "unavailable", message });
}

function malformedResponse(): PendingRequestClientFailure {
  return unavailable("Pending request service returned an invalid response.");
}
