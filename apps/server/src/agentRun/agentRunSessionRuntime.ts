import {
  decodeCapacityReservationId,
  decodeContextSubjectRef,
  decodeProviderSessionId,
  decodeUtcTimestamp,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunContextSnapshotId,
  type AgentRunId,
  type CapacityReservationId,
  type ContextSubjectRef,
  type ProviderContextBlock,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderServiceLimits,
  type ProviderSessionId,
  type UtcTimestamp,
} from "@octant/contracts";
import { defaultAgentRunAuthorityCeilingForMode } from "@octant/domain";
import {
  AgentRunPolicyRejected,
  clampAgentRunAuthority,
  effectiveAgentRunExecutionTarget,
} from "@octant/domain/agent-run-policy";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { Cause, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import {
  ProviderCapacitySchedulerRejected,
  type ProviderCapacityScheduler,
  type SchedulerCapacityEnforcement,
} from "../context/providerCapacityScheduler";
import { usageFromRuntimeEvent } from "../providers/providerContextFacts";
import { AGENT_RUN_AGGREGATE_TYPE } from "./agentRunEventStore";
import {
  AgentRunSessionError,
  type AgentRunSessionOutcome,
  type AgentRunSessionPort,
} from "./agentRunSessionPort";

const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * How long teardown may wait for the provider to confirm it ended the session.
 *
 * Teardown is two local control-channel calls, not a turn, so it is bounded far
 * below the runtime deadline: a cancellation must stay responsive, and a
 * provider that has not answered in this long is not about to.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARACTERS = 65_536;
const MAX_REASON_CHARACTERS = 1_024;
const DEFAULT_CAPACITY_ENFORCEMENT: SchedulerCapacityEnforcement = {
  kind: "observable-api",
  maxObservableConcurrency: 2,
};
const AVERAGE_CHARACTERS_PER_TOKEN = 4;

/**
 * Resolves the immutable context selection a child was admitted with.
 *
 * The snapshot id is recorded on the routing receipt at creation time, so
 * execution reads the selection back rather than re-deriving it from the live
 * parent thread. A snapshot that cannot be resolved fails the start closed:
 * silently sending a child with less context than it was approved for would
 * change what the user consented to.
 */
export interface AgentRunContextSnapshotPort {
  readonly resolve: (input: {
    readonly runId: AgentRunId;
    readonly contextSnapshotId: AgentRunContextSnapshotId;
  }) => ReadonlyArray<ProviderContextBlock> | undefined;
}

/**
 * Resolves the recorded context snapshot from the run's own journaled
 * admission and the store that holds the blocks it admitted.
 *
 * The snapshot id and the block count live on the routing receipt inside the
 * `agent.run-requested@1` payload, so the projection behind `getById` is
 * rebuilt by journal replay. The blocks are the parent thread's conversation
 * and must stay purgeable, so they live in the AgentRun content store keyed by
 * that same snapshot id and run — the record execution reads is the one the
 * admission named, so the id is still verified against the very record that
 * holds the blocks. A child admitted with no parent context records none, and
 * runs with none.
 *
 * Resolution fails closed to undefined — reported as `context-unavailable` —
 * for an unknown run, a snapshot id the run never recorded, or an admission
 * whose blocks are gone because the parent thread was permanently deleted.
 * Running such a child on an empty selection would give it less context than
 * the user approved.
 */
export function createRecordedAgentRunContextSnapshotPort(options: {
  readonly getById: (runId: AgentRunId) => AgentRun | undefined;
  readonly readAdmittedContext: (input: {
    readonly runId: AgentRunId;
    readonly contextSnapshotId: AgentRunContextSnapshotId;
  }) => ReadonlyArray<ProviderContextBlock> | undefined;
}): AgentRunContextSnapshotPort {
  return {
    resolve: ({ runId, contextSnapshotId }) => {
      const run = options.getById(runId);
      if (run === undefined) return undefined;
      if (String(run.routingReceipt.contextSnapshotId) !== String(contextSnapshotId)) {
        return undefined;
      }
      if (run.routingReceipt.admittedContextBlocks === undefined) return [];
      return options.readAdmittedContext({ runId: run.id, contextSnapshotId });
    },
  };
}

export interface AgentRunSessionRuntimeOptions {
  /** Resolves the configured driver for a provider instance, or undefined. */
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly context: AgentRunContextSnapshotPort;
  readonly uuid: () => string;
  /** Filesystem root for Chat children, which own no workspace of their own. */
  readonly scratchRoot?: (run: AgentRun) => string | undefined;
  /**
   * Observed provider service limits. Supplied when this host has fresher facts
   * than the scheduler already holds; without either, capacity reservation
   * fails closed rather than guessing a provider's limits.
   */
  readonly serviceLimits?: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => ProviderServiceLimits | undefined;
  readonly capacityEnforcement?: SchedulerCapacityEnforcement;
  readonly maxEvents?: number;
  readonly timeoutMs?: number;
  /** Bound on one teardown attempt; see {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
  readonly shutdownTimeoutMs?: number;
  /** Publishes ephemeral managed-child transcript facts to the host read model. */
  readonly onSessionStarted?: (input: { readonly runId: AgentRunId }) => void;
  readonly onTextDelta?: (input: {
    readonly runId: AgentRunId;
    readonly text: string;
    readonly occurredAt: UtcTimestamp;
  }) => void;
  readonly onSessionSettled?: (input: {
    readonly runId: AgentRunId;
    readonly outcome: AgentRunSessionOutcome;
  }) => void;
  readonly reconcile?: () => Promise<void>;
}

/**
 * A provider shutdown this runtime could not confirm.
 *
 * `stop` is the call that ends the provider session, so a rejected `stop`
 * leaves execution possibly live and its cancellation unproven. A rejected
 * `interrupt` whose `stop` succeeded is not recorded here: the session it was
 * generating in no longer exists, so that shutdown genuinely terminated the
 * provider.
 */
interface UnconfirmedShutdown {
  readonly failure: ProviderFailure;
  /** Re-attempts the shutdown, clearing this record only once it succeeds. */
  readonly retry: () => Promise<void>;
}

/** Shutdown state shared between a managed session and the port that stops it. */
interface SessionShutdown {
  unconfirmed: UnconfirmedShutdown | undefined;
}

interface LiveSession {
  readonly controller: AbortController;
  /** Resolves once the managed session ended, whether or not it settled. */
  readonly finished: Promise<void>;
  readonly shutdown: SessionShutdown;
  /** Publishes an outcome withheld while the shutdown stayed unconfirmed. */
  readonly publish: () => void;
}

/**
 * Executes an Octant-managed child as an in-process provider session driven
 * through the ordinary provider registry and drivers.
 *
 * The approved design defines a managed child as "an independent Octant-managed
 * provider session", and requires that core child semantics never depend on a
 * provider's native subagent facility. Running the child here — same drivers,
 * same capacity scheduler, same normalized events — is what keeps that promise
 * without inventing a second launch path or a second authority path.
 *
 * Every start-time dependency is resolved before the session is considered
 * live, and a missing one throws {@link AgentRunSessionError}. Orchestration
 * already treats a throwing `start` as process death, so an unstartable child
 * lands in a durable recoverable state instead of appearing to run.
 */
export function createAgentRunSessionRuntime(
  options: AgentRunSessionRuntimeOptions,
): AgentRunSessionPort {
  const sessions = new Map<AgentRunId, LiveSession>();
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  return {
    start: (run) => {
      // Authority is re-derived from the persisted run, never inherited from
      // the parent thread at execution time: the parent's live grant may have
      // widened since admission, and a child must never gain from that.
      const authority = clampAgentRunSessionAuthority(run);
      const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
      const driver = options.resolveDriver(target.providerInstanceId);
      if (driver === undefined) {
        throw new AgentRunSessionError(
          "provider-unavailable",
          `Provider instance ${String(target.providerInstanceId)} is not configured on this host.`,
        );
      }
      const projectRoot = resolveProjectRoot(run, options.scratchRoot);
      const context = options.context.resolve({
        runId: run.id,
        contextSnapshotId: run.routingReceipt.contextSnapshotId,
      });
      if (context === undefined) {
        throw new AgentRunSessionError(
          "context-unavailable",
          "The AgentRun context snapshot could not be resolved for execution.",
        );
      }

      const subject = decodeContextSubjectRef({
        aggregateType: AGENT_RUN_AGGREGATE_TYPE,
        aggregateId: String(run.id),
      });
      const reservationId = reserveCapacity({
        capacityScheduler: options.capacityScheduler,
        ...(options.serviceLimits === undefined ? {} : { serviceLimits: options.serviceLimits }),
        ...(options.capacityEnforcement === undefined
          ? {}
          : { capacityEnforcement: options.capacityEnforcement }),
        uuid: options.uuid,
        subject,
        providerInstanceId: target.providerInstanceId,
        modelId: target.modelId,
        estimatedTokens: estimateInputTokens(run, context),
      });

      const listeners = new Set<(outcome: AgentRunSessionOutcome) => void>();
      let settledOutcome: AgentRunSessionOutcome | undefined;
      const settle = (outcome: AgentRunSessionOutcome): void => {
        if (settledOutcome !== undefined) return;
        settledOutcome = outcome;
        try {
          options.onSessionSettled?.({ runId: run.id, outcome });
        } catch {
          // A transient observer must never prevent lifecycle settlement.
        }
        sessions.delete(run.id);
        for (const listener of listeners) listener(outcome);
      };

      const shutdown: SessionShutdown = { unconfirmed: undefined };
      let endedOutcome: AgentRunSessionOutcome | undefined;
      let markFinished: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        markFinished = resolve;
      });
      const end = (outcome: AgentRunSessionOutcome): void => {
        endedOutcome = outcome;
        // A shutdown the provider never confirmed is not a terminal fact.
        // Withholding the outcome keeps the session owned here and at the
        // supervisor, so the cancellation stays pending and retryable instead
        // of being reported as a termination nobody observed.
        if (shutdown.unconfirmed === undefined) settle(outcome);
        markFinished();
      };

      const controller = new AbortController();
      sessions.set(run.id, {
        controller,
        finished,
        shutdown,
        publish: () => {
          if (endedOutcome !== undefined) settle(endedOutcome);
        },
      });
      try {
        options.onSessionStarted?.({ runId: run.id });
      } catch {
        // A transient observer must never prevent provider startup.
      }

      void Effect.runPromiseExit(
        Effect.scoped(
          runManagedSession({
            run,
            driver,
            authority,
            projectRoot,
            context,
            reservationId,
            capacityScheduler: options.capacityScheduler,
            providerInstanceId: target.providerInstanceId,
            modelId: target.modelId,
            sessionId: decodeProviderSessionId(options.uuid()),
            maxEvents,
            timeoutMs,
            shutdownTimeoutMs,
            shutdown,
            onTextDelta: options.onTextDelta,
          }),
        ),
        { signal: controller.signal },
      ).then(
        (exit) => end(outcomeFromExit(exit)),
        (error: unknown) => end({ kind: "interrupted", reason: boundedReason(error) }),
      );

      return {
        runId: run.id,
        onSettled: (listener) => {
          if (settledOutcome !== undefined) {
            listener(settledOutcome);
            return;
          }
          listeners.add(listener);
        },
      };
    },

    stop: async (runId) => {
      const live = sessions.get(runId);
      if (live === undefined) return;
      const pending = live.shutdown.unconfirmed;
      if (pending === undefined) {
        // Aborting interrupts the session fiber; its scope finalizers interrupt
        // and stop the provider session and release capacity. Awaiting is what
        // makes cancellation durable only after execution is confirmed stopped.
        live.controller.abort();
        await live.finished;
      } else {
        // An earlier stop could not confirm this shutdown, so the session is
        // still owned: re-attempt it rather than reporting a termination
        // nobody observed.
        await pending.retry();
      }
      const failure = live.shutdown.unconfirmed?.failure;
      if (failure !== undefined) {
        // Rejecting is what keeps the run supervised and its cancellation
        // pending. Resolving here would let the caller durably record a
        // cancellation while the provider execution may still be live.
        throw new Error(
          `Managed AgentRun session shutdown was not confirmed: ${boundedReason(failure.message)}`,
        );
      }
      live.publish();
    },

    ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
  };
}

