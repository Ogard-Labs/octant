import {
  decodeAutomationCommand,
  decodeAutomationDefinition,
  deriveAutomationOccurrenceKey,
  type AutomationCommand,
  type AutomationCommandFailure,
  type AutomationCommandResult,
  type AutomationClientPrincipal,
  type AutomationDefinition,
  type AutomationId,
  type AutomationRunId,
  type AutomationThreadId,
  type AutomationTrigger,
  type AutomationWeeklyResolution,
  type EventActor,
  type UtcTimestamp,
} from "@octant/contracts";
import type { AutomationEventSourcePreparation } from "./automationEventSources";
import { isDeepStrictEqual } from "node:util";
import {
  AutomationPolicyRejected,
  buildAutomationWeeklyResolution,
  isAutomationMutationAllowed,
  isAutomationRunLifecycleActive,
  resolveNextAutomationOccurrence,
  validateAutomationDefinition,
} from "@octant/domain";
import { eventActorForPrincipal } from "../principalEventActor";
import { AutomationEventStore, AutomationEventStoreError } from "./automationEventStore";
import type {
  AutomationFileSourcePreparation,
  AutomationFileSourceRearmPreparation,
} from "./automationFileSourceAuthority";
import type { AutomationProjection } from "./automationProjection";
import {
  automationRunIdForOccurrence,
  buildAutomationRunForOccurrence,
} from "./automationRunIdentity";

export interface AutomationCommandServiceOptions {
  readonly store: Pick<
    AutomationEventStore,
    | "appendDefinitionCreated"
    | "appendDefinitionUpdated"
    | "appendDefinitionLifecycleChanged"
    | "appendRunCreated"
    | "appendRunCancellation"
    | "appendOccurrenceLedger"
  >;
  readonly projection: AutomationProjection;
  /** The identifier of the host that owns every definition this server holds. */
  readonly hostId: string;
  readonly clock: () => string;
}

/** Facts about a create that only the host can vouch for. */
export interface AutomationProvenance {
  /** The thread whose agent proposed the routine a person confirmed. */
  readonly originThreadId: AutomationThreadId;
}

interface DueState {
  readonly nextDueAt: UtcTimestamp | null;
  readonly nextDueResolution?: AutomationWeeklyResolution;
}

/**
 * Server-authoritative Automation command service. Every mutation revalidates
 * origin (recursion prohibition), the authenticated principal's host, the
 * expected aggregate version, and the full definition policy before any
 * journal side effect. Run-now and cancel-current-run are idempotent through
 * request-id-derived identities and cancellation tombstone receipts, so
 * retries after crash/reconnect return the original receipt instead of a
 * second side effect. Archive is the only terminal definition transition;
 * delete does not exist and history is preserved.
 */
export class AutomationCommandService {
  readonly #store: AutomationCommandServiceOptions["store"];
  readonly #projection: AutomationProjection;
  readonly #hostId: string;
  readonly #clock: () => string;

  constructor(options: AutomationCommandServiceOptions) {
    this.#store = options.store;
    this.#projection = options.projection;
    this.#hostId = options.hostId;
    this.#clock = options.clock;
  }

