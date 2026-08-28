import {
  decodeImageGenerationJobsResponse,
  decodeImageGenerationProfilesResponse,
  decodeImageGenerationSaveResult,
  decodeImageJob,
  type ImageArtifactId,
  type ImageGenerationEnqueueRequest,
  type ImageGenerationJobsResponse,
  type ImageGenerationProfilesResponse,
  type ImageGenerationSaveResult,
  type ImageGenerationScopeId,
  type ImageJob,
  type ImageJobId,
  type ImageJobThreadKind,
} from "@octant/contracts";

export interface ImageGenerationClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ImageGenerationClient {
  profiles(): Promise<ImageGenerationProfilesResponse>;
  list(input: {
    readonly threadKind: ImageJobThreadKind;
    readonly scopeId: ImageGenerationScopeId;
  }): Promise<ImageGenerationJobsResponse>;
  enqueue(request: ImageGenerationEnqueueRequest): Promise<ImageJob>;
  get(jobId: ImageJobId): Promise<ImageJob>;
  cancel(jobId: ImageJobId): Promise<ImageJob>;
  artifact(jobId: ImageJobId, attachmentId: ImageArtifactId): Promise<Blob>;
  save(input: {
    readonly jobId: ImageJobId;
    readonly attachmentId: ImageArtifactId;
    readonly relativePath: string;
  }): Promise<ImageGenerationSaveResult>;
}

export class ImageGenerationClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ImageGenerationClientFailure";
    this.status = status;
  }
}

export function createImageGenerationClient(
  options: ImageGenerationClientOptions,
): ImageGenerationClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    profiles() {
      return requestJson(
        options,
        "/api/image/profiles",
        { method: "GET", headers },
        decodeImageGenerationProfilesResponse,
      );
    },
    list(input) {
      const url = new URL("/api/image/jobs", options.baseUrl);
      url.searchParams.set("threadKind", input.threadKind);
      url.searchParams.set("scopeId", String(input.scopeId));
      return requestJson(
        options,
        url.pathname + url.search,
        { method: "GET", headers },
        decodeImageGenerationJobsResponse,
      );
    },
    enqueue(body) {
      return requestJson(
        options,
        "/api/image/jobs",
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeImageJob,
      );
    },
    get(jobId) {
      return requestJson(
        options,
        `/api/image/jobs/${encodeURIComponent(jobId)}`,
        { method: "GET", headers },
        decodeImageJob,
      );
    },
    cancel(jobId) {
      return requestJson(
        options,
        `/api/image/jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
        decodeImageJob,
      );
    },
    async artifact(jobId, attachmentId) {
      let response: Response;
      try {
        response = await options.fetch(
          new URL(
            `/api/image/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(attachmentId)}`,
            options.baseUrl,
          ).toString(),
          { method: "GET", headers },
        );
      } catch {
        throw new ImageGenerationClientFailure("Image generation is unavailable.", 0);
      }
      if (!response.ok) {
        throw new ImageGenerationClientFailure(
          "The generated image is unavailable.",
          response.status,
        );
      }
      return response.blob();
    },
    save(input) {
      return requestJson(
        options,
        `/api/image/jobs/${encodeURIComponent(input.jobId)}/artifacts/${encodeURIComponent(input.attachmentId)}/save`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ relativePath: input.relativePath }),
        },
        decodeImageGenerationSaveResult,
      );
    },
  };
}

async function requestJson<T>(
  options: ImageGenerationClientOptions,
  path: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await options.fetch(new URL(path, options.baseUrl).toString(), init);
  } catch {
    throw new ImageGenerationClientFailure("Image generation is unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ImageGenerationClientFailure(
      "Image generation returned an invalid response.",
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : typeof body === "object" &&
            body !== null &&
            "reason" in body &&
            typeof body.reason === "string"
          ? body.reason
          : "Image generation request failed.";
    throw new ImageGenerationClientFailure(message, response.status);
  }
  try {
    return decode(body);
  } catch {
    throw new ImageGenerationClientFailure(
      "Image generation response did not match the contract.",
      response.status,
    );
  }
}
