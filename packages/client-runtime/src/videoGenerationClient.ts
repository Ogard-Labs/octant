import {
  VideoClipTicketResponse,
  VideoJob,
  VideoJobsResponse,
  decodeHostAnswer,
  type ImageGenerationScopeId,
  type VideoJobId,
  type VideoJobThreadKind,
} from "@octant/contracts";

export interface VideoGenerationClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface VideoGenerationClient {
  list(input: {
    readonly threadKind: VideoJobThreadKind;
    readonly scopeId: ImageGenerationScopeId;
  }): Promise<VideoJobsResponse>;
  stop(jobId: VideoJobId): Promise<VideoJob>;
  /**
   * An absolute, short-lived address for one finished clip, for a `<video>`
   * element's `src` or a download link. Ask again when it expires.
   */
  clipUrl(jobId: VideoJobId): Promise<{ readonly url: string; readonly expiresAt: string }>;
}

export class VideoGenerationClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VideoGenerationClientFailure";
    this.status = status;
  }
}

export function createVideoGenerationClient(
  options: VideoGenerationClientOptions,
): VideoGenerationClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    list(input) {
      const url = new URL("/api/video/jobs", options.baseUrl);
      url.searchParams.set("threadKind", input.threadKind);
      url.searchParams.set("scopeId", String(input.scopeId));
      return requestJson(
        options,
        url.pathname + url.search,
        { method: "GET", headers },
        decodeHostAnswer(VideoJobsResponse),
      );
    },
    stop(jobId) {
      return requestJson(
        options,
        `/api/video/jobs/${String(jobId)}/stop`,
        { method: "POST", headers },
        decodeHostAnswer(VideoJob),
      );
    },
    async clipUrl(jobId) {
      const ticket = await requestJson(
        options,
        `/api/video/jobs/${String(jobId)}/clip-ticket`,
        { method: "POST", headers },
        decodeHostAnswer(VideoClipTicketResponse),
      );
      return {
        url: new URL(ticket.url, options.baseUrl).toString(),
        expiresAt: String(ticket.expiresAt),
      };
    },
  };
}

async function requestJson<T>(
  options: VideoGenerationClientOptions,
  path: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await options.fetch(new URL(path, options.baseUrl).toString(), init);
  } catch {
    throw new VideoGenerationClientFailure("Video clips are unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new VideoGenerationClientFailure("Video returned an invalid response.", response.status);
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : "Video request failed.";
    throw new VideoGenerationClientFailure(message, response.status);
  }
  try {
    return decode(body);
  } catch {
    throw new VideoGenerationClientFailure(
      "Video response did not match the contract.",
      response.status,
    );
  }
}

/** A paired client can list and watch a thread's clips; it does not stop jobs. */
export type ThreadVideoResults = Pick<VideoGenerationClient, "list" | "clipUrl">;

/** At most this many bytes in one remote clip; a larger clip is refused, not truncated. */
const MAX_REMOTE_CLIP_BYTES = 512 * 1024 * 1024;

/**
 * Clips for a paired browser, whose requests travel over the remote session
 * rather than to an address a `<video>` element could load. The clip is read
 * through that session in byte ranges and played from a `blob:` URL the
 * caller revokes when it is done.
 */
export function createThreadVideoResults(
  options: VideoGenerationClientOptions,
): ThreadVideoResults {
  const client = createVideoGenerationClient(options);
  return {
    list: client.list,
    async clipUrl(jobId) {
      const ticket = await client.clipUrl(jobId);
      const chunks: Array<ArrayBuffer> = [];
      let offset = 0;
      let size: number | undefined;
      while (size === undefined || offset < size) {
        const response = await options.fetch(ticket.url, {
          headers: { range: `bytes=${String(offset)}-` },
        });
        if (!response.ok)
          throw new VideoGenerationClientFailure("The clip is unavailable.", response.status);
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        const body = await response.arrayBuffer();
        size = range === null ? body.byteLength : Number(range[3]);
        if (size > MAX_REMOTE_CLIP_BYTES) {
          throw new VideoGenerationClientFailure(
            "The clip is too large to play here; download it on the host.",
            413,
          );
        }
        if (body.byteLength === 0) break;
        chunks.push(body);
        offset += body.byteLength;
      }
      return {
        url: URL.createObjectURL(new Blob(chunks, { type: "video/mp4" })),
        // A blob URL does not expire; the caller revokes it.
        expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      };
    },
  };
}
