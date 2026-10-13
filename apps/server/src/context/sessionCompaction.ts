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
  type ProjectProviderPolicy,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModel,
  type ProviderModelId,
} from "@octant/contracts";
import { isProviderAllowedByProjectPolicy } from "@octant/domain";
import {
  decideSessionCompaction,
  type SessionCompactionFacts,
} from "@octant/domain/context-compaction";
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
export interface ContextCompactionRefusal {
  readonly kind: "compaction-refused";
  readonly reason: ContextCompactionRefusalReason;
}

export type SessionCompactionStart = ContextCommandResult | ContextCompactionRefusal;

const refused = (reason: ContextCompactionRefusalReason): ContextCompactionRefusal => ({
  kind: "compaction-refused",
  reason,
});

export interface SessionCompactionThread {
  readonly mode: "chat" | "work";
  readonly projectId?: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  /**
   * The provider policy of the Project the thread's turns are admitted under.
   * Only a Work Project carries one; a Chat Project is a virtual container
   * with none, so a Chat thread supplies none and its provider is never
   * policy-refused. Absent on a Project that never set one, and read as
   * allow-all there, as a turn reads it.
   */
  readonly providerPolicy?: ProjectProviderPolicy;
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
  /**
   * Who keeps the instance's conversation, read from its driver kind; undefined
   * for an instance that no longer exists. It must not depend on readiness: a
   * signed-out runtime still owns its session, so it cannot compact rather than
   * merely being unavailable.
   */
  readonly conversationOwner: (
    providerInstanceId: ProviderInstanceId,
  ) => "runtime" | "host" | undefined;
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

  start(command: CompactSessionCommand, principal: Principal): SessionCompactionStart {
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
    const { thread, threads, driver } = admission.run;
    const planned = harness.inspect(subject);
    const safeInputBudget = planned.next.plan.safeInputBudget;
    const { capacity } = this.#options;

    // Spend is decided before any provider slot is taken. A ceiling that can
    // cover one token and not this summary must refuse with nothing reserved.
    const spendReservationId = decodeSpendCeilingReservationId(this.#options.uuid());
    const spend = this.#options.spendCeiling?.admit({
      reservationId: spendReservationId,
      threadId: String(subject.aggregateId),
      threadType: subject.aggregateType === "chat-thread" ? "chat-thread" : "work-thread",
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      turnUpperBoundTokens: safeInputBudget,
      countsAsTurn: false,
    });
    if (spend?.status === "refused") return refused("spend-ceiling-reached");
    const releaseSpend = () => {
      if (spend?.status === "admitted") {
        this.#options.spendCeiling?.settle({ reservationId: spendReservationId });
      }
    };

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
      releaseSpend();
      if (error instanceof ProviderCapacitySchedulerRejected)
        return refused("provider-unavailable");
      throw error;
    }
    if (submission.status !== "dispatched") {
      capacity.recordTerminal({ reservationId: capacityReservationId, outcome: "cancelled" });
      releaseSpend();
      return refused("provider-unavailable");
    }
    // Before the request is journaled nothing has reached the provider, so
    // both reservations return whole instead of ending as unmeasured work.
    const releaseUnstarted = () => {
      capacity.releaseUnstarted(capacityReservationId);
      releaseSpend();
    };

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
    // Fixed in the turn of the event loop that journaled the request: a plan
    // appended while the summary is being set up must fail this compaction,
    // not be folded into it.
    const conversation = threads.conversation(String(subject.aggregateId));
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
    const run = this.#run(
      command,
      thread,
      threads,
      driver,
      { conversation, version: requested.version },
      release,
    ).finally(() => {
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
          return this.#options.modeEnabled(current.mode) ? "available" : "mode-disabled";
        },
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

  /**
   * Decides in the order the domain names its refusals, and reads only what
   * the answer still depends on: the facts that cost nothing first, then the
   * conversation, and the provider driver and the spend ceiling only for a
   * request nothing has refused yet. Inspecting a thread runs this on every
   * read, including a paired device's, which is refused before any of it.
   */
  #admission(subject: ContextSubjectRef, principal: Principal): Admission {
    const { harness } = this.#options;
    const kind = String(subject.aggregateType);
    const threadId = String(subject.aggregateId);
    const threads =
      kind === "chat-thread" || kind === "work-thread" ? this.#options.threads[kind] : undefined;
    const thread = threads?.read(threadId);
    // Code threads are planned by Octant Harness or a runtime, and neither
    // offers a compaction request through its connection yet.
    const owner =
      threads === undefined ||
      (thread !== undefined &&
        this.#options.conversationOwner(thread.providerInstanceId) === "runtime")
        ? "runtime"
        : "host";
    const facts = {
      principal,
      modeEnabled: thread === undefined || this.#options.modeEnabled(thread.mode),
      owner,
      runtimeCompaction: "unsupported",
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
      owner === "host" && thread !== undefined && threads !== undefined
        ? harness.previewSessionCompaction({
            subject,
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            conversation: threads.conversation(threadId),
          })
        : undefined;
    // The provider policy is judged before a driver is built for the provider:
    // a driver for a provider the Project excludes must never exist to be
    // asked, and the policy needs only stored facts.
    const policyAllows = thread === undefined || this.#policyAllowsProvider(thread);
    const transient = decideSessionCompaction({
      ...facts,
      hasSession: preview !== undefined && preview.kind !== "no-session",
      compactionRunning:
        this.#running.has(subjectKey(subject)) ||
        harness.latestCompaction(subject)?.status === "running",
      turnRunning: thread !== undefined && threads !== undefined && threads.turnRunning(threadId),
      providerAvailable: policyAllows,
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
      driver !== undefined && preview?.kind === "summarize"
        ? harness.inspect(subject).next.plan.safeInputBudget
        : undefined;
    const spend =
      thread === undefined || driver === undefined
        ? undefined
        : this.#options.spendCeiling?.snapshot({
            principalKind: "local-window",
            threadId,
            threadType: kind === "chat-thread" ? "chat-thread" : "work-thread",
            ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
            ...(compactionBound === undefined ? {} : { turnUpperBoundTokens: compactionBound }),
          });
    const availability = decideSessionCompaction({
      ...facts,
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

  /**
   * Whether the Project's provider policy lets this thread's provider and model
   * see its conversation: the rule a Work turn passes before it sends, judged
   * by the same function. A provider that no longer exists is not allowed.
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

function subjectKey(subject: ContextSubjectRef): string {
  return `${subject.aggregateType}\u0000${subject.aggregateId}`;
}
