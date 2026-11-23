import {
  THREAD_VIDEO_ARCHIVE_PATH,
  ThreadExportOutcome,
  ThreadVideoArchiveOffer,
  type ThreadExportRequest,
} from "@octant/contracts/thread-export";
import {
  decodeHostAnswer,
  ThreadToolCallRecordsResult,
  type ThreadToolCallRecordsRequest,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadExportClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThreadExportClient {
  exportThread(request: ThreadExportRequest): Promise<ThreadExportOutcome>;
  /** Undefined means the host predates video archives. */
  offerArchive?(request: ThreadExportRequest): Promise<ThreadVideoArchiveOffer | undefined>;
  /** One turn's kept tool-call records. A refusal is an answer, not a thrown error. */
  readToolCallRecords(request: ThreadToolCallRecordsRequest): Promise<ThreadToolCallRecordsResult>;
}

export class ThreadExportClientError extends Error {
  override readonly name = "ThreadExportClientError";
  constructor(message: string) {
    super(message);
  }
}

const EXPORT_TIMEOUT_MS = 30_000;

export function createThreadExportClient(options: ThreadExportClientOptions): ThreadExportClient {
  const resolvedFetch = bindFetchPort(options.fetch);
  /** Both commands answer a refusal as a 401 or 404 body the caller decodes. */
  const post = async (path: string, label: string, request: unknown) => {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      response = await resolvedFetch(new URL(path, options.baseUrl).toString(), {
        method: "POST",
        headers: {
          "x-octant-window-capability": options.windowCapability,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      throw new ThreadExportClientError(`${label} is unavailable.`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok && response.status !== 404 && response.status !== 401) {
      throw new ThreadExportClientError(`${label} failed with status ${response.status}.`);
    }

    try {
      const body: unknown = await response.json();
      return { status: response.status, body };
    } catch {
      if (path === THREAD_VIDEO_ARCHIVE_PATH && response.status === 404) {
        return { status: response.status, body: undefined };
      }
      throw new ThreadExportClientError(`${label} returned an invalid response.`);
    }
  };
  return {
    async exportThread(request) {
      const { body } = await post("/api/threads/export", "Thread export", request);
      try {
        return decodeHostAnswer(ThreadExportOutcome)(body);
      } catch {
        throw new ThreadExportClientError("Thread export returned an invalid response.");
      }
    },
    async offerArchive(request) {
      const { status, body } = await post(
        THREAD_VIDEO_ARCHIVE_PATH,
        "Thread video archive",
        request,
      );
      try {
        const offer = decodeHostAnswer(ThreadVideoArchiveOffer)(body);
        return offer.kind === "archive-ready"
          ? { ...offer, url: new URL(offer.url, options.baseUrl).toString() }
          : offer;
      } catch {
        if (status === 404) return undefined;
        throw new ThreadExportClientError("Thread video archive returned an invalid response.");
      }
    },
    async readToolCallRecords(request) {
      const { body } = await post("/api/threads/tool-call-records", "Tool-call records", request);
      try {
        return decodeHostAnswer(ThreadToolCallRecordsResult)(body);
      } catch {
        throw new ThreadExportClientError("Tool-call records returned an invalid response.");
      }
    },
  };
}
