import {
  type ProductFeedbackCommand,
  ProductFeedbackCommandResult,
  type ProductFeedbackNote,
  ProductFeedbackList,
  ProductFeedbackCropAnswer,
  decodeHostAnswer,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ProductFeedbackClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  readonly requestTimeoutMs?: number;
}

export interface ProductFeedbackClient {
  list(threadId: string, signal?: AbortSignal): Promise<ReadonlyArray<ProductFeedbackNote>>;
  readCrop(noteId: string, signal?: AbortSignal): Promise<string | undefined>;
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
  const request = (url: string, init: RequestInit, message: string) =>
    send(fetch, url, init, message, options.requestTimeoutMs ?? 15_000);

  return {
    async list(threadId, signal) {
      const url = new URL("/api/feedback/notes", options.baseUrl);
      url.searchParams.set("threadId", threadId);
      const body = await request(
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Pointed-at notes are unavailable.",
      );
      return decodeHostAnswer(ProductFeedbackList)(body).notes;
    },

    async execute(command, signal) {
      const url = new URL("/api/feedback/commands", options.baseUrl);
      const body = await request(
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
      return decodeHostAnswer(ProductFeedbackCommandResult)(body);
    },
    async readCrop(noteId, signal) {
      const body = await request(
        new URL(
          `/api/feedback/notes/${encodeURIComponent(noteId)}/crop`,
          options.baseUrl,
        ).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "The captured element image is unavailable.",
      );
      return decodeHostAnswer(ProductFeedbackCropAnswer)(body).dataUrl;
    },
  };
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  unavailableMessage: string,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = AbortSignal.any([deadline.signal, ...(init.signal == null ? [] : [init.signal])]);
  try {
    let response: Response;
    try {
      response = await untilAborted(fetch(url, { ...init, signal }), signal);
    } catch {
      throw new ProductFeedbackClientFailure(
        unavailableMessage + " Refresh notes before retrying.",
        0,
      );
    }
    const body: unknown = await untilAborted(response.json(), signal).catch(() => {
      if (signal.aborted)
        throw new ProductFeedbackClientFailure(
          "The host did not finish responding. Refresh notes before retrying.",
          0,
        );
      return {};
    });
    if (!response.ok) {
      throw new ProductFeedbackClientFailure(
        readString(body, "error") ?? unavailableMessage,
        response.status,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const refuse = () => reject(new DOMException("Feedback request was aborted.", "AbortError"));
    if (signal.aborted) {
      refuse();
      return;
    }
    signal.addEventListener("abort", refuse, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", refuse);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", refuse);
        reject(error);
      },
    );
  });
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
