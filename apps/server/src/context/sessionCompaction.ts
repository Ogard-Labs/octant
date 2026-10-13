import {
  decodeCapacityReservationId,
  decodeProviderSessionId,
  type ContextCommand,
  type ContextCommandResult,
  type ContextCompactionAvailability,
  type ContextCompactionRecord,
  type ContextCompactionRefusalReason,
  type ContextInspectorSnapshot,
  type ContextSubjectRef,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { decideSessionCompaction } from "@octant/domain/context-compaction";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import type {
  CompactionSummaryOutcome,
  ContextHarnessService,
  ReportedCompactionUsage,
  SessionConversationMessage,
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
export class ContextCompactionRefused extends Error {
  override readonly name = "ContextCompactionRefused";

  constructor(readonly reason: ContextCompactionRefusalReason) {
    super("Octant refused to compact this session.");
  }
}

export interface SessionCompactionThread {
  readonly mode: "chat" | "work";
  readonly projectId?: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

/** What one thread kind lends a compaction of its own threads. */
export interface SessionCompactionThreads {
  /** Undefined once the thread is gone. */
  readonly read: (threadId: string) => SessionCompactionThread | undefined;
  readonly turnRunning: (threadId: string) => boolean;
  /** The conversation the thread's next turn would carry, oldest first. */
  readonly conversation: (threadId: string) => ReadonlyArray<SessionConversationMessage>;
  /** The thread's own scratch folder, where its provider sessions start. */
  readonly scratchRoot: (threadId: string) => Promise<string>;
}

export interface SessionCompactionOptions {
  readonly harness: ContextHarnessService;
  /** Thread kinds whose conversation the host plans. Any other kind cannot compact yet. */
  readonly threads: Partial<Record<"chat-thread" | "work-thread", SessionCompactionThreads>>;
  readonly modeEnabled: (mode: "chat" | "work") => boolean;
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
}

type Principal = "local-window" | "remote-device";

const NEVER_CANCELLED = new AbortController().signal;

interface Admission {
  readonly availability: ContextCompactionAvailability;
  /** Present only when the compaction is available. */
  readonly run?: {
    readonly thread: SessionCompactionThread;
    readonly threads: SessionCompactionThreads;
    readonly driver: ProviderDriver;
  };
}

/**
 * Runs a person's request to compact a thread's session: decides every
 * refusal before anything is journaled, reserves provider capacity and spend
 * for the summary request, and hands the host-owned conversation to
 * {@link ContextHarnessService.compactSession}.
 *
 * Only host-owned conversations compact here. A runtime that owns its session
 * is the only party that can change what that session sends, and no adapter
 * offers a compaction request yet, so those threads are refused rather than
 * summarized behind the runtime's back.
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

  start(command: CompactSessionCommand, principal: Principal): ContextCommandResult {
    const { harness } = this.#options;
    const subject = command.subject;
    // A paired device is refused even for an id it repeats: it may not learn
    // or steer a local window's compaction.
    if (principal !== "local-window") throw new ContextCompactionRefused("remote-client");
    const existing = harness.compaction(subject, command.compactionId);
    if (existing !== undefined) return started(existing);

    const admission = this.#admission(subject, principal);
    if (admission.availability.status === "refused") {
      throw new ContextCompactionRefused(admission.availability.reason);
    }
    if (admission.run === undefined) throw new ContextCompactionRefused("no-session");
    const { thread, threads, driver } = admission.run;
    const planned = harness.inspect(subject);
    const safeInputBudget = planned.next.plan.safeInputBudget;
    const { capacity } = this.#options;

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
        estimatedTokens: safeInputBudget,
        requests: 1,
        // The summary request shares the thread's provider slot like any other
        // managed child of the thread.
        origin: "subagent",
      });
    } catch (error) {
      if (error instanceof ProviderCapacitySchedulerRejected) {
        throw new ContextCompactionRefused("provider-unavailable");
      }
      throw error;
    }
    if (submission.status !== "dispatched") {
      capacity.recordTerminal({ reservationId: capacityReservationId, outcome: "cancelled" });
      throw new ContextCompactionRefused("provider-unavailable");
    }
    const spendReservationId = decodeSpendCeilingReservationId(this.#options.uuid());
    const spend = this.#options.spendCeiling?.admit({
      reservationId: spendReservationId,
      threadId: String(subject.aggregateId),
      threadType: subject.aggregateType === "chat-thread" ? "chat-thread" : "work-thread",
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      turnUpperBoundTokens: safeInputBudget,
      countsAsTurn: false,
    });
    // Before the request is journaled nothing has reached the provider, so
    // both reservations return whole instead of ending as unmeasured work.
    const releaseUnstarted = () => {
      capacity.releaseUnstarted(capacityReservationId);
      if (spend?.status === "admitted") {
        this.#options.spendCeiling?.settle({ reservationId: spendReservationId });
      }
    };
    if (spend?.status === "refused") {
      releaseUnstarted();
      throw new ContextCompactionRefused("spend-ceiling-reached");
    }

    let requested: ReturnType<ContextHarnessService["requestCompaction"]>;
    try {
      requested = harness.requestCompaction({
        subject,
        compactionId: command.compactionId,
        executor: {
          kind: "host",
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        },
      });
    } catch (error) {
      releaseUnstarted();
      throw error;
    }
    if (requested.kind === "existing") {
      releaseUnstarted();
      return started(requested.record);
    }
    capacity.markRunning(capacityReservationId);
    const release = (usage?: ReportedCompactionUsage) => {
      const spent = usage === undefined ? 0 : usage.inputTokens + usage.outputTokens;
      // Reconcile only against usage the provider reported; an unmeasured
      // request releases its reservation rather than inventing a figure.
      capacity.recordTerminal(
        spent > 0
          ? { reservationId: capacityReservationId, outcome: "completed", actualTokens: spent }
          : { reservationId: capacityReservationId, outcome: "interrupted" },
      );
      if (spend?.status === "admitted") {
        this.#options.spendCeiling?.settle({
          reservationId: spendReservationId,
          ...(spent > 0 ? { observedTokens: spent } : {}),
        });
      }
    };
    const key = subjectKey(subject);
    const run = this.#run(command, thread, threads, driver, release).finally(() => {
      this.#running.delete(key);
    });
    this.#running.set(key, run);
    return started(requested.record);
  }

  /** Resolves once every compaction this process started has settled. */
  async settled(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  async #run(
    command: CompactSessionCommand,
    thread: SessionCompactionThread,
    threads: SessionCompactionThreads,
    driver: ProviderDriver,
    release: (usage?: ReportedCompactionUsage) => void,
  ): Promise<void> {
    const { harness } = this.#options;
    const threadId = String(command.subject.aggregateId);
    let usage: ReportedCompactionUsage | undefined;
    try {
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
        conversation: threads.conversation(threadId),
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
        subjectAvailability: () =>
          threads.read(threadId) === undefined
            ? "deleted"
            : this.#options.modeEnabled(thread.mode)
              ? "available"
              : "mode-disabled",
      });
    } catch {
      // The request is journaled, so it must not be left running: a failure
      // outside the summary itself (a scratch folder, the journal) still ends
      // it, unless the thread's purge already erased it.
      try {
        if (harness.compaction(command.subject, command.compactionId)?.status === "running") {
          harness.failCompaction(command.subject, command.compactionId, "summary-failed");
        }
      } catch {
        // Storage is unavailable; the next start closes it as interrupted.
      }
    } finally {
      release(usage);
    }
  }

  #admission(subject: ContextSubjectRef, principal: Principal): Admission {
    const { harness } = this.#options;
    const kind = String(subject.aggregateType);
    const threadId = String(subject.aggregateId);
    const threads =
      kind === "chat-thread" || kind === "work-thread" ? this.#options.threads[kind] : undefined;
    const thread = threads?.read(threadId);
    const driver =
      thread === undefined ? undefined : this.#options.availableDriver(thread.providerInstanceId);
    // Code threads are planned by Octant Harness or a runtime, and neither
    // offers a compaction request through its connection yet.
    const owner =
      threads === undefined || driver?.conversationOwnership === "provider" ? "runtime" : "host";
    const preview =
      owner === "host" && thread !== undefined && threads !== undefined
        ? harness.previewSessionCompaction({
            subject,
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            conversation: threads.conversation(threadId),
          })
        : undefined;
    const spend =
      thread === undefined
        ? undefined
        : this.#options.spendCeiling?.snapshot({
            principalKind: "local-window",
            threadId,
            threadType: kind === "chat-thread" ? "chat-thread" : "work-thread",
            ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
          });
    const availability = decideSessionCompaction({
      principal,
      modeEnabled: thread === undefined || this.#options.modeEnabled(thread.mode),
      owner,
      runtimeCompaction: "unsupported",
      hasSession: preview !== undefined && preview.kind !== "no-session",
      compactionRunning:
        this.#running.has(subjectKey(subject)) ||
        harness.latestCompaction(subject)?.status === "running",
      turnRunning: thread !== undefined && threads !== undefined && threads.turnRunning(threadId),
      providerAvailable: driver !== undefined,
      spendCeilingReached: spend !== undefined && "refusal" in spend && spend.refusal !== undefined,
      somethingToCompact: preview?.kind === "summarize",
    });
    return availability.status === "available" &&
      thread !== undefined &&
      threads !== undefined &&
      driver !== undefined
      ? { availability, run: { thread, threads, driver } }
      : { availability };
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

function subjectKey(subject: ContextSubjectRef): string {
  return `${subject.aggregateType}\u0000${subject.aggregateId}`;
}
