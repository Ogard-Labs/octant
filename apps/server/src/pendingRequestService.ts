import { createHash } from "node:crypto";
import type { PendingQuestionDeferral, WaitingAsk } from "@octant/contracts/pending-requests";
import {
  decodePendingRequestList,
  MAX_PENDING_REQUESTS,
  type PendingRequest,
  type PendingRequestList,
  type ProductSurfaceSettings,
  type TurnDecisionReview,
  type WindowId,
} from "@octant/contracts";
import { enabledModes } from "@octant/domain";

/**
 * Who reads the list: a window of this computer or a paired device, by the
 * service scope its authenticated principal resolved to. The services that
 * hold asks decide differently for the two, so the kind travels with the
 * scope instead of being guessed from it.
 */
export interface PendingRequestReader {
  readonly kind: "local-window" | "remote-device";
  readonly scopeId: WindowId;
}

export interface PendingRequestSources {
  readonly deferrals?: {
    readonly read: (key: string) => string | undefined;
    readonly record: (change: PendingQuestionDeferral) => void;
  };
  /**
   * The second opinion on a decision, by the decision's identity key. It
   * reads what is already known and queues a review in the background, so
   * listing never waits on a model.
   */
  readonly reviews?: {
    readonly reviewFor: (
      key: string,
      decision: Extract<PendingRequest, { readonly kind: "decision" }>,
    ) => TurnDecisionReview | undefined;
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
  /**
   * Every other ask waiting on the person that this reader could answer: MCP
   * tool approvals, Project memory and routine proposals, image offers, and
   * Browser approvals and sign-in cards, a host-run turn's among them. Each
   * comes from its holding service's own list for the reader, and is answered
   * through that service's own route.
   */
  readonly asks?: (reader: PendingRequestReader) => ReadonlyArray<WaitingAsk>;
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

  async list(
    windowId: WindowId,
    readerKind: PendingRequestReader["kind"] = "local-window",
  ): Promise<PendingRequestList> {
    const modes = enabledModes(this.#sources.readSettings());
    const asks = (this.#sources.asks?.({ kind: readerKind, scopeId: windowId }) ?? [])
      .filter((ask) => modes.includes(ask.mode))
      .toSorted(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.askId.localeCompare(right.askId),
      );
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
        const review =
          request.kind === "decision"
            ? this.#sources.reviews?.reviewFor(deferralKeyOf(request), request)
            : undefined;
        const reviewed = review === undefined ? request : { ...request, review };
        if (
          (request.kind !== "question" && request.kind !== "decision") ||
          this.#sources.deferrals === undefined
        )
          return reviewed;
        const deferralKey = deferralKeyOf(request);
        const until = this.#sources.deferrals.read(deferralKey);
        return {
          ...reviewed,
          deferralKey,
          ...(until !== undefined && Date.parse(until) > (this.#sources.now?.() ?? Date.now())
            ? { deferredUntil: until }
            : {}),
        };
      }),
      truncated: oldestFirst.length > MAX_PENDING_REQUESTS,
      // Absent when nothing waits, so the list reads as it did before asks.
      ...(asks.length === 0 ? {} : { asks: asks.slice(0, MAX_PENDING_REQUESTS) }),
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