/**
 * Intersects the run's persisted authority with the mode ceiling and the
 * immutable authority its routing receipt recorded. Both inputs come from the
 * AgentRun itself, so this can only narrow: a run whose stored authority is
 * wider than either fails closed as drift rather than executing.
 */
export function clampAgentRunSessionAuthority(run: AgentRun): AgentRunAuthority {
  const resolution = run.routingReceipt.executionResolution;
  const receiptCeiling: AgentRunAuthority = {
    filesystem: resolution.effectivePermissions.filesystem,
    shell: resolution.effectivePermissions.shell,
    git: resolution.effectivePermissions.git,
    network: resolution.effectivePermissions.network,
    tools: resolution.effectivePermissions.tools,
    subagents: resolution.effectivePermissions.subagents,
    executionPolicy: resolution.executionPolicy,
    permissionPersistence: resolution.permissionPersistence,
  };
  try {
    return clampAgentRunAuthority({
      parentAuthority: defaultAgentRunAuthorityCeilingForMode(run.routingReceipt.mode),
      projectCeiling: receiptCeiling,
      requestedAuthority: run.authority,
    });
  } catch (error) {
    if (error instanceof AgentRunPolicyRejected) {
      throw new AgentRunSessionError(
        "authority-drift",
        `AgentRun authority is wider than its recorded ceilings: ${error.message}`,
      );
    }
    throw error;
  }
}

