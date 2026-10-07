import {
  decodePendingRequestList,
  MAX_PENDING_REQUESTS,
  type PendingRequest,
  type PendingRequestList,
  type ProductSurfaceSettings,
  type WindowId,
} from "@octant/contracts";
import { enabledModes } from "@octant/domain";

export interface PendingRequestSources {
  readonly readSettings: () => ProductSurfaceSettings;
  /** Work requests this window could answer, under the Work request service's own access check. */
  readonly work: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  /** Code requests this window could answer, under the scope the Code answer commands pass. */
  readonly code: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  /** Chat questions a running attempt is parked on; Chat has no per-window authority. */
  readonly chat: () => ReadonlyArray<PendingRequest>;
}

/**
 * Every approval and question a window can answer, across modes and
 * Projects. It adds no authority of its own: each mode lists only what its
 * existing answer command would admit for this window, and a disabled mode is
 * not asked at all. A mode that cannot be read fails the whole read rather
 * than returning a list that silently leaves its requests out.
 */
export class PendingRequestService {
  readonly #sources: PendingRequestSources;

  constructor(sources: PendingRequestSources) {
    this.#sources = sources;
  }

  async list(windowId: WindowId): Promise<PendingRequestList> {
    const modes = enabledModes(this.#sources.readSettings());
    const [work, code] = await Promise.all([
      modes.includes("work") ? this.#sources.work(windowId) : [],
      this.#sources.code(windowId),
    ]);
    const chat = modes.includes("chat") ? this.#sources.chat() : [];
    const oldestFirst = [...work, ...code, ...chat].sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        requestKey(left).localeCompare(requestKey(right)),
    );
    return decodePendingRequestList({
      requests: oldestFirst.slice(0, MAX_PENDING_REQUESTS),
      truncated: oldestFirst.length > MAX_PENDING_REQUESTS,
    });
  }
}

/** A stable tiebreak, so two requests asked in the same millisecond keep one order. */
function requestKey(request: PendingRequest): string {
  return `${request.mode}:${String(request.threadId)}:${JSON.stringify(request.answer)}`;
}
