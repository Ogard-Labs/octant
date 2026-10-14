import { Deferred, Effect, Either, Option, Stream } from "effect";
import {
  decodeCapacityReservationId,
  decodeProviderSessionId,
  type ContextCommand,
  type ContextCommandResult,
  type ContextCompactionAvailability,
  type ContextCompactionExecutor,
  type ContextCompactionRecord,
  type ContextCompactionRefusalReason,
  type ContextCompactionSettledRecord,
  type ContextCompactionState,
  type ContextInspectorSnapshot,
  type ContextSubjectRef,
  type KnownTokenMeasurement,
  type ProjectProviderPolicy,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModel,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import { isProviderAllowedByProjectPolicy } from "@octant/domain";
import {
  decideSessionCompaction,
  type SessionCompactionFacts,
} from "@octant/domain/context-compaction";
import type {
  ProviderAcquireInput,
  ProviderDriver,
  ProviderSessionCompaction,
  ProviderSessionResume,
} from "@octant/provider-sdk/driver";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import { WORK_TURN_SAFE_INPUT_TOKENS } from "../work/workTurnContext";
import {
  ContextHarnessError,
  type CompactionSummaryOutcome,
  type ContextHarnessService,
  type ReportedCompactionUsage,
  type RuntimeCompactionOutcome,
  type SessionConversationMessage,
} from "./contextHarnessService";
import {
  ProviderCapacitySchedulerRejected,
  type ProviderCapacityScheduler,
} from "./providerCapacityScheduler";
import {
  ContextSummaryGenerationFailed,
  makeContextSummaryGenerator,
} from "./contextSummaryGenerator";

export type CompactSessionCommand = Extract<ContextCommand, { readonly kind: "compact-session" }>;

/** A refusal decided before anything was journaled, reserved, or sent. */
export interface ContextCompactionRefusal {
  readonly kind: "compaction-refused";
  readonly reason: ContextCompactionRefusalReason;
}

export type SessionCompactionStart = ContextCommandResult | ContextCompactionRefusal;

const refused = (reason: ContextCompactionRefusalReason): ContextCompactionRefusal => ({
  kind: "compaction-refused",
  reason,
});

/**
 * A runtime compaction is a model call over the whole session that streams
 * nothing until it ends, so the host summary's 30-second bound would end most
 * real ones. It gets the inactivity bound a Code turn has instead.
 */
const DEFAULT_RUNTIME_COMPACTION_TIMEOUT_MS = 5 * 60_000;
/** Bound on stopping the session once the compaction is over or abandoned. */
const DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS = 3_000;
/**
 * How long a compaction that has answered waits for the run carrying it to
 * close. A runtime reports the request's usage with that run, and Claude
 * settles its compaction on the boundary before the command's closing result.
 */
const DEFAULT_RUNTIME_SETTLE_GRACE_MS = 1_000;

type ThreadKind = "chat-thread" | "work-thread" | "code-thread";
type RuntimeCompactionSupport = "supported" | "unsupported" | "unavailable";

export interface SessionCompactionThread {
  readonly mode: "chat" | "work" | "code";
  readonly projectId?: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  /**
   * The provider policy of the Project the thread's turns are admitted under.
   * A Work or Code Project carries one; a Chat Project is a virtual container
   * with none, so a Chat thread supplies none and its provider is never
   * policy-refused. Absent on a Project that never set one, and read as
   * allow-all there, as a turn reads it.
   */
  readonly providerPolicy?: ProjectProviderPolicy;
}

/**
 * The session a runtime keeps for a thread, opened as the thread's next turn
 * would open it: the same session, under the same confinement, and never with
 * more authority than that turn. It offers no tools.
 */
export interface RuntimeCompactionSession {
  readonly acquire: ProviderAcquireInput;
  readonly resume: ProviderSessionResume;
}

/** What a thread kind whose runtime keeps the conversation lends its compaction. */
export interface RuntimeCompactionSessions {
  /**
   * Whether the thread has a session its next turn would resume. Read on every
   * inspection, so it reads stored facts only.
   */
  readonly exists: (threadId: string) => boolean;
  /**
   * How full the session's window was at its latest usage report, as the
   * runtime reported it, and when. Absent here, the host's own plan of the
   * thread stands in.
   */
  readonly occupancy?: (
    threadId: string,
  ) => { readonly tokens: number; readonly observedAt: string } | undefined;
  /**
   * How to open that session, resolved when the compaction runs. Undefined
   * when the session, or the room it runs in, is gone; the runtime is then
   * never asked anything.
   */
  readonly open: (
    threadId: string,
    windowId: WindowId | undefined,
  ) => Promise<RuntimeCompactionSession | undefined>;
}

/** What one thread kind lends a compaction of its own threads. */
export interface SessionCompactionThreads {
  /** Undefined once the thread is gone. */
  readonly read: (threadId: string) => SessionCompactionThread | undefined;
  readonly turnRunning: (threadId: string) => boolean;
  /**
   * The conversation the thread's next turn would carry, oldest first. Absent
   * for a kind whose conversation the host never plans.
   */
  readonly conversation?: (threadId: string) => ReadonlyArray<SessionConversationMessage>;
  /** The thread's own scratch folder, where its provider sessions start. */
  readonly scratchRoot?: (threadId: string) => Promise<string>;
  /**
   * Carries a compaction that ended onto the thread's live stream. Absent
   * where that stream already reads the journaled outcome itself.
   */
  readonly settled?: (threadId: string, compaction: ContextCompactionSettledRecord) => void;
  /** Absent for a kind whose runtime sessions cannot be compacted here. */
  readonly runtimeSessions?: RuntimeCompactionSessions;
}

export interface SessionCompactionOptions {
  readonly harness: ContextHarnessService;
  readonly threads: Partial<Record<ThreadKind, SessionCompactionThreads>>;
  /** Code is always available; only Chat and Work can be turned off. */
  readonly modeEnabled: (mode: "chat" | "work") => boolean;
  /**
   * Who keeps the instance's Chat and Work conversation, read from its driver
   * kind; undefined for an instance that no longer exists. It must not depend
   * on readiness: a signed-out runtime still owns its session. A Code thread's
   * session is always kept by a runtime, Octant Harness on a direct endpoint.
   */
  readonly conversationOwner: (
    providerInstanceId: ProviderInstanceId,
  ) => "runtime" | "host" | undefined;
  /**
   * Whether the runtime that keeps the instance's sessions in this mode can
   * compact them, as its adapter last reported. Undefined while the host has
   * not observed that runtime yet: it may compact once it is reachable, so it
   * is unavailable rather than unable.
   */
  readonly runtimeCompaction?: (
    providerInstanceId: ProviderInstanceId,
    mode: "chat" | "work" | "code",
  ) => RuntimeCompactionSupport | undefined;
  /**
   * The instance and model facts the Project's provider policy is judged on
   * (their EU and zero-retention tags); undefined for an instance that no
   * longer exists.
   */
  readonly providerFacts: (
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => { readonly provider: ProviderInstance; readonly model?: ProviderModel } | undefined;
  /** The instance's driver; undefined when it is disabled, signed out or unreachable. */
  readonly availableDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  readonly capacity: Pick<
    ProviderCapacityScheduler,
    | "providerFacts"
    | "updateProviderFacts"
    | "submit"
    | "markRunning"
    | "releaseUnstarted"
    | "recordTerminal"
  >;
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "snapshot">;
  readonly uuid: () => string;
  readonly summaryTimeoutMs?: number;
  readonly summaryShutdownTimeoutMs?: number;
  readonly runtimeTimeoutMs?: number;
  readonly runtimeShutdownTimeoutMs?: number;
  readonly runtimeSettleGraceMs?: number;
}

type Principal = "local-window" | "remote-device";

const NEVER_CANCELLED = new AbortController().signal;

interface AdmittedRun {
  readonly owner: "host" | "runtime";
  readonly thread: SessionCompactionThread;
  readonly threads: SessionCompactionThreads;
  readonly driver: ProviderDriver;
}

interface Admission {
  readonly availability: ContextCompactionAvailability;
  /** Present only when the compaction is available. */
  readonly run?: AdmittedRun;
}

/** What the runtime said, before the host knows what became of the thread. */
type RuntimeAnswer =
  | ProviderSessionCompaction
  | { readonly kind: "timed-out" }
  // Nothing reached the runtime's compaction: the session could not be opened.
  | { readonly kind: "not-asked" };

/**
 * Runs a person's request to compact a thread's session: decides every
 * refusal before anything is journaled, reserves provider capacity and spend
 * for it, and has whoever owns the conversation compact it.
 *
 * Where the host plans the conversation (Chat and Work on a direct endpoint),
 * it summarizes through {@link ContextHarnessService.compactSession}. Where a
 * runtime keeps it, only that runtime can change what its session sends, so
 * the session is resumed and the runtime is asked through its connection's
 * `compact`; a runtime that cannot is refused rather than summarized behind
 * its back.
 */
export class SessionCompactionService {
  readonly #options: SessionCompactionOptions;
  readonly #running = new Map<string, Promise<void>>();

  constructor(options: SessionCompactionOptions) {
    this.#options = options;
  }

  /** The inspector snapshot with whether this caller may compact it now. */
  inspect(
    subject: ContextSubjectRef,
    afterSequence: number | undefined,
    principal: Principal,
  ): ContextInspectorSnapshot {
    const snapshot = this.#options.harness.inspect(subject, afterSequence);
    return { ...snapshot, compaction: this.#admission(subject, principal).availability };
  }

  /**
   * Whether this caller may compact the thread now, its latest compaction, and
   * who would compact it. A Code thread has no context plan, so this is the
   * only read that tells its window; it decides exactly as {@link start} does.
   */
  state(subject: ContextSubjectRef, principal: Principal): ContextCompactionState {
    const admission = this.#admission(subject, principal);
    const latestCompaction = this.#options.harness.latestCompaction(subject);
    const executor = admission.run === undefined ? undefined : this.#executor(admission.run);
    // `start` refuses a run it cannot name an executor for, so this does too.
    const compaction: ContextCompactionAvailability =
      admission.availability.status === "available" && executor === undefined
        ? { status: "refused", reason: "provider-unavailable" }
        : admission.availability;
    return {
      subject,
      compaction,
      ...(latestCompaction === undefined ? {} : { latestCompaction }),
      ...(compaction.status === "available" && executor !== undefined ? { executor } : {}),
    };
  }

  /**
   * `windowId` is the window that asked. A Code thread's session runs in its
   * checkout, which is resolved under that window's authority as its turns are.
   */
  start(
    command: CompactSessionCommand,
    principal: Principal,
    windowId?: WindowId,
  ): SessionCompactionStart {
    const { harness } = this.#options;
    const subject = command.subject;
    // A paired device is refused even for an id it repeats: it may not learn
    // or steer a local window's compaction.
    if (principal !== "local-window") return refused("remote-client");
    const existing = harness.compaction(subject, command.compactionId);
    if (existing !== undefined) return started(existing);

    const admission = this.#admission(subject, principal);
    if (admission.availability.status === "refused") {
      return refused(admission.availability.reason);
    }
    if (admission.run === undefined) return refused("no-session");
    const run = admission.run;
    const { thread, threads } = run;
    const planned = this.#planned(subject);
    // The host summarizes only a planned conversation; the admission saw one.
    if (run.owner === "host" && planned === undefined) return refused("no-session");
    const executor = this.#executor(run);
    if (executor === undefined) return refused("provider-unavailable");
    const tokensBefore =
      run.owner === "runtime" ? this.#occupancy(threads, subject, planned) : undefined;
    if (run.owner === "runtime" && tokensBefore === undefined) return refused("no-session");

    const reservation = this.#reserve(subject, thread, planned);
    if (reservation.kind === "refused") return reservation.refusal;

    let requested: ReturnType<ContextHarnessService["requestCompaction"]>;
    try {
      requested = harness.requestCompaction({
        subject,
        compactionId: command.compactionId,
        executor,
      });
    } catch (error) {
      reservation.releaseUnstarted();
      throw error;
    }
    if (requested.kind === "existing") {
      reservation.releaseUnstarted();
      return started(requested.record);
    }
    reservation.markRunning();
    const key = subjectKey(subject);
    let work: Promise<void>;
    if (run.owner === "runtime" && tokensBefore !== undefined) {
      work = this.#runRuntime(command, run, windowId, tokensBefore, reservation.release);
    } else {
      // Fixed in the turn of the event loop that journaled the request: a plan
      // appended while the summary is being set up must fail this compaction,
      // not be folded into it.
      const conversation = threads.conversation?.(String(subject.aggregateId)) ?? [];
      work = this.#run(
        command,
        thread,
        threads,
        run.driver,
        { conversation, version: requested.version },
        reservation.release,
      );
    }
    const settled = work.finally(() => {
      this.#running.delete(key);
    });
    this.#running.set(key, settled);
    return started(requested.record);
  }

  /** Resolves once every compaction this process started has settled. */
  async settled(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  /**
   * Reserves the spend and, for a thread the host plans, the provider slot the
   * compaction's own request takes. Spend is decided before any provider slot
   * is taken: a ceiling that can cover one token and not this request must
   * refuse with nothing reserved. A thread with no plan (Code) reserves no
   * slot, as its turns reserve none.
   */
  #reserve(
    subject: ContextSubjectRef,
    thread: SessionCompactionThread,
    planned: ContextInspectorSnapshot | undefined,
  ):
    | { readonly kind: "refused"; readonly refusal: ContextCompactionRefusal }
    | {
        readonly kind: "reserved";
        readonly releaseUnstarted: () => void;
        readonly markRunning: () => void;
        readonly release: (usage?: ReportedCompactionUsage) => void;
      } {
    const { capacity } = this.#options;
    const upperBound = upperBoundTokens(planned);
    const spendReservationId = decodeSpendCeilingReservationId(this.#options.uuid());
    const spend = this.#options.spendCeiling?.admit({
      reservationId: spendReservationId,
      threadId: String(subject.aggregateId),
      threadType: threadTypeOf(thread),
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      turnUpperBoundTokens: upperBound,
      countsAsTurn: false,
    });
    if (spend?.status === "refused") {
      return { kind: "refused", refusal: refused("spend-ceiling-reached") };
    }
    const settleSpend = (spent: number) => {
      if (spend?.status === "admitted") {
        this.#options.spendCeiling?.settle({
          reservationId: spendReservationId,
          ...(spent > 0 ? { observedTokens: spent } : {}),
        });
      }
    };

    if (planned === undefined) {
      return {
        kind: "reserved",
        releaseUnstarted: () => settleSpend(0),
        markRunning: () => undefined,
        release: (usage) => settleSpend(spentTokens(usage)),
      };
    }

    const capacityReservationId = decodeCapacityReservationId(this.#options.uuid());
    let submission: ReturnType<ProviderCapacityScheduler["submit"]>;
    try {
      // A host that has not run a turn on this provider since it started has
      // no capacity facts for it yet; the plan's own service limits stand in,
      // one request at a time, until a turn reports the provider's real ones.
      if (capacity.providerFacts(thread.providerInstanceId) === undefined) {
        capacity.updateProviderFacts({
          limits: planned.serviceLimits,
          enforcement: { kind: "observable-api", maxObservableConcurrency: 1 },
        });
      }
      submission = capacity.submit({
        reservationId: capacityReservationId,
        subject,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        estimatedTokens: upperBound,
        requests: 1,
        // The compaction request shares the thread's provider slot like any
        // other managed child of the thread.
        origin: "subagent",
      });
    } catch (error) {
      settleSpend(0);
      if (error instanceof ProviderCapacitySchedulerRejected) {
        return { kind: "refused", refusal: refused("provider-unavailable") };
      }
      throw error;
    }
    if (submission.status !== "dispatched") {
      capacity.recordTerminal({ reservationId: capacityReservationId, outcome: "cancelled" });
      settleSpend(0);
      return { kind: "refused", refusal: refused("provider-unavailable") };
    }
    return {
      kind: "reserved",
      // Before the request is journaled nothing has reached the provider, so
      // both reservations return whole instead of ending as unmeasured work.
      releaseUnstarted: () => {
        capacity.releaseUnstarted(capacityReservationId);
        settleSpend(0);
      },
      markRunning: () => capacity.markRunning(capacityReservationId),
      release: (usage) => {
        const spent = spentTokens(usage);
        // Reconcile only against usage the provider reported; an unmeasured
        // request releases its reservation rather than inventing a figure.
        capacity.recordTerminal(
          spent > 0
            ? { reservationId: capacityReservationId, outcome: "completed", actualTokens: spent }
            : { reservationId: capacityReservationId, outcome: "interrupted" },
        );
        settleSpend(spent);
      },
    };
  }

  async #run(
    command: CompactSessionCommand,
    thread: SessionCompactionThread,
    threads: SessionCompactionThreads,
    driver: ProviderDriver,
    basis: {
      readonly conversation: ReadonlyArray<SessionConversationMessage>;
      readonly version: number;
    },
    release: (usage?: ReportedCompactionUsage) => void,
  ): Promise<void> {
    const { harness } = this.#options;
    const threadId = String(command.subject.aggregateId);
    let usage: ReportedCompactionUsage | undefined;
    try {
      if (threads.scratchRoot === undefined || thread.mode === "code") {
        throw new Error("The host plans no conversation for this thread.");
      }
      const scratchRoot = await threads.scratchRoot(threadId);
      const generate = makeContextSummaryGenerator({
        driver,
        providerInstanceId: thread.providerInstanceId,
        scratchRoot,
        sessionId: decodeProviderSessionId(this.#options.uuid()),
        mode: thread.mode,
        observeUsage: (reported) => {
          usage = reported;
        },
        ...(this.#options.summaryTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.summaryTimeoutMs }),
        ...(this.#options.summaryShutdownTimeoutMs === undefined
          ? {}
          : { shutdownTimeoutMs: this.#options.summaryShutdownTimeoutMs }),
      });
      await harness.compactSession({
        subject: command.subject,
        compactionId: command.compactionId,
        conversation: basis.conversation,
        plannedVersion: basis.version,
        generateSummary: async (request): Promise<CompactionSummaryOutcome> => {
          try {
            // Nothing cancels a requested compaction: it is no turn's child,
            // and a host that stops mid-request closes it as interrupted on
            // its next start.
            return { kind: "generated", summary: await generate(request, NEVER_CANCELLED) };
          } catch (error) {
            return {
              kind: "failed",
              reason:
                error instanceof ContextSummaryGenerationFailed && error.reason === "timed-out"
                  ? "timed-out"
                  : "summary-failed",
            };
          }
        },
        reportedUsage: () => usage,
        subjectAvailability: () => {
          const current = threads.read(threadId);
          if (current === undefined) return "deleted";
          // A provider or model change is journaled on the thread, not on the
          // context ledger, so the ledger version alone would still commit a
          // summary written for the session the thread has left.
          if (
            String(current.providerInstanceId) !== String(thread.providerInstanceId) ||
            String(current.modelId) !== String(thread.modelId)
          ) {
            return "context-changed";
          }
          return this.#modeEnabled(current) ? "available" : "mode-disabled";
        },
      });
    } catch {
      // The request is journaled, so it must not be left running: a failure
      // outside the summary itself (a scratch folder, the journal) still ends
      // it, unless the thread's purge already erased it.
      this.#failStillRunning(command, "summary-failed");
    } finally {
      release(usage);
      this.#announceSettled(command, threads);
    }
  }

  /**
   * Resumes the runtime's session, asks it to compact, and journals what it
   * answered. The session is stopped afterwards whatever happened: a runtime
   * that compacted leaves the session terminal (Claude closes its command,
   * Codex ends the run), so the next turn resumes it as every turn does.
   */
  async #runRuntime(
    command: CompactSessionCommand,
    run: AdmittedRun,
    windowId: WindowId | undefined,
    tokensBefore: KnownTokenMeasurement,
    release: (usage?: ReportedCompactionUsage) => void,
  ): Promise<void> {
    const { harness } = this.#options;
    const threadId = String(command.subject.aggregateId);
    let usage: ReportedCompactionUsage | undefined;
    try {
      let answer: RuntimeAnswer;
      try {
        const session = await run.threads.runtimeSessions?.open(threadId, windowId);
        answer =
          session === undefined
            ? { kind: "not-asked" }
            : await this.#compactRuntime(run.driver, session, command.compactionId, (reported) => {
                usage = reported;
              });
      } catch {
        answer = { kind: "not-asked" };
      }
      harness.settleRuntimeCompaction({
        subject: command.subject,
        compactionId: command.compactionId,
        outcome: this.#runtimeOutcome(run, threadId, answer, tokensBefore),
        usage,
      });
    } catch {
      // The runtime was asked; a journal that could not take its answer must
      // not leave the request running, and cannot attest the session is intact.
      this.#failStillRunning(command, "runtime-failed", true);
    } finally {
      release(usage);
      this.#announceSettled(command, run.threads);
    }
  }

  /**
   * What a runtime's answer means for the thread as it is now. A runtime that
   * compacted has changed its session whatever became of the thread, so a
   * thread whose mode was turned off meanwhile still records it; a thread
   * deleted meanwhile discards it. Only an outcome nobody can vouch for is
   * recorded against the thread's absence.
   */
  #runtimeOutcome(
    run: AdmittedRun,
    threadId: string,
    answer: RuntimeAnswer,
    tokensBefore: KnownTokenMeasurement,
  ): RuntimeCompactionOutcome {
    let outcome: RuntimeCompactionOutcome;
    switch (answer.kind) {
      case "compacted":
        outcome = {
          kind: "compacted",
          tokensBefore:
            answer.tokensBefore === undefined
              ? tokensBefore
              : { kind: "known", tokens: answer.tokensBefore, accuracy: "provider-reported" },
          ...(answer.tokensAfter === undefined ? {} : { tokensAfter: answer.tokensAfter }),
        };
        break;
      case "refused":
        // Every adapter refusal is decided before the runtime is asked.
        outcome = { kind: "failed", reason: "runtime-failed", sessionMayHaveChanged: false };
        break;
      case "failed":
        outcome = {
          kind: "failed",
          reason: "runtime-failed",
          sessionMayHaveChanged: answer.sessionMayHaveChanged,
        };
        break;
      case "timed-out":
        outcome = { kind: "failed", reason: "timed-out", sessionMayHaveChanged: true };
        break;
      case "not-asked":
        outcome = { kind: "failed", reason: "subject-unavailable", sessionMayHaveChanged: false };
        break;
    }
    let current: SessionCompactionThread | undefined;
    try {
      current = run.threads.read(threadId);
    } catch {
      return outcome;
    }
    const mayHaveChanged =
      outcome.kind === "compacted" || (outcome.kind === "failed" && outcome.sessionMayHaveChanged);
    if (current === undefined) {
      return {
        kind: "failed",
        reason: "subject-unavailable",
        sessionMayHaveChanged: mayHaveChanged,
      };
    }
    if (!this.#modeEnabled(current) && outcome.kind === "failed" && mayHaveChanged) {
      return { kind: "failed", reason: "subject-unavailable", sessionMayHaveChanged: true };
    }
    return outcome;
  }

  /**
   * Opens the session in its own scope, asks for the compaction, and stops the
   * session when the scope closes. A compaction that outlives its bound is
   * interrupted first, then the session is stopped. Codex runs a compaction
   * as a turn of its own in an app-server other sessions share, and keeps
   * running it after the session is stopped here; only its `interrupt` ends
   * that turn, and a later turn would otherwise queue behind it and read its
   * events as its own. Claude and Octant Harness refuse an interrupt with no
   * turn in flight, and the stop ends their compaction.
   */
  async #compactRuntime(
    driver: ProviderDriver,
    session: RuntimeCompactionSession,
    compactionId: string,
    observeUsage: (usage: ReportedCompactionUsage) => void,
  ): Promise<RuntimeAnswer> {
    const timeoutMs = this.#options.runtimeTimeoutMs ?? DEFAULT_RUNTIME_COMPACTION_TIMEOUT_MS;
    const shutdownMs =
      this.#options.runtimeShutdownTimeoutMs ?? DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS;
    const graceMs = this.#options.runtimeSettleGraceMs ?? DEFAULT_RUNTIME_SETTLE_GRACE_MS;
    const sessionId = session.resume.sessionId;
    const program = Effect.gen(function* () {
      const acquired = yield* Effect.either(driver.acquire(session.acquire));
      if (Either.isLeft(acquired)) return { kind: "not-asked" } as const;
      const connection = acquired.right;
      const stop = connection.stop(sessionId).pipe(
        Effect.timeoutOption(shutdownMs),
        Effect.catchAllCause(() => Effect.void),
      );
      yield* Effect.addFinalizer(() => stop);
      const events = yield* connection.subscribe;
      const closed = yield* Deferred.make<void>();
      // The session is this compaction's alone while it runs: no turn starts
      // during a compaction, so every usage report on it is the compaction's.
      // A report restates the request's total, so the latest one stands.
      yield* events.pipe(
        Stream.filter((event) => String(event.sessionId) === String(sessionId)),
        Stream.runForEach((event) =>
          event.kind === "usage"
            ? Effect.sync(() =>
                observeUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens }),
              )
            : event.kind === "completed" ||
                event.kind === "failed" ||
                event.kind === "interrupted" ||
                event.kind === "waiting"
              ? Deferred.succeed(closed, undefined)
              : Effect.void,
        ),
        Effect.catchAllCause(() => Effect.void),
        Effect.forkScoped,
      );
      const resumed = yield* Effect.either(connection.resume(session.resume));
      if (Either.isLeft(resumed) || String(resumed.right.sessionId) !== String(sessionId)) {
        return { kind: "not-asked" } as const;
      }
      // A capability claimed for a connection that offers no `compact` is a
      // broken adapter; the runtime was never asked.
      const compact = connection.compact;
      if (compact === undefined) return { kind: "not-asked" } as const;
      const answered = yield* Effect.either(
        compact({ sessionId, compactionId }).pipe(Effect.timeoutOption(timeoutMs)),
      );
      if (Either.isLeft(answered)) {
        return {
          kind: "failed",
          message: "The runtime could not report its compaction.",
          sessionMayHaveChanged: true,
        } as const;
      }
      if (Option.isNone(answered.right)) {
        const interrupted = yield* connection.interrupt(sessionId).pipe(
          Effect.timeoutOption(shutdownMs),
          Effect.map(Option.isSome),
          Effect.catchAllCause(() => Effect.succeed(false)),
        );
        // The interrupted run reports its end before the session goes.
        if (interrupted) yield* Deferred.await(closed).pipe(Effect.timeoutOption(graceMs));
        yield* stop;
        return { kind: "timed-out" } as const;
      }
      if (answered.right.value.kind !== "refused") {
        yield* Deferred.await(closed).pipe(Effect.timeoutOption(graceMs));
      }
      return answered.right.value;
    });
    return await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed<RuntimeAnswer>({
            kind: "failed",
            message: "The runtime's session ended unexpectedly.",
            sessionMayHaveChanged: true,
          }),
        ),
      ),
    );
  }

  /** Ends a journaled request a failure left running, unless a purge erased it. */
  #failStillRunning(
    command: CompactSessionCommand,
    reason: "summary-failed" | "runtime-failed",
    sessionMayHaveChanged = false,
  ): void {
    const { harness } = this.#options;
    try {
      if (harness.compaction(command.subject, command.compactionId)?.status !== "running") return;
      if (sessionMayHaveChanged) {
        harness.settleRuntimeCompaction({
          subject: command.subject,
          compactionId: command.compactionId,
          outcome: { kind: "failed", reason, sessionMayHaveChanged },
          usage: undefined,
        });
      } else {
        harness.failCompaction(command.subject, command.compactionId, reason);
      }
    } catch {
      // Storage is unavailable; the next start closes it as interrupted.
    }
  }

  #announceSettled(command: CompactSessionCommand, threads: SessionCompactionThreads): void {
    if (threads.settled === undefined) return;
    let record: ContextCompactionRecord | undefined;
    try {
      record = this.#options.harness.compaction(command.subject, command.compactionId);
    } catch {
      // Storage is unavailable; the window reads the outcome on its next inspection.
      return;
    }
    // A purge erased it, or the next start closes it as interrupted.
    if (record === undefined || record.status === "running") return;
    threads.settled(String(command.subject.aggregateId), record);
  }

  /**
   * Decides in the order the domain names its refusals, and reads only what
   * the answer still depends on: the facts that cost nothing first, then the
   * conversation or session, and the provider driver and the spend ceiling
   * only for a request nothing has refused yet. Inspecting a thread runs this
   * on every read, including a paired device's, which is refused before any
   * of it.
   */
  #admission(subject: ContextSubjectRef, principal: Principal): Admission {
    const { harness } = this.#options;
    const kind = String(subject.aggregateType);
    const threadId = String(subject.aggregateId);
    const threads =
      kind === "chat-thread" || kind === "work-thread" || kind === "code-thread"
        ? this.#options.threads[kind]
        : undefined;
    const thread = threads?.read(threadId);
    const owner = this.#owner(threads, thread);
    // Undefined while the runtime has not been observed: it may compact once
    // reachable, which is a transient refusal, not a permanent one.
    const support =
      owner === "runtime" && thread !== undefined && threads?.runtimeSessions !== undefined
        ? this.#runtimeSupport(thread)
        : "unsupported";
    const facts = {
      principal,
      modeEnabled: thread === undefined || this.#modeEnabled(thread),
      owner,
      runtimeCompaction: support ?? "supported",
      compactionRunning: false,
      turnRunning: false,
      hasSession: true,
      providerAvailable: true,
      spendCeilingReached: false,
      somethingToCompact: true,
    } as const satisfies SessionCompactionFacts;
    // These refusals come before any fact that needs a read.
    const permanent = decideSessionCompaction(facts);
    if (permanent.status === "refused") return { availability: permanent };

    const preview =
      owner === "host" &&
      thread !== undefined &&
      threads?.conversation !== undefined &&
      thread.mode !== "code"
        ? harness.previewSessionCompaction({
            subject,
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            conversation: threads.conversation(threadId),
          })
        : undefined;
    const planned = owner === "runtime" ? this.#planned(subject) : undefined;
    const hasSession =
      owner === "runtime"
        ? thread !== undefined &&
          threads?.runtimeSessions?.exists(threadId) === true &&
          this.#occupancy(threads, subject, planned) !== undefined
        : preview !== undefined && preview.kind !== "no-session";
    // The provider policy is judged before a driver is built for the provider:
    // a driver for a provider the Project excludes must never exist to be
    // asked, and the policy needs only stored facts.
    const policyAllows = thread === undefined || this.#policyAllowsProvider(thread);
    const transient = decideSessionCompaction({
      ...facts,
      hasSession,
      compactionRunning:
        this.#running.has(subjectKey(subject)) ||
        harness.latestCompaction(subject)?.status === "running",
      turnRunning: thread !== undefined && threads !== undefined && threads.turnRunning(threadId),
      providerAvailable: policyAllows && support !== undefined,
    });
    if (transient.status === "refused") return { availability: transient };

    // A driver that cannot be constructed is unavailable. Letting the throw
    // out would fail the whole inspection, not only compaction.
    let driver: ProviderDriver | undefined;
    if (thread !== undefined) {
      try {
        driver = this.#options.availableDriver(thread.providerInstanceId);
      } catch {
        driver = undefined;
      }
    }
    const compactionBound =
      driver === undefined
        ? undefined
        : owner === "runtime"
          ? upperBoundTokens(planned)
          : preview?.kind === "summarize"
            ? harness.inspect(subject).next.plan.safeInputBudget
            : undefined;
    const spend =
      thread === undefined || driver === undefined
        ? undefined
        : this.#options.spendCeiling?.snapshot({
            principalKind: "local-window",
            threadId,
            threadType: threadTypeOf(thread),
            ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
            ...(compactionBound === undefined ? {} : { turnUpperBoundTokens: compactionBound }),
          });
    const availability = decideSessionCompaction({
      ...facts,
      providerAvailable: driver !== undefined,
      spendCeilingReached: spend !== undefined && "refusal" in spend && spend.refusal !== undefined,
      // A runtime decides for itself whether its session holds anything to
      // compact, and answers before it is asked anything.
      somethingToCompact: owner === "runtime" || preview?.kind === "summarize",
    });
    return availability.status === "available" &&
      thread !== undefined &&
      threads !== undefined &&
      driver !== undefined
      ? { availability, run: { owner, thread, threads, driver } }
      : { availability };
  }

  /**
   * Who keeps the thread's conversation. A kind with no compaction support of
   * its own is a runtime's that cannot compact; a Code thread's session is
   * always a runtime's, Octant Harness included.
   */
  #owner(
    threads: SessionCompactionThreads | undefined,
    thread: SessionCompactionThread | undefined,
  ): "host" | "runtime" {
    if (threads === undefined) return "runtime";
    if (thread === undefined) return "host";
    if (thread.mode === "code") return "runtime";
    return this.#options.conversationOwner(thread.providerInstanceId) === "runtime"
      ? "runtime"
      : "host";
  }

  #runtimeSupport(thread: SessionCompactionThread): RuntimeCompactionSupport | undefined {
    const { runtimeCompaction } = this.#options;
    return runtimeCompaction === undefined
      ? "unsupported"
      : runtimeCompaction(thread.providerInstanceId, thread.mode);
  }

  #executor(run: AdmittedRun): ContextCompactionExecutor | undefined {
    const { thread } = run;
    if (run.owner === "host") {
      return {
        kind: "host",
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
      };
    }
    const facts = this.#options.providerFacts(thread.providerInstanceId, thread.modelId);
    if (facts === undefined) return undefined;
    return {
      kind: "runtime",
      driverKind: facts.provider.driverKind,
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
    };
  }

  /**
   * How full the runtime's window is before it compacts: what its latest usage
   * report said, or, for a thread the host plans, the occupancy that report
   * reconciled or the plan's own estimate. A session with no figure at all has
   * never reported an exchange, so it has nothing to compact.
   *
   * A compaction since that report changed the window it describes. The
   * figure that compaction reported after stands instead; without one, the
   * older report is only an upper bound, and says so.
   */
  #occupancy(
    threads: SessionCompactionThreads,
    subject: ContextSubjectRef,
    planned: ContextInspectorSnapshot | undefined,
  ): KnownTokenMeasurement | undefined {
    const contextTokens = planned?.latestUsage?.contextTokens;
    const report =
      threads.runtimeSessions?.occupancy?.(String(subject.aggregateId)) ??
      (planned?.latestUsage === undefined || contextTokens === undefined
        ? undefined
        : { tokens: contextTokens, observedAt: planned.latestUsage.observedAt });
    const estimate: KnownTokenMeasurement | undefined =
      planned === undefined
        ? undefined
        : {
            kind: "known",
            tokens: planned.next.plan.plannedInputTokens,
            accuracy: "conservative-heuristic",
          };
    const changedSince = this.#compactedSince(subject, report?.observedAt);
    if (changedSince !== undefined) {
      if (changedSince.kind === "known") return changedSince;
      return report === undefined
        ? estimate
        : { kind: "known", tokens: report.tokens, accuracy: "conservative-heuristic" };
    }
    return report === undefined
      ? estimate
      : { kind: "known", tokens: report.tokens, accuracy: "provider-reported" };
  }

  /**
   * The occupancy a compaction newer than `since` left behind: its own figure
   * after, or `pending` when it gave none or may have changed the session
   * without saying how. Undefined when nothing has compacted the session since.
   */
  #compactedSince(
    subject: ContextSubjectRef,
    since: string | undefined,
  ): KnownTokenMeasurement | { readonly kind: "pending" } | undefined {
    const latest = this.#options.harness.latestCompaction(subject);
    if (latest === undefined || latest.status === "running") return undefined;
    if (latest.status === "failed" && !latest.sessionMayHaveChanged) return undefined;
    const at = latest.status === "completed" ? latest.receipt.completedAt : latest.failedAt;
    if (since !== undefined && Date.parse(at) <= Date.parse(since)) return undefined;
    return latest.status === "completed" ? latest.receipt.tokensAfter : { kind: "pending" };
  }

  /** The subject's latest plan, or undefined for one the host never planned. */
  #planned(subject: ContextSubjectRef): ContextInspectorSnapshot | undefined {
    try {
      return this.#options.harness.inspect(subject);
    } catch (error) {
      if (error instanceof ContextHarnessError && error.category === "not-planned") {
        return undefined;
      }
      throw error;
    }
  }

  #modeEnabled(thread: SessionCompactionThread): boolean {
    return thread.mode === "code" || this.#options.modeEnabled(thread.mode);
  }

  /**
   * Whether the Project's provider policy lets this thread's provider and model
   * see its conversation: the rule a turn passes before it sends, judged by the
   * same function. A provider that no longer exists is not allowed.
   */
  #policyAllowsProvider(thread: SessionCompactionThread): boolean {
    const facts = this.#options.providerFacts(thread.providerInstanceId, thread.modelId);
    return (
      facts !== undefined &&
      isProviderAllowedByProjectPolicy(
        { providerPolicy: thread.providerPolicy },
        facts.provider,
        facts.model,
      )
    );
  }
}

function started(record: ContextCompactionRecord): ContextCommandResult {
  return record.status === "completed"
    ? {
        kind: "compaction-started",
        compactionId: record.receipt.compactionId,
        executor: record.receipt.executor,
      }
    : { kind: "compaction-started", compactionId: record.compactionId, executor: record.executor };
}

/**
 * The most a compaction's own request may spend: the plan's safe input budget
 * where the host plans the thread, or the bound a Code turn is admitted under.
 */
function upperBoundTokens(planned: ContextInspectorSnapshot | undefined): number {
  return planned?.next.plan.safeInputBudget ?? WORK_TURN_SAFE_INPUT_TOKENS;
}

function spentTokens(usage: ReportedCompactionUsage | undefined): number {
  return usage === undefined ? 0 : usage.inputTokens + usage.outputTokens;
}

function threadTypeOf(thread: SessionCompactionThread): ThreadKind {
  return thread.mode === "chat"
    ? "chat-thread"
    : thread.mode === "work"
      ? "work-thread"
      : "code-thread";
}

function subjectKey(subject: ContextSubjectRef): string {
  return `${subject.aggregateType}\u0000${subject.aggregateId}`;
}