function resolveProjectRoot(
  run: AgentRun,
  scratchRoot: ((run: AgentRun) => string | undefined) | undefined,
): string {
  const workspace = run.workspaceReceipt;
  if (workspace.kind === "code-worktree") {
    if (!workspace.verified) {
      throw new AgentRunSessionError(
        "workspace-unavailable",
        "Code AgentRun execution requires a verified isolated worktree.",
      );
    }
    return workspace.worktreeRoot;
  }
  if (workspace.kind === "work-root") return workspace.canonicalRoot;
  // Chat children are research-only and own no workspace, but a driver still
  // needs a root to run in. Without a scratch root there is nowhere isolated
  // to put one, and the parent checkout is never an acceptable substitute.
  const scratch = scratchRoot?.(run);
  if (scratch === undefined || scratch.length === 0) {
    throw new AgentRunSessionError(
      "workspace-unavailable",
      "Chat AgentRun execution requires a scratch root on this host.",
    );
  }
  return scratch;
}

function reserveCapacity(input: {
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly serviceLimits?: (facts: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => ProviderServiceLimits | undefined;
  readonly capacityEnforcement?: SchedulerCapacityEnforcement;
  readonly uuid: () => string;
  readonly subject: ContextSubjectRef;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly estimatedTokens: number;
}): CapacityReservationId {
  const limits = input.serviceLimits?.({
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
  });
  const reservationId = decodeCapacityReservationId(input.uuid());
  try {
    if (limits !== undefined) {
      input.capacityScheduler.updateProviderFacts({
        limits,
        enforcement: input.capacityEnforcement ?? DEFAULT_CAPACITY_ENFORCEMENT,
      });
    }
    const submission = input.capacityScheduler.submit({
      reservationId,
      subject: input.subject,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      estimatedTokens: input.estimatedTokens,
      requests: 1,
      // Managed children are accounted as subagent work, never as parent-thread
      // work, so per-origin capacity policy stays meaningful.
      origin: "subagent",
    });
    if (submission.status === "queued") {
      input.capacityScheduler.recordTerminal({
        reservationId,
        outcome: "timeout",
      });
      throw new AgentRunSessionError(
        "capacity-unavailable",
        `Provider capacity is unavailable for this AgentRun: ${submission.reason}.`,
      );
    }
    input.capacityScheduler.markRunning(reservationId);
    return reservationId;
  } catch (error) {
    if (error instanceof ProviderCapacitySchedulerRejected) {
      throw new AgentRunSessionError(
        "capacity-unavailable",
        `Provider capacity could not be reserved for this AgentRun: ${error.message}`,
      );
    }
    throw error;
  }
}

interface ManagedSessionInput {
  readonly run: AgentRun;
  readonly driver: ProviderDriver;
  readonly authority: AgentRunAuthority;
  readonly projectRoot: string;
  readonly context: ReadonlyArray<ProviderContextBlock>;
  readonly reservationId: CapacityReservationId;
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly sessionId: ProviderSessionId;
  readonly maxEvents: number;
  readonly timeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly shutdown: SessionShutdown;
  readonly onTextDelta?: AgentRunSessionRuntimeOptions["onTextDelta"];
}

interface ManagedSessionState {
  outcome: AgentRunSessionOutcome | undefined;
  responseText: string;
  inputTokens: number;
  outputTokens: number;
  sawUsage: boolean;
  handledEvents: number;
  /** Whether a provider connection was acquired at all. */
  acquired: boolean;
  /** Whether the runtime deadline, rather than the provider, ended the turn. */
  timedOut: boolean;
}

/**
 * Runs one managed session under a single runtime deadline.
 *
 * The deadline covers acquisition, startup, the first send, and collection
 * together, because a provider that wedges before it ever emits an event is
 * exactly the case a collection-only deadline cannot see: the run would stay
 * active and hold its capacity reservation until a user cancels or the host
 * restarts. Expiry is reported as `interrupted` — the contract's honest state
 * for a turn that ended without a terminal provider event.
 */
function runManagedSession(
  input: ManagedSessionInput,
): Effect.Effect<AgentRunSessionOutcome, ProviderFailure, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const state: ManagedSessionState = {
        outcome: undefined,
        responseText: "",
        inputTokens: 0,
        outputTokens: 0,
        sawUsage: false,
        handledEvents: 0,
        acquired: false,
        timedOut: false,
      };

      let released = false;
      const releaseCapacity = (): void => {
        if (released) return;
        released = true;
        input.capacityScheduler.recordTerminal({
          reservationId: input.reservationId,
          outcome: capacityOutcomeFor(state),
          ...(state.outcome?.kind === "completed" && state.sawUsage
            ? { actualTokens: state.inputTokens + state.outputTokens }
            : {}),
        });
      };

      // Registered before the provider is touched, so every exit releases the
      // reservation — including a deadline that fires while acquisition or
      // startup is still wedged, which registers no other finalizer at all.
      //
      // Registered first also means it runs last, after the teardown below has
      // recorded whether the provider confirmed it. That ordering is what lets
      // this ask the question at all.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // A shutdown the provider never confirmed is not a terminal fact
          // about the provider's own concurrency: the request may still be
          // executing. A terminal signal here would let the scheduler age the
          // reservation out after its ambiguous TTL and dispatch other turns
          // past the provider's boundary, so the unconfirmed session keeps
          // holding its slot instead. `shutdownProviderSession` releases it as
          // soon as a retry confirms; failing that, nothing local does — and
          // nothing local should, because nothing local knows the request
          // ended. The reservation cannot outlive the claim either way: the
          // scheduler is per-process in-memory state, and a managed session
          // never outlives its host, so host exit reclaims the slot at exactly
          // the moment it also reclaims the session.
          if (input.shutdown.unconfirmed !== undefined) return;
          releaseCapacity();
        }),
      );

      const finished = yield* runSessionTurn(input, state, releaseCapacity).pipe(
        Effect.timeoutTo({
          duration: input.timeoutMs,
          onTimeout: () => "timed-out" as const,
          onSuccess: (outcome: AgentRunSessionOutcome) => outcome,
        }),
      );
      if (finished === "timed-out") {
        // Deliberately not recorded on `state.outcome`: the provider never
        // reported a terminal event, so the shutdown below must still interrupt
        // it rather than assume the turn ended on its own.
        state.timedOut = true;
        return {
          kind: "interrupted",
          reason: "Managed AgentRun turn exceeded its runtime deadline.",
        };
      }
      return finished;
    }),
  );
}

