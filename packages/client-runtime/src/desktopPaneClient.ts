import {
  DesktopPaneAnswer,
  decodeHostAnswer,
  type DesktopFrameRequest,
  type DesktopPaneRequest,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface DesktopPaneClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** A frame is the image the host passed on; anything else is the host's answer. */
export type DesktopFrameAnswer =
  | { readonly status: "frame"; readonly image: Blob }
  | Extract<DesktopPaneAnswer, { readonly status: "refused" | "no-frame" }>;

export interface DesktopPaneClient {
  request(request: DesktopPaneRequest, signal?: AbortSignal): Promise<DesktopPaneAnswer>;
  frame(request: DesktopFrameRequest, signal?: AbortSignal): Promise<DesktopFrameAnswer>;
}

export class DesktopPaneClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DesktopPaneClientFailure";
    this.status = status;
  }
}

const decodeAnswer = decodeHostAnswer(DesktopPaneAnswer);
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

/**
 * The Desktop tab's transport. The host decides everything: who the person
 * is, whether the window or device may open the thread, and every refusal,
 * which arrives as an answer to show in words rather than as an HTTP error.
 * A local window and a paired device both use it, so the base URL is the
 * loopback listener or the host's authenticated HTTPS origin.
 */
export function createDesktopPaneClient(options: DesktopPaneClientOptions): DesktopPaneClient {
  validateBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, options.baseUrl).toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new DesktopPaneClientFailure("The host could not be reached.", 0);
    }
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => ({}));
      throw new DesktopPaneClientFailure(messageFrom(failure), response.status);
    }
    return response;
  }

  return {
    async request(request, signal) {
      const response = await post("/api/code/desktops", request, signal);
      return decodeAnswer(await response.json());
    },
    async frame(request, signal) {
      const response = await post("/api/code/desktops/frame", request, signal);
      const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (IMAGE_TYPES.has(type)) return { status: "frame", image: await response.blob() };
      const answer = decodeAnswer(await response.json());
      if (answer.status === "refused" || answer.status === "no-frame") return answer;
      throw new DesktopPaneClientFailure("The host answered a frame with something else.", 0);
    },
  };
}

function messageFrom(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : "The desktop request failed.";
}

/** Loopback may be plain HTTP; any other host must be HTTPS, which protects the window capability. */
function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DesktopPaneClientFailure("Desktop base URL is invalid.", 0);
  }
  const host = url.hostname;
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (
    loopback ? url.protocol !== "http:" && url.protocol !== "https:" : url.protocol !== "https:"
  ) {
    throw new DesktopPaneClientFailure("Desktop base URL must be loopback or an HTTPS host.", 0);
  }
}
