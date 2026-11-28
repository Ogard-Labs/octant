import { automationDispatchPromptText } from "./automationFileContext";
import {
  decodeAutomationCancelRunRequestId,
  decodeChatThreadId,
  personalSignInRefusals,
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
  type WindowId,
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
import { isRoutineHostScope, ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";

export interface AutomationDispatchServiceOptions {
  readonly store: Pick<
    AutomationEventStore,
    | "appendRunStatusChanged"
    | "appendOccurrenceLedger"
    | "appendDispatchIntentRecorded"
    | "appendFirstTurnRuntimeClaimed"
    | "appendFirstTurnAccepted"
    | "appendRunCancellation"
  >;
  readonly projection: AutomationProjection;
  readonly code: AutomationCodeDispatchPort;
  readonly work: AutomationWorkDispatchPort;
  /** Absent, a Chat routine is refused as `unsupported-mode`. */
  readonly chat?: AutomationChatDispatchPort;
  readonly capacity: AutomationCapacityAdmissionPort;
  /**
   * True while the host drains before an update. A run then waits without a
   * thread, and the scheduler's lease recovery offers it again once the drain
   * lifts or the updated host starts.
   */
  readonly refusesNewRuns?: () => boolean;
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
  /** Settings' `followUpLatenessLimitHours`, read at each offer; absent is one day. */
  readonly followUpLatenessLimitHours?: () => number;
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
  /**
   * Checks whether a window or paired-device scope that confirmed a run is
   * still active before launching on a same-process re-offer.
   */
  readonly isConfirmedScopeCurrent?: (windowId: WindowId) => boolean;
  /**
   * When a `thread-finished` follow-up resumes a coordinator thread (Action 1),
   * counts the turn in the coordinator's hourly wake bound and refuses if the
   * bound is exceeded. Starts no worker.
   */
  readonly admitCoordinatorWake?: (
    threadId: string,
    nowMs: number,
  ) => { readonly allowed: true } | { readonly allowed: false; readonly message: string };
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
  readonly #refusesNewRuns: (() => boolean) | undefined;
  readonly #resolveFacts: AutomationDispatchServiceOptions["resolveFacts"];
  readonly #readFollowUpThread: AutomationDispatchServiceOptions["readFollowUpThread"];
  readonly #followUpLatenessLimitHours: AutomationDispatchServiceOptions["followUpLatenessLimitHours"];
  readonly #now: () => UtcTimestamp;
  readonly #launchClaimLeaseMs: number;
  readonly #schedule: (work: () => Promise<void>) => void;
  readonly #onRunStatusChanged: AutomationDispatchServiceOptions["onRunStatusChanged"];
  readonly #isConfirmedScopeCurrent:
    | AutomationDispatchServiceOptions["isConfirmedScopeCurrent"]
    | undefined;
  readonly #admitCoordinatorWake:
    | AutomationDispatchServiceOptions["admitCoordinatorWake"]
    | undefined;
  readonly #inflight = new Set<string>();
  /**
   * In-memory only: remembers the person's confirming window across
   * same-process re-offers (busy follow-up or provider capacity waits),
   * revalidated before launch and cleared on acceptance or terminal states.
   * Restart recovery starts empty and fails closed.
   */
  readonly #confirmedScopes = new Map<string, WindowId>();

  constructor(options: AutomationDispatchServiceOptions) {
    this.#store = options.store;
    this.#projection = options.projection;
    this.#code = options.code;
    this.#work = options.work;
    this.#chat = options.chat;
    this.#capacity = options.capacity;
    this.#refusesNewRuns = options.refusesNewRuns;
    this.#resolveFacts = options.resolveFacts;
    this.#readFollowUpThread = options.readFollowUpThread;
    this.#followUpLatenessLimitHours = options.followUpLatenessLimitHours;
    this.#now = options.now;
    this.#launchClaimLeaseMs = options.launchClaimLeaseMs ?? DEFAULT_LAUNCH_CLAIM_LEASE_MS;
    this.#schedule =
      options.schedule ??
      ((work) => {
        void work();
      });
    this.#onRunStatusChanged = options.onRunStatusChanged;
    this.#isConfirmedScopeCurrent = options.isConfirmedScopeCurrent;
    this.#admitCoordinatorWake = options.admitCoordinatorWake;
  }

  offer(offer: AutomationDispatchOffer): void {
    if (offer.confirmedByWindowId !== undefined && !isRoutineHostScope(offer.confirmedByWindowId)) {
      this.#confirmedScopes.set(String(offer.run.id), offer.confirmedByWindowId);
    }
    const key = `${String(offer.run.id)}:${offer.run.lifecycle}:${offer.run.version}:${String(offer.confirmedByWindowId ?? "")}`;
    if (this.#inflight.has(key)) return;
    this.#inflight.add(key);
    this.#schedule(async () => {
      try {
        await this.#dispatch(offer.definition.id, offer.run.id, offer.confirmedByWindowId);
      } finally {
        this.#inflight.delete(key);
      }
    });
  }

  /** Test/helper entry: process one run to completion of the dispatch attempt. */
  async dispatchNow(
    definitionId: AutomationId,
    runId: AutomationRun["id"],
    confirmedByWindowId?: WindowId,
  ): Promise<void> {
    if (confirmedByWindowId !== undefined && !isRoutineHostScope(confirmedByWindowId)) {
      this.#confirmedScopes.set(String(runId), confirmedByWindowId);
    }
    await this.#dispatch(definitionId, runId, confirmedByWindowId);
  }

  async #dispatch(
    definitionId: AutomationId,
    runId: AutomationRun["id"],
    confirmedByWindowId?: WindowId,
  ): Promise<void> {
    const runKey = String(runId);
    const definition = this.#projection.getDefinition(definitionId);
    let run = this.#projection.getRun(runId);
    if (definition === undefined || run === undefined) {
      this.#confirmedScopes.delete(runKey);
      return;
    }
    if (run.cancellationTombstone !== undefined || run.firstTurnAcceptance !== undefined) {
      this.#confirmedScopes.delete(runKey);
      return;
    }
    if (run.lifecycle === "awaiting-confirmation") {
      if (
        definition.lifecycle === "archived" &&
        run.definitionSnapshot.targetPolicy === "same-thread"
      ) {
        this.#cancelArchivedFollowUp(run);
      }
      return;
    }

    const candidateScope = confirmedByWindowId ?? this.#confirmedScopes.get(runKey);
    const scopeValid =
      candidateScope !== undefined &&
      !isRoutineHostScope(candidateScope) &&
      (this.#isConfirmedScopeCurrent === undefined ||
        this.#isConfirmedScopeCurrent(candidateScope));
    if (candidateScope !== undefined && !scopeValid) {
      this.#confirmedScopes.delete(runKey);
    }
    const humanConfirmed = scopeValid;
    const turnScopeId = humanConfirmed ? candidateScope : undefined;

    if (run.lifecycle === "queued" || run.lifecycle === "recovering-dispatch") {
      const moved = this.#moveToDispatching(definition, run);
      if (!moved) return;
      run = this.#projection.getRun(runId);
      if (run === undefined) return;
    }

    // Moved to dispatching first, so the lease recovery offers it again:
    // left queued, the scheduler would not offer it until a restart. A run
    // that already holds its thread but waited for provider capacity is held
    // here too: turn admission would refuse its first turn during a drain, and
    // that refusal fails the run for good.
    if (this.#refusesNewRuns?.() === true) return;
    if (run.dispatchIntent === undefined) {
      const facts = this.#resolveFacts({ definition, run });
      const revalidation = revalidateAutomationAuthority({ definition, run, facts });
      if (revalidation.kind === "blocked") {
        this.#refuse(definition, run, revalidation.reason, revalidation.message);
        return;
      }
      // Checked here, not in the revalidation source polling and file arming
      // share, so a routine on a personal sign-in that does not permit
      // unattended runs keeps observing and holds each due run for explicit
      // human confirmation (or refuses it when the profile sets "refuse"),
      // before any thread exists. Read from the live instance, so a routine
      // saved earlier is handled too.
      const personal = personalSignInRefusals(facts.providerInstance);
      if (personal?.refusesUnattendedRuns !== undefined && !humanConfirmed) {
        if (personal.routineConfirmation === "prompt-human") {
          this.#markAwaitingConfirmation(definition, run);
          return;
        }
        this.#refuse(
          definition,
          run,
          "provider-capability-mismatch",
          personal.refusesUnattendedRuns,
        );
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
    } else if (!humanConfirmed) {
      // A run that already recorded its thread before a restart is never
      // recovered unattended on a personal sign-in that refuses unattended runs.
      const facts = this.#resolveFacts({ definition, run });
      const unattended = personalSignInRefusals(facts.providerInstance)?.refusesUnattendedRuns;
      if (unattended !== undefined) {
        this.#failRun(run, "provider-capability-mismatch", unattended);
        return;
      }
    }

    run = this.#projection.getRun(runId);
    if (run === undefined || run.dispatchIntent === undefined) return;
    if (run.cancellationTombstone !== undefined) return;

    const claim = this.#acquireLaunchClaim(run);
    if (claim === undefined) return;
    run = this.#projection.getRun(runId);
    if (run === undefined || run.runtimeLaunchClaim === undefined) return;

    // The ordinary Chat turn path admits its own provider capacity, so a Chat
    // run reserving here too would take a second slot for one turn.
    const capacity =
      run.definitionSnapshot.mode === "chat"
        ? ({ kind: "admitted", release: () => undefined } as const)
        : this.#capacity.admit({
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
      const launch = await this.#launchFirstTurn(run, turnScopeId);
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
   *
   * A busy thread is waited on: the run stays `dispatching` with no intent,
   * which is journaled, and the scheduler offers it again on every pass and
   * after a restart. Every check here runs again on each offer, so a thread
   * archived, or a follow-up cancelled or paused, during the wait is seen
   * before anything is sent.
   */
  #targetOriginThread(
    definition: AutomationDefinition,
    run: AutomationRun,
  ): AutomationThreadId | undefined {
    if (definition.lifecycle === "archived") {
      this.#cancelArchivedFollowUp(run);
      return undefined;
    }
    if (definition.lifecycle === "paused") return undefined;
    const threadId = definition.originThreadId;
    const snapshot = run.definitionSnapshot;
    const latenessLimitHours = this.#followUpLatenessLimitHours?.();
    const decision = decideAutomationFollowUp({
      ...(latenessLimitHours === undefined ? {} : { latenessLimitHours }),
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
    if (decision.kind === "waiting") return undefined;
    if (run.occurrence.kind === "thread-finished" && this.#admitCoordinatorWake !== undefined) {
      const wake = this.#admitCoordinatorWake(String(threadId), Date.parse(this.#now()));
      if (!wake.allowed) {
        this.#failRun(run, "authority-mismatch", wake.message);
        return undefined;
      }
    }
    return this.#recordIntent(definition, run, threadId);
  }

  /**
   * Archiving a follow-up is how a person cancels it. Its claimed run has
   * sent nothing yet, so it ends cancelled, as a run a person cancelled does.
   * The request id is derived from the run so a repeated offer is one receipt.
   */
  #cancelArchivedFollowUp(run: AutomationRun): void {
    this.#confirmedScopes.delete(String(run.id));
    const current = this.#projection.getRun(run.id);
    if (current === undefined || current.cancellationTombstone !== undefined) return;
    const now = this.#now();
    try {
      this.#store.appendRunCancellation({
        automationId: current.automationId,
        runId: current.id,
        previousLifecycle: current.lifecycle,
        tombstone: {
          requestId: decodeAutomationCancelRunRequestId(
            deterministicAutomationUuid(`automation-follow-up-archived:${String(current.id)}`),
          ),
          cancelledAt: now,
        },
        expectedVersion: current.version,
        updatedAt: now,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
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
      promptDigest: automationPromptDigest(automationDispatchPromptText(run)),
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

  async #launchFirstTurn(
    run: AutomationRun,
    turnScopeId?: WindowId,
  ): Promise<
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
        scopeId: turnScopeId ?? ROUTINE_HOST_SCOPE_ID,
      });
    }
    if (run.definitionSnapshot.mode === "chat" && this.#chat !== undefined) {
      return this.#chat.startOrRecoverFirstTurn({
        run,
        threadId: decodeChatThreadId(String(intent.threadId)),
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: intent.promptDigest,
        ...(turnScopeId === undefined ? {} : { windowId: turnScopeId }),
      });
    }
    return this.#work.startOrRecoverFirstTurn({
      run,
      threadId: intent.threadId as unknown as WorkThreadId,
      firstTurnRequestId: run.firstTurnRequestId,
      promptDigest: intent.promptDigest,
      scopeId: turnScopeId ?? ROUTINE_HOST_SCOPE_ID,
    });
  }

  #recordAcceptance(run: AutomationRun, runtimeReceipt: string, acceptedAt: UtcTimestamp): void {
    this.#confirmedScopes.delete(String(run.id));
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

  #markAwaitingConfirmation(definition: AutomationDefinition, run: AutomationRun): void {
    const current = this.#projection.getRun(run.id);
    if (current === undefined || current.lifecycle === "awaiting-confirmation") return;
    if (
      current.dispatchIntent !== undefined ||
      current.firstTurnAcceptance !== undefined ||
      current.cancellationTombstone !== undefined
    ) {
      return;
    }
    const previousLifecycle = current.lifecycle;
    try {
      this.#store.appendRunStatusChanged({
        automationId: definition.id,
        runId: current.id,
        previousLifecycle,
        lifecycle: "awaiting-confirmation",
        version: current.version + 1,
        expectedVersion: current.version,
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
    this.#confirmedScopes.delete(String(run.id));
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