/**
 * Acquires the provider, runs the turn, and registers the shutdown that ends
 * it. Every resource lands on the caller's scope, so a deadline that interrupts
 * this effect still stops whatever it managed to acquire.
 */
function runSessionTurn(
  input: ManagedSessionInput,
  state: ManagedSessionState,
  releaseCapacity: () => void,
): Effect.Effect<AgentRunSessionOutcome, ProviderFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const connection = yield* input.driver.acquire({
      instanceId: input.providerInstanceId,
      projectRoot: input.projectRoot,
      mode: input.run.routingReceipt.mode,
    });
    state.acquired = true;

    yield* Effect.addFinalizer(() =>
      shutdownProviderSession(connection, input, state, releaseCapacity),
    );

    yield* connection.start({
      sessionId: input.sessionId,
      modelId: input.modelId,
      // The clamped run authority is what reaches the provider. Nothing here
      // may widen it, and no parent-thread policy is consulted.
      executionPolicy: input.authority.executionPolicy,
    });

    const collected = yield* Effect.forkScoped(collectSessionEvents(connection, input, state));

    yield* connection.send({
      sessionId: input.sessionId,
      prompt: input.run.task,
      context: [...input.context],
      // This slice grants a managed child no attachments and no app-managed
      // tools; requests for either are declined rather than silently served.
      attachments: [],
      tools: [],
    });

    yield* Fiber.join(collected);

    return (
      state.outcome ?? {
        kind: "interrupted",
        reason: "Managed AgentRun turn ended without a terminal provider event.",
      }
    );
  });
}

