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
  type AutomationTrigger,
  type AutomationWeeklyResolution,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  AutomationPolicyRejected,
  buildAutomationWeeklyResolution,
  isAutomationMutationAllowed,
  isAutomationRunLifecycleActive,
  resolveNextAutomationOccurrence,
  validateAutomationDefinition,
} from "@octant/domain";
import { AutomationEventStore, AutomationEventStoreError } from "./automationEventStore";
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
  >;
  readonly projection: AutomationProjection;
  /** The identifier of the host that owns every definition this server holds. */
  readonly hostId: string;
  readonly clock: () => string;
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

  execute(input: AutomationCommand): AutomationCommandResult {
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

    try {
      switch (command.kind) {
        case "create-automation":
          return this.#create(command);
        case "update-automation":
          return this.#update(command);
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

  #create(
    command: Extract<AutomationCommand, { readonly kind: "create-automation" }>,
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
    const now = this.#now();
    const definition = validateAutomationDefinition(
      decodeAutomationDefinition({
        id: command.automationId,
        ...command.definition,
        lifecycle: "enabled",
        definitionRevision: 1,
        ...this.#dueState(command.definition.trigger),
        createdBy: command.principal,
        updatedBy: command.principal,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    this.#store.appendDefinitionCreated({ automation: definition });
    return { kind: "automation-created", automation: definition };
  }

  #update(
    command: Extract<AutomationCommand, { readonly kind: "update-automation" }>,
  ): AutomationCommandResult {
    const existing = this.#projection.getDefinition(command.automationId);
    const gate = this.#gateDefinitionMutation(existing, command);
    if (gate !== undefined) return gate;
    const current = existing as AutomationDefinition;
    if (String(command.definition.hostId) !== this.#hostId) {
      return failure("unauthorized", "Automation definitions cannot move between hosts.", {
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
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: now,
      }),
    );
    this.#store.appendDefinitionUpdated({
      automation: updated,
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

    const occurrence = {
      kind: "manual",
      automationId: current.id,
      definitionRevision: current.definitionRevision,
      runNowRequestId: command.runNowRequestId,
    } as const;
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence as never);
    const runId = automationRunIdForOccurrence(occurrenceKey);

    // Idempotency receipt: the run id is derived from the occurrence key, so
    // the same request id always names the same run.
    const existingRun = this.#projection.getRun(runId);
    if (existingRun !== undefined) {
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
      this.#store.appendRunCreated({ run });
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

  #dueState(trigger: AutomationTrigger): DueState {
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