  /**
   * `provenance` is what the host itself knows about a create, never part of
   * the wire command: a route body cannot claim a thread proposed its routine.
   */
  execute(
    input: AutomationCommand,
    provenance?: AutomationProvenance,
    source?: AutomationFileSourcePreparation | AutomationFileSourceRearmPreparation,
    eventSource?: AutomationEventSourcePreparation,
  ): AutomationCommandResult {
    let command: AutomationCommand;
    try {
      command = decodeAutomationCommand(input);
    } catch {
      return failure("invalid", "Automation command failed strict validation.");
    }
    if (!isAutomationMutationAllowed(command.origin)) {
      return failure(
        "unauthorized",
        "Automation-origin actors cannot mutate Automation definitions or runs.",
        { automationId: command.automationId },
      );
    }
    const principalIssue = this.#checkPrincipalHost(command.principal);
    if (principalIssue !== undefined) return principalIssue;
    if (
      (command.kind === "create-automation" || command.kind === "update-automation") &&
      command.definition.trigger.kind === "integration-event" &&
      (command.principal.kind !== "local-window" ||
        provenance !== undefined ||
        eventSource === undefined ||
        !eventSource.current() ||
        !isDeepStrictEqual(eventSource.definition, command.definition))
    )
      return failure(
        "blocked",
        "Choose and verify a connected event source from a window on this host.",
      );

    try {
      switch (command.kind) {
        case "rearm-file-automation":
          return this.#rearmFileSource(command, source?.kind === "rearm" ? source : undefined);
        case "create-automation":
          return this.#create(
            command,
            provenance,
            source?.kind === "definition" ? source : undefined,
            eventSource,
          );
        case "update-automation":
          return this.#update(
            command,
            source?.kind === "definition" ? source : undefined,
            eventSource,
          );
        case "pause-automation":
          return this.#changeLifecycle(command, "paused", "automation-paused");
        case "resume-automation":
          return this.#changeLifecycle(command, "enabled", "automation-resumed");
        case "archive-automation":
          return this.#changeLifecycle(command, "archived", "automation-archived");
        case "run-now-automation":
          return this.#runNow(command);
        case "cancel-current-automation-run":
          return this.#cancelCurrentRun(command);
      }
    } catch (error) {
      return mapCommandError(error, command.automationId);
    }
  }

  #checkPrincipalHost(principal: AutomationClientPrincipal): AutomationCommandFailure | undefined {
    if (principal.kind === "remote-device" && String(principal.hostId) !== this.#hostId) {
      return failure(
        "unauthorized",
        "Remote principals may only mutate Automations on their owning host.",
      );
    }
    return undefined;
  }

  #rearmFileSource(
    command: Extract<AutomationCommand, { readonly kind: "rearm-file-automation" }>,
    prepared: AutomationFileSourceRearmPreparation | undefined,
  ): AutomationCommandResult {
    const definition = this.#projection.getDefinition(command.automationId);
    const gate = this.#gateDefinitionMutation(definition, command);
    if (gate !== undefined) return gate;
    if (definition === undefined || definition.trigger.kind !== "file-arrival")
      return failure("unsupported", "Only local Work file routines can be re-armed here.");
    const previous = this.#projection.getFileSource(command.automationId);
    if (
      command.principal.kind !== "local-window" ||
      prepared === undefined ||
      previous === undefined ||
      prepared.automationId !== command.automationId ||
      prepared.expectedVersion !== command.expectedVersion ||
      prepared.review.previousObservationRevision !== command.observationRevision ||
      prepared.review.previousSourceIdentity !== command.sourceIdentity ||
      prepared.review.previousBatchDigest !== command.batchDigest ||
      prepared.review.disposition !== command.disposition ||
      prepared.review.reviewedWindowId !== command.principal.windowId ||
      prepared.review.reviewedCapabilityGeneration !== command.principal.capabilityGeneration ||
      previous.observationRevision !== command.observationRevision ||
      previous.sourceIdentity !== command.sourceIdentity ||
      (previous.held?.digest ?? previous.baselineDigest) !== command.batchDigest ||
      !prepared.current()
    )
      return failure(
        "stale-version",
        "The input review is no longer current. Refresh it before re-arming.",
      );
    if (this.#projection.activeRun(command.automationId) !== undefined)
      return failure(
        "active-occurrence",
        "Finish the current routine and its known activity before re-arming.",
      );
    const now = this.#now();
    const { blockedReason: _blocked, nextDueResolution: _resolution, ...base } = definition;
    const updated = validateAutomationDefinition(
      decodeAutomationDefinition({
        ...base,
        lifecycle: "enabled",
        nextDueAt: null,
        version: definition.version + 1,
        updatedAt: now,
        updatedBy: command.principal,
      }),
    );
    const rearmed = {
      kind: "file-source-rearmed" as const,
      automation: updated,
      previousLifecycle: definition.lifecycle,
      checkpoint: prepared.checkpoint,
      review: prepared.review,
      at: now,
    };
    if (command.disposition === "skip") {
      this.#store.appendOccurrenceLedger({
        automationId: definition.id,
        expectedVersion: definition.version,
        events: [rearmed],
      });
      return {
        kind: "automation-resumed",
        automation: this.#projection.getDefinition(definition.id) ?? updated,
      };
    }
    const occurrence = {
      kind: "file-arrival" as const,
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      source: {
        checkpoint: prepared.checkpoint,
        files: prepared.files,
        automaticStartOrdinal: 1,
        rearm: prepared.review,
      },
    };
    const run = buildAutomationRunForOccurrence({ definition: updated, occurrence, now });
    this.#store.appendRunCreated({ run });
    this.#store.appendOccurrenceLedger({
      automationId: definition.id,
      expectedVersion: definition.version,
      events: [rearmed, { kind: "occurrence-claimed", occurrence, runId: run.id, at: now }],
    });
    return { kind: "automation-run-accepted", run: this.#projection.getRun(run.id) ?? run };
  }

  #create(
    command: Extract<AutomationCommand, { readonly kind: "create-automation" }>,
    provenance: AutomationProvenance | undefined,
    source: AutomationFileSourcePreparation | undefined,
    eventSource: AutomationEventSourcePreparation | undefined,
  ): AutomationCommandResult {
    if (String(command.definition.hostId) !== this.#hostId) {
      return failure("unauthorized", "Automation definitions are owned by exactly one host.", {
        automationId: command.automationId,
      });
    }
    if (command.expectedVersion !== 0) {
      return failure("stale-version", "Automation create requires expected version 0.", {
        automationId: command.automationId,
      });
    }
    if (
      command.definition.trigger.kind === "file-arrival" &&
      (provenance !== undefined || !this.#sourcePrepared(command, source))
    )
      return failure(
        "blocked",
        "Choose an available local Work input folder before saving this file routine.",
      );
    const now = this.#now();
    const paused = command.initialLifecycle === "paused";
    const definition = validateAutomationDefinition(
      decodeAutomationDefinition({
        id: command.automationId,
        ...command.definition,
        lifecycle: paused ? "paused" : "enabled",
        definitionRevision: 1,
        ...(paused ? { nextDueAt: null } : this.#dueState(command.definition.trigger)),
        createdBy: command.principal,
        updatedBy: command.principal,
        ...(provenance === undefined ? {} : { originThreadId: provenance.originThreadId }),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    this.#store.appendDefinitionCreated({
      ...personActor(command.principal),
      automation: definition,
      ...(eventSource?.checkpoint === undefined ? {} : { eventSource: eventSource.checkpoint }),
      ...(command.definition.trigger.kind === "file-arrival" && source !== undefined
        ? { fileSource: source.checkpoint }
        : {}),
    });
    return { kind: "automation-created", automation: definition };
  }

  #update(
    command: Extract<AutomationCommand, { readonly kind: "update-automation" }>,
    source: AutomationFileSourcePreparation | undefined,
    eventSource: AutomationEventSourcePreparation | undefined,
  ): AutomationCommandResult {
    const existing = this.#projection.getDefinition(command.automationId);
    const gate = this.#gateDefinitionMutation(existing, command);
    if (gate !== undefined) return gate;
    const current = existing as AutomationDefinition;
    if (command.rearmEvents === true && this.#projection.activeRun(current.id) !== undefined)
      return failure(
        "active-occurrence",
        "Finish or cancel the current run before reviewing and re-arming its event source.",
        { automationId: current.id },
      );
    if (
      command.definition.trigger.kind === "file-arrival" &&
      !this.#sourcePrepared(command, source)
    )
      return failure(
        "blocked",
        "Choose an available local Work input folder before saving this file routine.",
      );
    if (String(command.definition.hostId) !== this.#hostId) {
      return failure("unauthorized", "Automation definitions cannot move between hosts.", {
        automationId: command.automationId,
      });
    }
    // Only the host makes a follow-up, from a thread it vouches for; an edit
    // can neither turn a routine into one nor turn one back.
    if (command.definition.targetPolicy !== current.targetPolicy) {
      return failure("invalid", "A routine's target cannot change after it is created.", {
        automationId: command.automationId,
      });
    }
    const now = this.#now();
    const lifecycle = current.lifecycle === "paused" ? "paused" : "enabled";
    const updated = validateAutomationDefinition(
      decodeAutomationDefinition({
        id: current.id,
        ...command.definition,
        lifecycle,
        definitionRevision: current.definitionRevision + 1,
        ...(lifecycle === "enabled"
          ? this.#dueState(command.definition.trigger)
          : { nextDueAt: null }),
        createdBy: current.createdBy,
        updatedBy: command.principal,
        ...(current.originThreadId === undefined ? {} : { originThreadId: current.originThreadId }),
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: now,
      }),
    );
    const previousSource = this.#projection.getFileSource(current.id);
    let configuredSource = source?.checkpoint;
    if (previousSource !== undefined && source !== undefined) {
      const { reason: _sourceReason, held: _sourceHeld, ...unarmed } = previousSource;
      configuredSource = previousSource.baselineReady
        ? {
            ...previousSource,
            sourceIdentity: source.checkpoint.sourceIdentity,
            observationRevision: previousSource.observationRevision + 1,
            phase: "needs-rearm",
            reason:
              previousSource.reason === "activity-history-limit"
                ? "activity-history-limit"
                : "definition-changed",
            observedAt: now,
          }
        : {
            ...unarmed,
            sourceIdentity: source.checkpoint.sourceIdentity,
            observationRevision: previousSource.observationRevision + 1,
            phase: "arming",
            observedAt: now,
          };
    }
    this.#store.appendDefinitionUpdated({
      ...personActor(command.principal),
      automation: updated,
      ...(eventSource?.checkpoint === undefined ? {} : { eventSource: eventSource.checkpoint }),
      ...(command.definition.trigger.kind === "file-arrival" && configuredSource !== undefined
        ? { fileSource: configuredSource }
        : {}),
      previousDefinitionRevision: current.definitionRevision,
      expectedVersion: current.version,
    });
    return { kind: "automation-updated", automation: updated };
  }

  #changeLifecycle(
    command: Extract<
      AutomationCommand,
      { readonly kind: "pause-automation" | "resume-automation" | "archive-automation" }
    >,
    lifecycle: "paused" | "enabled" | "archived",
    resultKind: "automation-paused" | "automation-resumed" | "automation-archived",
  ): AutomationCommandResult {
    const existing = this.#projection.getDefinition(command.automationId);
    const allowArchived = lifecycle === "archived";
    const gate = this.#gateDefinitionMutation(existing, command, allowArchived);
    if (gate !== undefined) return gate;
    const current = existing as AutomationDefinition;
    const source = this.#projection.getFileSource(current.id);
    if (
      lifecycle === "enabled" &&
      current.trigger.kind === "file-arrival" &&
      (source === undefined ||
        source.phase === "held" ||
        source.phase === "needs-rearm" ||
        source.automaticStarts >= current.trigger.automaticStartLimit)
    )
      return failure(
        "blocked",
        "Review this file routine and explicitly re-arm its input before resuming.",
      );
    if (current.lifecycle === lifecycle) {
      return { kind: resultKind, automation: current };
    }
    const { nextDueResolution: _resolution, blockedReason: _blocked, ...base } = current;
    const changed = validateAutomationDefinition(
      decodeAutomationDefinition({
        ...base,
        lifecycle,
        ...(lifecycle === "enabled" ? this.#dueState(current.trigger) : { nextDueAt: null }),
        updatedBy: command.principal,
        version: current.version + 1,
        updatedAt: this.#now(),
      }),
    );
    this.#store.appendDefinitionLifecycleChanged({
      ...personActor(command.principal),
      automation: changed,
      previousLifecycle: current.lifecycle,
      expectedVersion: current.version,
    });
    return { kind: resultKind, automation: changed };
  }

  #runNow(
    command: Extract<AutomationCommand, { readonly kind: "run-now-automation" }>,
  ): AutomationCommandResult {
    const definition = this.#projection.getDefinition(command.automationId);
    const gate = this.#gateDefinitionMutation(definition, command);
    if (gate !== undefined) return gate;
    const current = definition as AutomationDefinition;
    // A follow-up's one turn is its scheduled one; running it now would send
    // a second turn into the person's thread.
    if (current.targetPolicy === "same-thread") {
      return failure("unsupported", "A follow-up runs only at its time.", {
        automationId: current.id,
      });
    }

    const retry =
      command.retryRunId === undefined ? undefined : this.#projection.getRun(command.retryRunId);
    if (
      command.retryRunId !== undefined &&
      (retry === undefined ||
        String(retry.automationId) !== String(current.id) ||
        !["failed", "interrupted", "cancelled"].includes(retry.lifecycle) ||
        retry.definitionSnapshot.definitionRevision !== current.definitionRevision)
    )
      return failure(
        "blocked",
        "Retry requires a stopped run of this unchanged routine. Review its history or use Run now.",
        { automationId: current.id },
      );

    const occurrence = {
      kind: "manual",
      automationId: current.id,
      definitionRevision: current.definitionRevision,
      runNowRequestId: command.runNowRequestId,
      ...(retry === undefined
        ? {}
        : {
            retryOfRunId: retry.id,
            ...(retry.occurrence.kind === "file-arrival"
              ? { fileSource: retry.occurrence.source }
              : retry.occurrence.kind === "manual" && retry.occurrence.fileSource !== undefined
                ? { fileSource: retry.occurrence.fileSource }
                : {}),
            ...(retry.occurrence.kind === "integration-event"
              ? { eventSource: retry.occurrence.source }
              : retry.occurrence.kind === "manual" && retry.occurrence.eventSource !== undefined
                ? { eventSource: retry.occurrence.eventSource }
                : {}),
          }),
    } as const;
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence as never);
    const runId = automationRunIdForOccurrence(occurrenceKey);

    // Idempotency receipt: the run id is derived from the occurrence key, so
    // the same request id always names the same run.
    const existingRun = this.#projection.getRun(runId);
    if (existingRun !== undefined) {
      if (
        existingRun.occurrence.kind !== "manual" ||
        String(existingRun.occurrence.retryOfRunId ?? "") !== String(retry?.id ?? "")
      )
        return failure("invalid", "This request already names a different run input.", {
          automationId: current.id,
        });
      return { kind: "automation-run-accepted", run: existingRun };
    }
    const active = this.#projection.activeRun(current.id);
    if (active !== undefined) {
      return {
        kind: "automation-run-active-conflict",
        automationId: current.id,
        runId: active.id,
        lifecycle: active.lifecycle,
      };
    }

    const run = buildAutomationRunForOccurrence({
      definition: current,
      occurrence: occurrence as never,
      now: this.#now(),
    });
    try {
      this.#store.appendRunCreated({ ...personActor(command.principal), run });
    } catch (error) {
      // A crash between append and reply can race the retry; the journal is
      // authoritative, so a conflict resolves to the committed receipt.
      if (error instanceof AutomationEventStoreError && error.category === "conflict") {
        const committed = this.#projection.getRun(runId);
        if (committed !== undefined) {
          return { kind: "automation-run-accepted", run: committed };
        }
      }
      throw error;
    }
    return { kind: "automation-run-accepted", run };
  }

  #cancelCurrentRun(
    command: Extract<AutomationCommand, { readonly kind: "cancel-current-automation-run" }>,
  ): AutomationCommandResult {
    const run = this.#projection.getRun(command.runId);
    if (run === undefined || String(run.automationId) !== String(command.automationId)) {
      return failure("not-found", "Automation run does not exist for this Automation.", {
        automationId: command.automationId,
        runId: command.runId,
      });
    }
    // Idempotency receipt: the tombstone names the request that cancelled it.
    if (run.cancellationTombstone?.requestId === command.cancelRunRequestId) {
      return { kind: "automation-run-cancelled", run };
    }
    const definition = this.#projection.getDefinition(command.automationId);
    const gate = this.#gateDefinitionMutation(definition, command, true);
    if (gate !== undefined) return gate;
    if (command.expectedRunVersion !== run.version) {
      return failure("stale-version", "Automation run expected version is stale.", {
        automationId: command.automationId,
        runId: run.id,
      });
    }
    if (!isAutomationRunLifecycleActive(run.lifecycle)) {
      return failure("terminal", "Automation run is already terminal.", {
        automationId: command.automationId,
        runId: run.id,
      });
    }
    if (run.firstTurnAcceptance !== undefined) {
      return failure(
        "unsupported",
        "Accepted first turns cancel through the thread interrupt path.",
        { automationId: command.automationId, runId: run.id },
      );
    }
    const now = this.#now();
    this.#store.appendRunCancellation({
      ...personActor(command.principal),
      automationId: command.automationId,
      runId: run.id,
      previousLifecycle: run.lifecycle,
      tombstone: { requestId: command.cancelRunRequestId, cancelledAt: now },
      expectedVersion: run.version,
      updatedAt: now,
    });
    const cancelled = this.#projection.getRun(run.id);
    if (cancelled === undefined) {
      return failure("invalid", "Cancelled Automation run is missing from the projection.", {
        automationId: command.automationId,
        runId: run.id,
      });
    }
    return { kind: "automation-run-cancelled", run: cancelled };
  }

  /** Shared existence/host/terminal/version gates for definition mutations. */
  #gateDefinitionMutation(
    definition: AutomationDefinition | undefined,
    command: AutomationCommand,
    allowArchived = false,
  ): AutomationCommandFailure | undefined {
    if (definition === undefined) {
      return failure("not-found", "Automation definition does not exist.", {
        automationId: command.automationId,
      });
    }
    if (String(definition.hostId) !== this.#hostId) {
      return failure("unauthorized", "Automation definitions are owned by exactly one host.", {
        automationId: command.automationId,
      });
    }
    if (!allowArchived && definition.lifecycle === "archived") {
      return failure("terminal", "Archived Automations preserve history and reject mutation.", {
        automationId: command.automationId,
      });
    }
    if (command.expectedVersion !== definition.version) {
      return failure("stale-version", "Automation definition expected version is stale.", {
        automationId: command.automationId,
      });
    }
    return undefined;
  }

  #sourcePrepared(
    command: Extract<
      AutomationCommand,
      { readonly kind: "create-automation" | "update-automation" }
    >,
    source: AutomationFileSourcePreparation | undefined,
  ): boolean {
    return (
      command.principal.kind === "local-window" &&
      source !== undefined &&
      source.automationId === command.automationId &&
      source.expectedVersion === command.expectedVersion &&
      JSON.stringify(source.definition) === JSON.stringify(command.definition) &&
      source.current()
    );
  }

  #dueState(trigger: AutomationTrigger): DueState {
    if (trigger.kind === "file-arrival" || trigger.kind === "integration-event")
      return { nextDueAt: null };
    if (trigger.kind === "once") return { nextDueAt: trigger.scheduledAt };
    const now = this.#now();
    const nextDueAt = resolveNextAutomationOccurrence({ trigger, after: now, inclusive: true });
    if (nextDueAt === undefined) {
      throw new AutomationPolicyRejected(
        "invalid-trigger",
        "Automation trigger has no resolvable next occurrence.",
      );
    }
    if (trigger.kind === "interval") return { nextDueAt };
    return {
      nextDueAt,
      nextDueResolution: buildAutomationWeeklyResolution({ trigger, scheduledAt: nextDueAt }),
    };
  }

  #now(): UtcTimestamp {
    return this.#clock() as UtcTimestamp;
  }
}

