import {
  decodeProductFeedbackCommandResult,
  decodeProductFeedbackList,
  type ProductFeedbackCommand,
  type ProductFeedbackCommandResult,
  type ProductFeedbackNote,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ProductFeedbackClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProductFeedbackClient {
  list(threadId: string, signal?: AbortSignal): Promise<ReadonlyArray<ProductFeedbackNote>>;
  execute(
    command: ProductFeedbackCommand,
    signal?: AbortSignal,
  ): Promise<ProductFeedbackCommandResult>;
}

export class ProductFeedbackClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProductFeedbackClientFailure";
    this.status = status;
  }
}

/**
 * Client for the pointed-at feedback surface.
 *
 * The renderer sends where the user tapped and what they wrote; the host
 * resolves the element and cuts the picture. A refusal comes back as a decoded
 * result rather than an exception, because "there is nothing there" and "this
 * host cannot read that page" are answers the user should see.
 */
export function createProductFeedbackClient(
  options: ProductFeedbackClientOptions,
): ProductFeedbackClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async list(threadId, signal) {
      const url = new URL("/api/feedback/notes", options.baseUrl);
      url.searchParams.set("threadId", threadId);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Pointed-at notes are unavailable.",
      );
      return decodeProductFeedbackList(body).notes;
    },

    async execute(command, signal) {
      const url = new URL("/api/feedback/commands", options.baseUrl);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "The note could not be sent.",
      );
      return decodeProductFeedbackCommandResult(body);
    },
  };
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  unavailableMessage: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ProductFeedbackClientFailure(unavailableMessage, 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ProductFeedbackClientFailure(
      readString(body, "error") ?? unavailableMessage,
      response.status,
    );
  }
  return body;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProductFeedbackClientFailure("Feedback base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new ProductFeedbackClientFailure("Feedback base URL must be loopback.", 0);
  }
}
