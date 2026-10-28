import { decodeHostAnswer } from "@octant/contracts";
import { AppleDeviceResponse, type AppleDeviceRequest } from "@octant/contracts/apple-toolchain";
import {
  AppleUploadPreparation,
  type AppleArtifactRequest,
  type AppleUploadPreparationRequest,
} from "@octant/contracts/apple-toolchain-rpc";
import { bindFetchPort } from "./bindFetchPort";

export interface AppleDeviceClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export type AppleDeviceScreenshotRead =
  | { readonly status: "succeeded"; readonly blob: Blob }
  | { readonly status: "failed"; readonly message: string };

/**
 * The host's physical Apple devices (docs/design/apple-devices.md). Each
 * request goes to the route that takes its kind: reads to the device route,
 * a lease to the local-only lease route, and the thread's work on a leased
 * device to the local-only action route. A failure is an answer, never a
 * throw, so the pane always has something honest to show.
 */
export interface AppleDeviceClient {
  request(request: AppleDeviceRequest, signal?: AbortSignal): Promise<AppleDeviceResponse>;
  /** The pixels of the thread's latest screenshot of a device, for a local window only. */
  readScreenshot(
    request: AppleArtifactRequest,
    signal?: AbortSignal,
  ): Promise<AppleDeviceScreenshotRead>;
  /**
   * What an upload of the project to App Store Connect would send, read
   * before the person is asked to confirm it; for a local window only.
   */
  prepareUpload(
    request: AppleUploadPreparationRequest,
    signal?: AbortSignal,
  ): Promise<AppleUploadPreparation>;
}

const decodeAnswer = decodeHostAnswer(AppleDeviceResponse);
const decodePreparation = decodeHostAnswer(AppleUploadPreparation);

export function createAppleDeviceClient(options: AppleDeviceClientOptions): AppleDeviceClient {
  const resolved = { ...options, fetch: bindFetchPort(options.fetch) };
  return {
    request: async (request, signal) => {
      const sent = await send(resolved, routeFor(request.kind), request, signal);
      if (sent.kind === "failed") return failure("unavailable", sent.message);
      try {
        return decodeAnswer(await sent.response.json());
      } catch {
        return failure("invalid", "Apple device service returned an invalid response.");
      }
    },
    prepareUpload: async (request, signal) => {
      const sent = await send(resolved, "/api/apple/distribution-preparations", request, signal);
      if (sent.kind === "failed") return { kind: "failed", message: sent.message };
      if (!sent.response.ok) {
        return { kind: "failed", message: "This window can't upload for this thread." };
      }
      try {
        return decodePreparation(await sent.response.json());
      } catch {
        return { kind: "failed", message: "Apple device service returned an invalid response." };
      }
    },
    readScreenshot: async (request, signal) => {
      const sent = await send(resolved, "/api/apple/device-screenshots", request, signal);
      if (sent.kind === "failed") return { status: "failed", message: sent.message };
      const { response } = sent;
      if (!response.ok || response.headers.get("content-type") !== "image/png") {
        return { status: "failed", message: "That device screenshot is not available." };
      }
      try {
        return { status: "succeeded", blob: await response.blob() };
      } catch {
        return { status: "failed", message: "The device screenshot could not be read." };
      }
    },
  };
}

function routeFor(kind: AppleDeviceRequest["kind"]): string {
  if (kind === "discover" || kind === "status") return "/api/apple/devices";
  if (kind === "use-device" || kind === "release-device") return "/api/apple/device-leases";
  if (kind === "upload") return "/api/apple/distribution";
  return "/api/apple/device-actions";
}

async function send(
  options: AppleDeviceClientOptions,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly kind: "sent"; readonly response: Response }
  | { readonly kind: "failed"; readonly message: string }
> {
  try {
    const response = await options.fetch(new URL(path, options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    return { kind: "sent", response };
  } catch {
    return {
      kind: "failed",
      message:
        signal?.aborted === true
          ? "The Apple device request was interrupted."
          : "Apple device service is unavailable.",
    };
  }
}

function failure(category: "invalid" | "unavailable", message: string): AppleDeviceResponse {
  return { kind: "apple-device-failure", failure: { category, message } };
}