function failure(
  reason: AutomationCommandFailure["reason"],
  message: string,
  ids: { readonly automationId?: AutomationId; readonly runId?: AutomationRunId } = {},
): AutomationCommandFailure {
  return {
    kind: "automation-command-failed",
    reason,
    message,
    ...(ids.automationId === undefined ? {} : { automationId: ids.automationId }),
    ...(ids.runId === undefined ? {} : { runId: ids.runId }),
  } as AutomationCommandFailure;
}

function mapCommandError(error: unknown, automationId: AutomationId): AutomationCommandResult {
  if (error instanceof AutomationPolicyRejected) {
    return failure(
      error.code === "unsupported-mode"
        ? "unsupported"
        : error.code === "automation-recursion"
          ? "unauthorized"
          : "invalid",
      error.message,
      { automationId },
    );
  }
  if (error instanceof AutomationEventStoreError) {
    if (error.category === "conflict") {
      return failure("stale-version", error.message, { automationId });
    }
    return failure("invalid", error.message, { automationId });
  }
  // Strict schema decoding failures surface as invalid commands rather than
  // crashing the route; anything else is a real defect and propagates.
  if (isSchemaParseError(error)) {
    return failure("invalid", "Automation command produced an invalid aggregate.", {
      automationId,
    });
  }
  throw error;
}

function isSchemaParseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "ParseError"
  );
}

/**
 * Who a person's command is journaled as. A command carries the principal the
 * route authenticated, never one the request supplied, so a paired device's
 * routine names the device. A local window leaves the store's own actor.
 */
function personActor(principal: AutomationClientPrincipal): { readonly actor?: EventActor } {
  return principal.kind === "remote-device" ? { actor: eventActorForPrincipal(principal) } : {};
}
