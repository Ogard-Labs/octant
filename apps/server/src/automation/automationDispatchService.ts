import {
  decodeChatThreadId,
  type AutomationBlockReason,
  type AutomationDefinition,
  type AutomationDispatchIntent,
  type AutomationId,
  type AutomationRun,
  type AutomationRunFailureReason,
  type AutomationRuntimeLaunchClaim,
  type AutomationThreadId,
  type CodeThreadId,
  type WorkThreadId,
  type UtcTimestamp,
} from "@octant/contracts";
import { decideAutomationFollowUp, type AutomationFollowUpThreadFacts } from "@octant/domain";
import {
  automationPromptDigest,
  revalidateAutomationAuthority,
  type AutomationAuthorityLiveFacts,
} from "./automationAuthorityRevalidation";
export { buildAutomationAuthorityFactsFromHost } from "./automationAuthorityRevalidation";
import type { AutomationDispatchOffer, AutomationDispatchPort } from "./automationDispatchPort";
import type { AutomationEventStore } from "./automationEventStore";
import { AutomationEventStoreError } from "./automationEventStore";
import type { AutomationProjection } from "./automationProjection";
import { deterministicAutomationUuid } from "./automationRunIdentity";
import type {
  AutomationCapacityAdmissionPort,
  AutomationChatDispatchPort,
  AutomationCodeDispatchPort,
  AutomationWorkDispatchPort,
} from "./automationModeDispatchPorts";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";

export interface AutomationDispatchServiceOptions {
  readonly store: Pick<
    AutomationEventStore,
    | "appendRunStatusChanged"
    | "appendOccurrenceLedger"
    | "appendDispatchIntentRecorded"
    | "appendFirstTurnRuntimeClaimed"
    | "appendFirstTurnAccepted"
  >;
  readonly projection: AutomationProjection;
  readonly code: AutomationCodeDispatchPort;
  readonly work: AutomationWorkDispatchPort;
  /** Absent, a Chat routine is refused as `unsupported-mode`. */
  readonly chat?: AutomationChatDispatchPort;
  readonly capacity: AutomationCapacityAdmissionPort;
  readonly resolveFacts: (input: {
    readonly definition: AutomationDefinition;
    readonly run: AutomationRun;
  }) => AutomationAuthorityLiveFacts;
  /**
   * What the host knows now of a follow-up's own thread. Absent, every
   * follow-up is refused as `thread-unavailable`: a dispatcher that cannot
   * see the thread never sends a turn into it.
   */
  readonly readFollowUpThread?: (input: {
    readonly mode: AutomationRun["definitionSnapshot"]["mode"];
    readonly threadId: AutomationThreadId;
  }) => AutomationFollowUpThreadFacts;
  readonly now: () => UtcTimestamp;
  readonly launchClaimLeaseMs?: number;
  /**
   * Optional async runner. Defaults to fire-and-forget Promise resolution so
   * the scheduler `offer` seam stays synchronous while dispatch continues.
   */
  readonly schedule?: (work: () => Promise<void>) => void;
  /**
   * Optional notification observer. Called after successful status journal
   * appends. Failures here must never change run lifecycle.
   */
  readonly onRunStatusChanged?: (input: {
    readonly run: AutomationRun;
    readonly previousLifecycle: AutomationRun["lifecycle"];
  }) => void;
}

const DEFAULT_LAUNCH_CLAIM_LEASE_MS = 300_000;

/**
 * A4 ordinary-thread dispatcher. Consumes durable scheduler offers, revalidates
 * authority, creates at most one ordinary Work/Code thread per occurrence,
 * journals the immutable creation receipt as a dispatch intent, serializes
 * first-turn launch with a lease-backed claim, and links acceptance to the run.
 * Approval/wait/failure/cancellation/completion after acceptance remain
 * ordinary thread truth.
 */