/**
 * Ends the provider session and records whether that shutdown was confirmed.
 *
 * `interrupt` only asks the provider to abandon the in-flight turn, and `stop`
 * ends the session outright — so a rejected `interrupt` followed by a
 * successful `stop` is a genuine termination and must not keep a cancellation
 * pending. A rejected `stop` is the state that may leave execution live, so it
 * is preserved for {@link AgentRunSessionPort.stop} to reject on and retry.
 *
 * The attempt is bounded because a provider that answers neither way is the
 * case a reject-or-resolve teardown cannot see: this runs as a scope finalizer,
 * so waiting forever would stall the whole release path — the reservation would
 * never be ended and no outcome would ever be published. The bound belongs here
 * rather than around the shutdown as a whole precisely so the finalizers behind
 * it, capacity release included, still run. Expiry is recorded exactly like a
 * rejection: unconfirmed, retryable, and never reported as a termination.
 *
 * What expiry cannot do is close the connection. Nothing on the driver seam
 * force-kills a provider session, so the provider-side session and whatever
 * process or channel backs it stay live and outside this host's control until
 * the provider ends them itself. Only the local ownership is reclaimed, at
 * host restart: managed sessions never outlive their host, so the next start
 * reconciles the run as dead and `reconcile` performs provider-side cleanup.
 *
 * Because an unconfirmed shutdown leaves the provider possibly executing, the
 * capacity finalizer withholds its terminal signal for exactly that state.
 * `releaseCapacity` is therefore called from here on success: a confirmed
 * shutdown is the fact that ends the reservation, whether it is confirmed on
 * the first attempt or on a later retry. It releases at most once, so this path
 * and the finalizer cannot end the same reservation twice.
 */
