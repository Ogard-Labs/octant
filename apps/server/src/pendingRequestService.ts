import { createHash } from "node:crypto";
import type { PendingQuestionDeferral } from "@octant/contracts/pending-requests";
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
  readonly deferrals?: {
    readonly read: (key: string) => string | undefined;
    readonly record: (change: PendingQuestionDeferral) => void;
  };
  readonly now?: () => number;
  readonly readSettings: () => ProductSurfaceSettings;
  /** Work requests this window could answer, under the Work request service's own access check. */
  readonly work: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  /** Code requests this window could answer, under the scope the Code answer commands pass. */
  readonly code: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  /** Chat questions a running attempt is parked on; Chat has no per-window authority. */
  readonly chat: () => ReadonlyArray<PendingRequest>;
  /**
   * Subagents, and the agent itself, waiting on the person in a thread this
   * window can open. These rows carry no answer: they find the request, and
   * answering stays on the harness session route, in the thread's own approval
   * card or its Agents tab.
   */
  readonly children: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
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

  async defer(
    windowId: WindowId,
    change: PendingQuestionDeferral,
    current: () => boolean,
  ): Promise<boolean> {
    if (this.#sources.deferrals === undefined) return false;
    if (
      change.until !== null &&
      (!Number.isFinite(Date.parse(change.until)) ||
        Date.parse(change.until) <= (this.#sources.now?.() ?? Date.now()))
    )
      return false;
    const list = await this.list(windowId);
    if (
      !current() ||
      !list.requests.some(
        (request) =>
          (request.kind === "question" || request.kind === "decision") &&
          request.deferralKey === change.key &&
          enabledModes(this.#sources.readSettings()).includes(request.mode),
      )
    )
      return false;
    this.#sources.deferrals.record(change);
    return true;
  }

  async list(windowId: WindowId): Promise<PendingRequestList> {
    const modes = enabledModes(this.#sources.readSettings());
    const [work, code, children] = await Promise.all([
      modes.includes("work") ? this.#sources.work(windowId) : [],
      this.#sources.code(windowId),
      this.#sources.children(windowId),
    ]);
    const chat = modes.includes("chat") ? this.#sources.chat() : [];
    const oldestFirst = [
      ...work,
      ...code,
      ...chat,
      ...children.filter((request) => modes.includes(request.mode)),
    ].sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        requestKey(left).localeCompare(requestKey(right)),
    );
    return decodePendingRequestList({
      requests: oldestFirst.slice(0, MAX_PENDING_REQUESTS).map((request) => {
        if (
          (request.kind !== "question" && request.kind !== "decision") ||
          this.#sources.deferrals === undefined
        )
          return request;
        const deferralKey = deferralKeyOf(request);
        const until = this.#sources.deferrals.read(deferralKey);
        return {
          ...request,
          deferralKey,
          ...(until !== undefined && Date.parse(until) > (this.#sources.now?.() ?? Date.now())
            ? { deferredUntil: until }
            : {}),
        };
      }),
      truncated: oldestFirst.length > MAX_PENDING_REQUESTS,
    });
  }
}

/** A stable tiebreak, so two requests asked in the same millisecond keep one order. */
function requestKey(request: PendingRequest): string {
  const handle =
    request.kind === "child-approval" || request.kind === "child-question"
      ? `${request.kind}:${String(request.child.runId)}:${request.text}`
      : request.kind === "lead-approval" || request.kind === "lead-question"
        ? `${request.kind}:${request.text}`
        : JSON.stringify(request.answer);
  return `${request.mode}:${String(request.threadId)}:${handle}`;
}

function deferralKeyOf(request: PendingRequest): string {
  // A decision is the ask of one finished turn and never changes, while its
  // answer authority follows the thread's current model. So its identity is
  // the turn that asked, and a later turn's decision starts undeferred.
  if (request.kind === "decision") {
    const turn =
      request.mode === "code" ? String(request.answer.operationId) : String(request.answer.turnId);
    return createHash("sha256")
      .update(`decision:${request.mode}:${String(request.threadId)}:${turn}`)
      .digest("hex");
  }
  // Identity, choices, version and authority context participate. A changed
  // request cannot inherit a former question's attention preference.
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