export class AutomationDispatchService implements AutomationDispatchPort {
  readonly #store: AutomationDispatchServiceOptions["store"];
  readonly #projection: AutomationProjection;
  readonly #code: AutomationCodeDispatchPort;
  readonly #work: AutomationWorkDispatchPort;
  readonly #chat: AutomationChatDispatchPort | undefined;
  readonly #capacity: AutomationCapacityAdmissionPort;
  readonly #resolveFacts: AutomationDispatchServiceOptions["resolveFacts"];
  readonly #readFollowUpThread: AutomationDispatchServiceOptions["readFollowUpThread"];
  readonly #now: () => UtcTimestamp;
  readonly #launchClaimLeaseMs: number;
  readonly #schedule: (work: () => Promise<void>) => void;
  readonly #onRunStatusChanged: AutomationDispatchServiceOptions["onRunStatusChanged"];
  readonly #inflight = new Set<string>();

  constructor(options: AutomationDispatchServiceOptions) {
    this.#store = options.store;
    this.#projection = options.projection;
    this.#code = options.code;
    this.#work = options.work;
    this.#chat = options.chat;
    this.#capacity = options.capacity;
    this.#resolveFacts = options.resolveFacts;
    this.#readFollowUpThread = options.readFollowUpThread;
    this.#now = options.now;
    this.#launchClaimLeaseMs = options.launchClaimLeaseMs ?? DEFAULT_LAUNCH_CLAIM_LEASE_MS;
    this.#schedule =
      options.schedule ??
      ((work) => {
        void work();
      });
    this.#onRunStatusChanged = options.onRunStatusChanged;
  }