function shutdownProviderSession(
  connection: ProviderConnection,
  input: ManagedSessionInput,
  state: ManagedSessionState,
  releaseCapacity: () => void,
): Effect.Effect<void> {
  const attempt = Effect.gen(function* () {
    if (state.outcome === undefined) {
      yield* connection.interrupt(input.sessionId).pipe(Effect.catchAll(() => Effect.void));
    }
    yield* connection.stop(input.sessionId);
  }).pipe(
    // The bound only bites inside an interruptible region: a finalizer runs
    // uninterruptibly, and a race that inherits that waits on the very call it
    // exists to give up on. Cancellation reaches this finalizer only after the
    // turn was already interrupted, so re-opening the region here abandons the
    // wedged call rather than the teardown.
    Effect.interruptible,
    Effect.timeoutFail({
      duration: input.shutdownTimeoutMs,
      onTimeout: (): ProviderFailure => ({
        category: "unavailable",
        message: "The provider did not confirm the session shutdown before the teardown deadline.",
      }),
    }),
  );
  const record = (): Effect.Effect<void> =>
    attempt.pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.sync(() => {
            input.shutdown.unconfirmed = undefined;
            releaseCapacity();
          }),
        onFailure: (failure) =>
          Effect.sync(() => {
            // A turn the provider itself ended is not made live again by a
            // failed teardown, and its outcome was observed: reporting it is
            // honest, while withholding it would strand a finished child.
            // Only a turn nobody saw end may still be executing.
            if (state.outcome !== undefined) return;
            input.shutdown.unconfirmed = {
              failure,
              retry: () => Effect.runPromise(record()),
            };
          }),
      }),
    );
  return record();
}

