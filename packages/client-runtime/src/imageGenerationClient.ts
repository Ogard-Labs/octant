import {
  MAX_GENERATED_IMAGE_BYTES,
  THREAD_IMAGE_CHUNK_BYTES,
  type ImageArtifactId,
  type ImageGenerationEnqueueRequest,
  ImageGenerationJobsResponse,
  type ImageGenerationOfferDecision,
  ImageGenerationOfferDecisionResult,
  ImageGenerationOffersResponse,
  ImageGenerationProfilesResponse,
  ImageGenerationSaveResult,
  type ImageGenerationScopeId,
  ImageJob,
  type ImageJobId,
  type ImageJobThreadKind,
  decodeHostAnswer,
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
  /** What the thread's agent is waiting for this window to answer. */
  offers(input: {
    readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
    readonly scopeId: ImageGenerationScopeId;
  }): Promise<ImageGenerationOffersResponse>;
  decideOffer(decision: ImageGenerationOfferDecision): Promise<ImageGenerationOfferDecisionResult>;
}

export class ImageGenerationClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ImageGenerationClientFailure";
    this.status = status;
  }
}

/** A paired thread can read its results; no composer, cancellation or host file write is exposed. */
export type ThreadImageResults = Pick<ImageGenerationClient, "list" | "artifact">;

export function createThreadImageResults(
  options: ImageGenerationClientOptions,
): ThreadImageResults {
  return {
    list: createImageGenerationClient(options).list,
    async artifact(jobId, attachmentId) {
      const url = new URL("/api/image/thread-artifact", options.baseUrl);
      url.searchParams.set("jobId", String(jobId));
      url.searchParams.set("attachmentId", String(attachmentId));
      const chunks: Blob[] = [];
      let total: number | undefined;
      for (let offset = 0; offset < MAX_GENERATED_IMAGE_BYTES; offset += THREAD_IMAGE_CHUNK_BYTES) {
        url.searchParams.set("offset", String(offset));
        const response = await options.fetch(url.toString(), {
          headers: { "x-octant-window-capability": options.windowCapability },
        });
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        const size = Number(range?.[3]);
        const end = Math.min(offset + THREAD_IMAGE_CHUNK_BYTES, size);
        if (
          response.status !== 206 ||
          size > MAX_GENERATED_IMAGE_BYTES ||
          end <= offset ||
          (total !== undefined && size !== total) ||
          Number(range?.[1]) !== offset ||
          Number(range?.[2]) !== end - 1
        )
          throw new ImageGenerationClientFailure(
            "The generated image is unavailable.",
            response.status,
          );
        total = size;
        const chunk = await response.blob();
        if (chunk.size !== end - offset)
          throw new ImageGenerationClientFailure(
            "The generated image is incomplete.",
            response.status,
          );
        chunks.push(chunk);
        if (end === size) return new Blob(chunks, { type: chunk.type });
      }
      throw new ImageGenerationClientFailure("The generated image is too large.", 413);
    },
  };
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
        decodeHostAnswer(ImageGenerationProfilesResponse),
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
        decodeHostAnswer(ImageGenerationJobsResponse),
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
        decodeHostAnswer(ImageJob),
      );
    },
    get(jobId) {
      return requestJson(
        options,
        `/api/image/jobs/${encodeURIComponent(jobId)}`,
        { method: "GET", headers },
        decodeHostAnswer(ImageJob),
      );
    },
    cancel(jobId) {
      return requestJson(
        options,
        `/api/image/jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
        decodeHostAnswer(ImageJob),
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
        decodeHostAnswer(ImageGenerationSaveResult),
      );
    },
    offers(input) {
      const url = new URL("/api/image/offers", options.baseUrl);
      url.searchParams.set("threadKind", input.threadKind);
      url.searchParams.set("scopeId", String(input.scopeId));
      return requestJson(
        options,
        url.pathname + url.search,
        { method: "GET", headers },
        decodeHostAnswer(ImageGenerationOffersResponse),
      );
    },
    decideOffer(decision) {
      return requestJson(
        options,
        "/api/image/offers/decide",
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(decision),
        },
        decodeHostAnswer(ImageGenerationOfferDecisionResult),
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