  offer(offer: AutomationDispatchOffer): void {
    const key = `${String(offer.run.id)}:${offer.run.lifecycle}:${offer.run.version}`;
    if (this.#inflight.has(key)) return;
    this.#inflight.add(key);
    this.#schedule(async () => {
      try {
        await this.#dispatch(offer.definition.id, offer.run.id);
      } finally {
        this.#inflight.delete(key);
      }
    });
  }

  /** Test/helper entry: process one run to completion of the dispatch attempt. */
  async dispatchNow(definitionId: AutomationId, runId: AutomationRun["id"]): Promise<void> {
    await this.#dispatch(definitionId, runId);
  }

  async #dispatch(definitionId: AutomationId, runId: AutomationRun["id"]): Promise<void> {
    const definition = this.#projection.getDefinition(definitionId);
    let run = this.#projection.getRun(runId);
    if (definition === undefined || run === undefined) return;
    if (run.cancellationTombstone !== undefined) return;
    if (run.firstTurnAcceptance !== undefined) return;

    if (run.lifecycle === "queued" || run.lifecycle === "recovering-dispatch") {
      const moved = this.#moveToDispatching(definition, run);
      if (!moved) return;
      run = this.#projection.getRun(runId);
      if (run === undefined) return;
    }

    if (run.dispatchIntent === undefined) {
      const revalidation = revalidateAutomationAuthority({
        definition,
        run,
        facts: this.#resolveFacts({ definition, run }),
      });
      if (revalidation.kind === "blocked") {
        this.#refuse(definition, run, revalidation.reason, revalidation.message);
        return;
      }
      if (run.definitionSnapshot.mode === "work" && !this.#work.available) {
        this.#refuse(
          definition,
          run,
          "unsupported-mode",
          this.#work.unavailableReason ??
            "Work first-turn runtime is unavailable for Automation dispatch.",
        );
        return;
      }
      if (run.definitionSnapshot.mode === "chat" && this.#chat === undefined) {
        this.#refuse(
          definition,
          run,
          "unsupported-mode",
          "Chat first-turn runtime is unavailable for Automation dispatch.",
        );
        return;
      }
      const created =
        run.definitionSnapshot.targetPolicy === "same-thread"
          ? this.#targetOriginThread(definition, run)
          : await this.#createThread(definition, run);
      if (created === undefined) return;
      run = this.#projection.getRun(runId);
      if (run === undefined || run.dispatchIntent === undefined) return;
    }

    run = this.#projection.getRun(runId);
    if (run === undefined || run.dispatchIntent === undefined) return;
    if (run.cancellationTombstone !== undefined) return;

    const claim = this.#acquireLaunchClaim(run);
    if (claim === undefined) return;
    run = this.#projection.getRun(runId);
    if (run === undefined || run.runtimeLaunchClaim === undefined) return;

    const capacity = this.#capacity.admit({
      reservationId: String(run.firstTurnRequestId),
      providerInstanceId: String(run.definitionSnapshot.executionProfile.providerInstanceId),
      modelId: String(run.definitionSnapshot.executionProfile.modelId),
      subjectThreadId: String(run.dispatchIntent!.threadId),
    });
    if (capacity.kind === "waiting") {
      // Leave the expired/absent claim path free for a later recovery offer.
      return;
    }

    try {
      const launch = await this.#launchFirstTurn(run);
      if (launch.kind === "waiting-capacity") return;
      if (launch.kind === "failed") {
        if (launch.reason === "cancelled") return;
        this.#failRun(run, launch.reason, launch.message);
        return;
      }
      run = this.#projection.getRun(runId);
      if (run === undefined) return;
      this.#recordAcceptance(run, launch.runtimeReceipt, launch.acceptedAt);
      run = this.#projection.getRun(runId);
      if (run === undefined || run.firstTurnAcceptance === undefined) return;
      this.#markRunning(run);
    } finally {
      capacity.release();
    }
  }

  #moveToDispatching(definition: AutomationDefinition, run: AutomationRun): boolean {
    if (run.lifecycle !== "queued" && run.lifecycle !== "recovering-dispatch") return true;
    const now = this.#now();
    try {
      this.#store.appendRunStatusChanged({
        automationId: definition.id,
        runId: run.id,
        previousLifecycle: run.lifecycle,
        lifecycle: "dispatching",
        version: run.version + 1,
        expectedVersion: run.version,
        updatedAt: now,
      });
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  /**
   * A follow-up creates no thread: it goes back to the one it came from,
   * after that thread passes the follow-up's fire-time checks. A refusal
   * fails the run with its typed reason and the once trigger then ends the
   * routine, so a follow-up never runs twice and never waits paused.
   */
  #targetOriginThread(
    definition: AutomationDefinition,
    run: AutomationRun,
  ): AutomationThreadId | undefined {
    const threadId = definition.originThreadId;
    const snapshot = run.definitionSnapshot;
    const decision = decideAutomationFollowUp({
      projectId: String(snapshot.projectId),
      providerInstanceId: String(snapshot.executionProfile.providerInstanceId),
      modelId: String(snapshot.executionProfile.modelId),
      scheduledAt: run.scheduledAt ?? run.claimedAt,
      now: this.#now(),
      thread:
        threadId === undefined || this.#readFollowUpThread === undefined
          ? { kind: "missing" }
          : this.#readFollowUpThread({ mode: snapshot.mode, threadId }),
    });
    if (threadId === undefined || decision.kind === "blocked") {
      const blocked =
        decision.kind === "blocked"
          ? decision
          : { reason: "thread-unavailable" as const, message: "The follow-up has no thread." };
      this.#failRun(run, blocked.reason, blocked.message);
      return undefined;
    }
    return this.#recordIntent(definition, run, threadId);
  }

  async #createThread(
    definition: AutomationDefinition,
    run: AutomationRun,
  ): Promise<AutomationThreadId | undefined> {
    const threadId = automationThreadIdForOccurrence(String(run.occurrenceKey));
    const title = automationThreadTitle(definition.displayName);
    const mode = run.definitionSnapshot.mode;
    const outcome =
      mode === "code"
        ? await this.#code.createApprovalGatedThread({
            run,
            threadId: threadId as unknown as CodeThreadId,
            title,
            scopeId: ROUTINE_HOST_SCOPE_ID,
          })
        : mode === "chat" && this.#chat !== undefined
          ? await this.#chat.createThread({
              run,
              threadId: decodeChatThreadId(String(threadId)),
              title,
            })
          : await this.#work.createThread({
              run,
              threadId: threadId as unknown as WorkThreadId,
              title,
              scopeId: ROUTINE_HOST_SCOPE_ID,
            });
    if (outcome.kind === "failed") {
      this.#failRun(run, "thread-creation-failed", outcome.message);
      return undefined;
    }
    return this.#recordIntent(definition, run, outcome.threadId);
  }

  #recordIntent(
    definition: AutomationDefinition,
    run: AutomationRun,
    threadId: AutomationThreadId,
  ): AutomationThreadId | undefined {
    const now = this.#now();
    const intent: AutomationDispatchIntent = {
      firstTurnRequestId: run.firstTurnRequestId,
      threadId,
      authoritySnapshot: run.authoritySnapshot,
      promptDigest: automationPromptDigest(run.definitionSnapshot.taskPrompt),
      recordedAt: now,
    };
    const current = this.#projection.getRun(run.id);
    if (current === undefined) return undefined;
    try {
      this.#store.appendDispatchIntentRecorded({
        automationId: definition.id,
        runId: current.id,
        intent,
        expectedVersion: current.version,
      });
    } catch (error) {
      if (isConflict(error)) {
        const after = this.#projection.getRun(run.id);
        return after?.dispatchIntent?.threadId;
      }
      throw error;
    }
    return threadId;
  }

  #acquireLaunchClaim(run: AutomationRun): AutomationRuntimeLaunchClaim | undefined {
    if (run.cancellationTombstone !== undefined) return undefined;
    const existing = run.runtimeLaunchClaim;
    const now = this.#now();
    const nowMs = Date.parse(now);
    if (existing !== undefined && nowMs < Date.parse(existing.leaseExpiresAt)) {
      return existing;
    }
    const generation = (existing === undefined ? 1 : existing.generation + 1) as never;
    const claim: AutomationRuntimeLaunchClaim = {
      firstTurnRequestId: run.firstTurnRequestId,
      generation,
      claimedAt: now,
      leaseExpiresAt: new Date(nowMs + this.#launchClaimLeaseMs).toISOString() as UtcTimestamp,
    };
    try {
      this.#store.appendFirstTurnRuntimeClaimed({
        automationId: run.automationId,
        runId: run.id,
        claim,
        expectedVersion: run.version,
      });
      return claim;
    } catch (error) {
      if (isConflict(error)) return undefined;
      throw error;
    }
  }

  async #launchFirstTurn(run: AutomationRun): Promise<
    | {
        readonly kind: "accepted";
        readonly runtimeReceipt: string;
        readonly acceptedAt: UtcTimestamp;
      }
    | { readonly kind: "waiting-capacity"; readonly message: string }
    | {
        readonly kind: "failed";
        readonly reason: "provider-launch-failed" | "recovery-failed" | "cancelled";
        readonly message: string;
      }
  > {
    const intent = run.dispatchIntent;
    if (intent === undefined) {
      return {
        kind: "failed",
        reason: "recovery-failed",
        message: "Automation dispatch intent is missing.",
      };
    }
    const latest = this.#projection.getRun(run.id);
    if (latest?.cancellationTombstone !== undefined) {
      return { kind: "failed", reason: "cancelled", message: "Automation run was cancelled." };
    }
    if (run.definitionSnapshot.mode === "code") {
      return this.#code.startOrRecoverFirstTurn({
        run,
        threadId: intent.threadId as unknown as CodeThreadId,
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: intent.promptDigest,
        scopeId: ROUTINE_HOST_SCOPE_ID,
      });
    }
    if (run.definitionSnapshot.mode === "chat" && this.#chat !== undefined) {
      return this.#chat.startOrRecoverFirstTurn({
        run,
        threadId: decodeChatThreadId(String(intent.threadId)),
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: intent.promptDigest,
      });
    }
    return this.#work.startOrRecoverFirstTurn({
      run,
      threadId: intent.threadId as unknown as WorkThreadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: intent.promptDigest,
      scopeId: ROUTINE_HOST_SCOPE_ID,
    });
  }

  #recordAcceptance(run: AutomationRun, runtimeReceipt: string, acceptedAt: UtcTimestamp): void {
    try {
      this.#store.appendFirstTurnAccepted({
        automationId: run.automationId,
        runId: run.id,
        receipt: {
          firstTurnRequestId: run.firstTurnRequestId,
          runtimeReceipt: runtimeReceipt as never,
          acceptedAt,
        },
        expectedVersion: run.version,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  #markRunning(run: AutomationRun): void {
    const current = this.#projection.getRun(run.id);
    if (current === undefined || current.lifecycle !== "dispatching") return;
    if (current.firstTurnAcceptance === undefined) return;
    try {
      this.#store.appendRunStatusChanged({
        automationId: current.automationId,
        runId: current.id,
        previousLifecycle: current.lifecycle,
        lifecycle: "running",
        version: current.version + 1,
        expectedVersion: current.version,
        updatedAt: this.#now(),
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  /** A follow-up ends on a refusal; any other routine is paused with the reason. */
  #refuse(
    definition: AutomationDefinition,
    run: AutomationRun,
    reason: AutomationBlockReason,
    message: string,
  ): void {
    if (run.definitionSnapshot.targetPolicy === "same-thread") this.#failRun(run, reason, message);
    else this.#failAndBlock(definition, run, reason, message);
  }

  #failAndBlock(
    definition: AutomationDefinition,
    run: AutomationRun,
    reason: AutomationBlockReason,
    message: string,
  ): void {
    this.#failRun(run, reason, message);
    const currentDefinition = this.#projection.getDefinition(definition.id);
    if (currentDefinition === undefined) return;
    if (currentDefinition.lifecycle !== "enabled") return;
    try {
      this.#store.appendOccurrenceLedger({
        automationId: currentDefinition.id,
        expectedVersion: currentDefinition.version,
        events: [
          {
            kind: "blocked",
            reason,
            runId: run.id,
            at: this.#now(),
          },
        ],
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  #failRun(run: AutomationRun, reason: AutomationRunFailureReason, message: string): void {
    const current = this.#projection.getRun(run.id);
    if (current === undefined) return;
    if (
      current.lifecycle === "failed" ||
      current.lifecycle === "cancelled" ||
      current.lifecycle === "completed" ||
      current.lifecycle === "interrupted" ||
      current.lifecycle === "skipped"
    ) {
      return;
    }
    const previousLifecycle = current.lifecycle;
    try {
      this.#store.appendRunStatusChanged({
        automationId: current.automationId,
        runId: current.id,
        previousLifecycle,
        lifecycle: "failed",
        version: current.version + 1,
        expectedVersion: current.version,
        failure: { reason, message: sanitizeFailureMessage(message) },
        updatedAt: this.#now(),
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      return;
    }
    const updated = this.#projection.getRun(run.id);
    if (updated !== undefined) {
      try {
        this.#onRunStatusChanged?.({ run: updated, previousLifecycle });
      } catch {
        // Notification failure never changes run lifecycle truth.
      }
    }
  }
}

export function automationThreadIdForOccurrence(occurrenceKey: string): AutomationThreadId {
  return deterministicAutomationUuid(`automation-thread:${occurrenceKey}`) as AutomationThreadId;
}

export function automationThreadTitle(displayName: string): string {
  const trimmed = displayName.trim();
  return trimmed.length === 0 ? "Automation" : `Automation: ${trimmed}`;
}

function isConflict(error: unknown): boolean {
  return error instanceof AutomationEventStoreError && error.category === "conflict";
}

function sanitizeFailureMessage(message: string): string {
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "Automation dispatch failed.";
  return trimmed.length <= 512 ? trimmed : `${trimmed.slice(0, 509)}...`;
}