function collectSessionEvents(
  connection: ProviderConnection,
  input: ManagedSessionInput,
  state: ManagedSessionState,
): Effect.Effect<void, ProviderFailure> {
  const answeredToolRequestIds = new Set<string>();
  const answeredApprovalRequestIds = new Set<string>();

  return connection.events.pipe(
    Stream.filter((event) => event.sessionId === input.sessionId),
    Stream.take(input.maxEvents + 1),
    Stream.takeUntil(
      (event) =>
        event.kind === "waiting" ||
        event.kind === "completed" ||
        event.kind === "interrupted" ||
        event.kind === "failed",
    ),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        state.handledEvents += 1;
        if (state.handledEvents > input.maxEvents) {
          state.outcome = {
            kind: "interrupted",
            reason: "Managed AgentRun turn exceeded its bounded event budget.",
          };
          return;
        }
        if (event.kind === "text-delta") {
          const delta = publishableTextDelta(event);
          if (delta === undefined) return;
          state.responseText = (state.responseText + delta.text).slice(0, MAX_RESPONSE_CHARACTERS);
          try {
            input.onTextDelta?.({
              runId: input.run.id,
              text: delta.text,
              occurredAt: delta.occurredAt,
            });
          } catch {
            // A transient observer must never interrupt provider collection.
          }
          return;
        }
        if (event.kind === "usage") {
          const observation = usageFromRuntimeEvent(event);
          if (observation !== undefined) {
            state.sawUsage = true;
            state.inputTokens = observation.inputTokens;
            state.outputTokens = observation.outputTokens;
          }
          return;
        }
        if (event.kind === "approval-request") {
          if (answeredApprovalRequestIds.has(event.requestId)) return;
          answeredApprovalRequestIds.add(event.requestId);
          // A managed child has no interactive approver on this path. Declining
          // keeps the run inside its admitted authority; approving on the
          // child's behalf would manufacture consent nobody gave.
          yield* connection.answerApproval({
            sessionId: input.sessionId,
            requestId: event.requestId,
            approved: false,
          });
          return;
        }
        if (event.kind === "tool-request") {
          if (answeredToolRequestIds.has(event.requestId)) return;
          answeredToolRequestIds.add(event.requestId);
          yield* connection.answerTool({
            sessionId: input.sessionId,
            requestId: event.requestId,
            resultJson: JSON.stringify({ error: "tool-unavailable" }),
            isError: true,
          });
          return;
        }
        if (event.kind === "waiting") {
          state.outcome = {
            kind: "waiting",
            reason: boundedReason(event.message),
          };
          return;
        }
        if (event.kind === "interrupted") {
          state.outcome = {
            kind: "interrupted",
            reason: boundedReason(event.message),
          };
          return;
        }
        if (event.kind === "failed") {
          state.outcome = { kind: "failed", failure: event.failure };
          return;
        }
        if (event.kind === "completed") {
          // A provider that completes without a visible reply produced no
          // result to return to the parent; reporting completion would be a
          // fabricated success.
          state.outcome =
            state.responseText.trim().length === 0
              ? {
                  kind: "failed",
                  failure: {
                    category: "provider-failed",
                    message: "The provider completed without a visible reply.",
                  },
                }
              : {
                  kind: "completed",
                  responseText: state.responseText,
                  ...(state.sawUsage
                    ? {
                        usage: {
                          inputTokens: state.inputTokens,
                          outputTokens: state.outputTokens,
                        },
                      }
                    : {}),
                };
        }
      }),
    ),
  );
}

function publishableTextDelta(event: {
  readonly kind: string;
  readonly text?: unknown;
  readonly occurredAt?: unknown;
}): { readonly text: string; readonly occurredAt: UtcTimestamp } | undefined {
  if (event.kind !== "text-delta") return undefined;
  if (typeof event.text !== "string" || event.text.trim().length === 0) return undefined;
  let occurredAt: UtcTimestamp;
  try {
    occurredAt = decodeUtcTimestamp(event.occurredAt);
  } catch {
    occurredAt = decodeUtcTimestamp(new Date().toISOString());
  }
  return {
    text: event.text,
    occurredAt,
  };
}

function capacityOutcomeFor(
  state: ManagedSessionState,
): "completed" | "cancelled" | "interrupted" | "timeout" | "process-death" {
  // A deadline is a timeout whichever phase it fired in, and a session that
  // never acquired a connection reached no provider to interrupt.
  if (state.timedOut) return "timeout";
  if (!state.acquired) return "process-death";
  const outcome = state.outcome;
  if (outcome === undefined) return "cancelled";
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return "timeout";
    default:
      return "interrupted";
  }
}

function outcomeFromExit(
  exit: Exit.Exit<AgentRunSessionOutcome, ProviderFailure>,
): AgentRunSessionOutcome {
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) return { kind: "failed", failure: failure.value };
  if (Cause.isInterruptedOnly(exit.cause)) return { kind: "cancelled" };
  return {
    kind: "interrupted",
    reason: boundedReason(Cause.pretty(exit.cause)),
  };
}

/**
 * Conservative planner-free estimate. The context planner is not on the child
 * path in this slice, and the routing receipt already records usage quality as
 * unavailable, so this reserves capacity without claiming measured accuracy.
 */
function estimateInputTokens(run: AgentRun, context: ReadonlyArray<ProviderContextBlock>): number {
  const characters = context.reduce((total, block) => total + block.text.length, run.task.length);
  return Math.max(1, Math.ceil(characters / AVERAGE_CHARACTERS_PER_TOKEN));
}

function boundedReason(reason: unknown): string {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : "Managed AgentRun session ended unexpectedly.";
  const trimmed = text.trim();
  return trimmed.length === 0
    ? "Managed AgentRun session ended unexpectedly."
    : trimmed.slice(0, MAX_REASON_CHARACTERS);
}
