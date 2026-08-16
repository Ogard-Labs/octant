import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CausationId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeProjectId,
  decodeCreateRootlessThreadCommand,
  decodeRootlessThreadCreateResult,
  decodeRootlessThreadId,
  decodeRootlessTurnLookupResult,
  decodeRootlessTurnRequestId,
  decodeStartRootlessThreadTurnCommand,
  decodeCancelRootlessTurnCommand,
  decodeProviderSessionId,
  decodeFolderAttachmentId,
  FolderAttachmentId,
  type CompatibleProjectEntry,
  type CompatibleProjectLookupRequest,
  type FolderAttachmentResult,
  type HostId,
  type Project,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderSessionId,
  type RootlessThreadId,
  type RootlessThreadCreateResult,
  type RootlessThreadListResult,
  type RootlessTurnCancelResult,
  type RootlessTurnFailure,
  type RootlessTurnLookupResult,
  type RootlessTurnConflictReason,
  type RootlessTurnLifecycleStatus,
  type StartRootlessThreadTurnCommand,
  type WindowId,
  ROOTLESS_ATTACH_FOLDER_REASON,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Schema } from "effect";
import { validateFolderAttachmentAuthority, type FolderDenialReason } from "@octant/domain";
import { BindingReceiptError, type BindingReceiptStorePort } from "./bindingReceiptStore";
import { createDiagnosticsFailureIncidentEvent } from "./diagnosticsExportService";
import { ConcurrencyConflict } from "./persistence/journalErrors";
import type { Journal } from "./persistence/journal";
import type { PersistenceService } from "./persistence/persistenceService";
import { ProjectionApplicationFailed } from "./persistence/projection";
import {
  readRootlessThread,
  readRootlessThreadList,
  readRootlessThreads,
  readRootlessTurnByRequest,
} from "./persistence/rootlessProjection";
import type { ProjectedRootlessThread } from "./persistence/rootlessPersistenceSchema";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";
import type { RootlessTurnRuntimePort } from "./rootlessTurnRuntime";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeCausationId = Schema.decodeUnknownSync(CausationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const ROOTLESS_TURN_UPDATE_MAX_ATTEMPTS = 3;

export interface RootlessThreadServiceOptions {
  readonly persistence: PersistenceService;
  readonly journal: Journal;
  readonly bindingReceiptStore: Pick<BindingReceiptStorePort, "consume">;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now?: () => number;
  readonly hostConnected: (hostId: HostId) => boolean;
  readonly hasActiveTurn: (threadId: RootlessThreadId) => boolean;
  readonly resolveProviderDriver?: (
    providerInstanceId: ProviderInstanceId,
  ) => ProviderDriver | undefined;
  readonly turnRuntime?: RootlessTurnRuntimePort;
}

export class RootlessThreadServiceError extends Error {
  override readonly name = "RootlessThreadServiceError";
  readonly category: "invalid" | "unauthorized" | "unavailable" | "not-found" | "conflict";
  readonly conflictReason?: FolderDenialReason | RootlessTurnConflictReason;

  constructor(
    category: RootlessThreadServiceError["category"],
    message: string,
    conflictReason?: RootlessThreadServiceError["conflictReason"],
  ) {
    super(message);
    this.category = category;
    if (conflictReason !== undefined) this.conflictReason = conflictReason;
  }
}

export interface RootlessThreadServiceApi {
  createThread(
    authenticatedWindowId: WindowId,
    command: unknown,
  ): Promise<RootlessThreadCreateResult>;
  startFirstTurn(
    authenticatedWindowId: WindowId,
    command: unknown,
  ): Promise<RootlessTurnLookupResult>;
  lookupFirstTurn(requestId: unknown): RootlessTurnLookupResult;
  cancelFirstTurn(command: unknown): Promise<RootlessTurnCancelResult>;
  listThreads(): RootlessThreadListResult;
  lookupCompatibleProjects(
    request: CompatibleProjectLookupRequest,
  ): Promise<ReadonlyArray<CompatibleProjectEntry>>;
  attachFolder(authenticatedWindowId: WindowId, command: unknown): Promise<FolderAttachmentResult>;
}

export class RootlessThreadService implements RootlessThreadServiceApi {
  readonly #persistence: PersistenceService;
  readonly #journal: Journal;
  readonly #receipts: Pick<BindingReceiptStorePort, "consume">;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #hostConnected: (hostId: HostId) => boolean;
  readonly #hasActiveTurn: (threadId: RootlessThreadId) => boolean;
  readonly #resolveProviderDriver: (
    providerInstanceId: ProviderInstanceId,
  ) => ProviderDriver | undefined;
  readonly #turnRuntime: RootlessTurnRuntimePort | undefined;
  readonly #activeTurns = new Map<
    string,
    { readonly controller: AbortController; readonly completion: Promise<void> }
  >();

  constructor(options: RootlessThreadServiceOptions) {
    this.#persistence = options.persistence;
    this.#journal = options.journal;
    this.#receipts = options.bindingReceiptStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#now = options.now ?? Date.now;
    this.#hostConnected = options.hostConnected;
    this.#hasActiveTurn = options.hasActiveTurn;
    this.#resolveProviderDriver = options.resolveProviderDriver ?? (() => undefined);
    this.#turnRuntime = options.turnRuntime;
    this.#reconcileInterruptedTurns();
  }

  listThreads(): RootlessThreadListResult {
    return readRootlessThreadList(this.#persistence.connection);
  }

  async createThread(
    _authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<RootlessThreadCreateResult> {
    const command = decodeCreateRootlessThreadCommand(input);
    if (command.context.hostId !== "local") {
      throw new RootlessThreadServiceError(
        "unauthorized",
        "Rootless thread host is not authorized.",
      );
    }
    if (readRootlessThread(this.#persistence.connection, command.threadId) !== undefined) {
      throw new RootlessThreadServiceError(
        "conflict",
        "Rootless thread already exists.",
        "thread-exists",
      );
    }
    const provider = this.#persistence.readProviderInstance(command.context.providerInstanceId);
    if (provider === undefined || !provider.enabled) {
      throw new RootlessThreadServiceError("unavailable", "Selected provider is unavailable.");
    }
    const createdAt = this.#clock();
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: "rootless-thread",
          aggregateId: decodeAggregateId(command.threadId),
        },
        expectedVersion: 0,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: "rootless.thread-created@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: createdAt,
            payload: {
              kind: "thread-created",
              threadId: command.threadId,
              title: command.title,
              mode: command.context.mode,
              hostId: command.context.hostId,
              providerInstanceId: command.context.providerInstanceId,
              modelId: command.context.modelId,
              workspace: command.context.workspace,
              createdAt,
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new RootlessThreadServiceError(
          "conflict",
          "Rootless thread already exists.",
          "thread-exists",
        );
      }
      throw error;
    }
    return decodeRootlessThreadCreateResult({
      kind: "thread-created",
      threadId: command.threadId,
      mode: command.context.mode,
      title: command.title,
      workspace: command.context.workspace,
      createdAt: decodeUtcTimestamp(createdAt),
    });
  }

  async startFirstTurn(
    _authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<RootlessTurnLookupResult> {
    const command = decodeStartRootlessThreadTurnCommand(input);
    if (command.context.hostId !== "local") {
      throw new RootlessThreadServiceError(
        "unauthorized",
        "Rootless thread host is not authorized.",
      );
    }

    const existingRequest = readRootlessTurnByRequest(
      this.#persistence.connection,
      command.requestId,
    );
    if (existingRequest?.initialTurn !== undefined)
      return this.#lookupForMatchingRequest(command, existingRequest);
    if (readRootlessThread(this.#persistence.connection, command.threadId) !== undefined) {
      throw new RootlessThreadServiceError(
        "conflict",
        "Rootless thread already exists.",
        "thread-exists",
      );
    }

    const provider = this.#persistence.readProviderInstance(command.context.providerInstanceId);
    if (provider === undefined || !provider.enabled) {
      throw new RootlessThreadServiceError("unavailable", "Selected provider is unavailable.");
    }
    const catalog = this.#persistence.readProviderCatalog?.(command.context.providerInstanceId);
    if (
      catalog !== undefined &&
      !catalog.invalidated &&
      !catalog.models.some((model) => String(model.id) === String(command.context.modelId))
    ) {
      throw new RootlessThreadServiceError(
        "unavailable",
        "Selected model is not available in the current provider catalog. Check the connection or select another model.",
      );
    }
    const driver = this.#resolveProviderDriver(command.context.providerInstanceId);
    if (driver === undefined || this.#turnRuntime === undefined) {
      throw new RootlessThreadServiceError(
        "unavailable",
        "Selected provider cannot start a rootless turn.",
      );
    }

    const acceptedAt = this.#clock();
    const createdEventId = decodeEventId(this.#uuid());
    const acceptedEventId = decodeEventId(this.#uuid());
    const providerSessionId = decodeProviderSessionId(this.#uuid());
    const correlationId = decodeCorrelationId(command.requestId);
    const capabilities = {
      workspace: "rootless" as const,
      rootBackedTools: {
        availability: "unavailable" as const,
        reason: ROOTLESS_ATTACH_FOLDER_REASON,
      },
    };
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: "rootless-thread",
          aggregateId: decodeAggregateId(command.threadId),
        },
        expectedVersion: 0,
        events: [
          {
            eventId: createdEventId,
            eventName: "rootless.thread-created@1",
            eventVersion: 1,
            correlationId,
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: acceptedAt,
            payload: {
              kind: "thread-created",
              threadId: command.threadId,
              title: command.title,
              mode: command.context.mode,
              hostId: command.context.hostId,
              providerInstanceId: command.context.providerInstanceId,
              modelId: command.context.modelId,
              workspace: command.context.workspace,
              createdAt: acceptedAt,
            },
          },
          {
            eventId: acceptedEventId,
            eventName: "rootless.turn-accepted@1",
            eventVersion: 1,
            correlationId,
            causationId: decodeCausationId(createdEventId),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: acceptedAt,
            payload: {
              kind: "turn-accepted",
              requestId: command.requestId,
              threadId: command.threadId,
              turnId: command.turnId,
              providerSessionId,
              prompt: command.prompt,
              capabilities,
              acceptedAt,
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict || error instanceof ProjectionApplicationFailed) {
        const duplicate = readRootlessTurnByRequest(
          this.#persistence.connection,
          command.requestId,
        );
        if (duplicate?.initialTurn !== undefined)
          return this.#lookupForMatchingRequest(command, duplicate);
        if (error instanceof ProjectionApplicationFailed) throw error;
        throw new RootlessThreadServiceError(
          "conflict",
          "Rootless thread already exists.",
          "thread-exists",
        );
      }
      throw error;
    }

    const accepted = readRootlessThread(this.#persistence.connection, command.threadId);
    if (accepted === undefined || accepted.initialTurn === undefined) {
      throw new RootlessThreadServiceError(
        "unavailable",
        "Rootless turn acceptance could not be confirmed.",
      );
    }
    this.#launchTurn(command, providerSessionId, driver);
    return this.#lookupFor(accepted);
  }

  #lookupForMatchingRequest(
    command: StartRootlessThreadTurnCommand,
    projected: ProjectedRootlessThread,
  ): RootlessTurnLookupResult {
    const existing = projected.initialTurn;
    if (
      existing === undefined ||
      existing.threadId !== command.threadId ||
      existing.turnId !== command.turnId ||
      existing.prompt !== command.prompt ||
      projected.title !== command.title ||
      projected.mode !== command.context.mode ||
      projected.hostId !== command.context.hostId ||
      projected.providerInstanceId !== command.context.providerInstanceId ||
      projected.modelId !== command.context.modelId ||
      projected.workspaceKind !== "rootless"
    ) {
      throw new RootlessThreadServiceError(
        "conflict",
        "Rootless turn request identity was already used.",
        "request-reused",
      );
    }
    return this.#lookupFor(projected);
  }

  lookupFirstTurn(input: unknown): RootlessTurnLookupResult {
    const requestId = decodeRootlessTurnRequestId(input);
    const projected = readRootlessTurnByRequest(this.#persistence.connection, requestId);
    if (projected === undefined) {
      return decodeRootlessTurnLookupResult({
        kind: "not-created",
        requestId,
        message: "No rootless turn was accepted for this request.",
      });
    }
    return this.#lookupFor(projected);
  }

  async cancelFirstTurn(input: unknown): Promise<RootlessTurnCancelResult> {
    const command = decodeCancelRootlessTurnCommand(input);
    const projected = readRootlessTurnByRequest(this.#persistence.connection, command.requestId);
    const turn = projected?.initialTurn;
    if (
      projected === undefined ||
      turn === undefined ||
      projected.threadId !== command.threadId ||
      turn.turnId !== command.turnId
    ) {
      throw new RootlessThreadServiceError("not-found", "Rootless turn was not found.");
    }
    const active = this.#activeTurns.get(command.requestId);
    if (active === undefined) {
      return {
        kind: "turn-already-terminal",
        requestId: command.requestId,
        threadId: command.threadId,
        turnId: command.turnId,
        status: turn.status,
      } as RootlessTurnCancelResult;
    }
    active.controller.abort();
    await active.completion;
    const refreshed = readRootlessTurnByRequest(this.#persistence.connection, command.requestId);
    return {
      kind: "turn-cancelled",
      requestId: command.requestId,
      threadId: command.threadId,
      turnId: command.turnId,
      status: refreshed?.initialTurn?.status ?? "cancelled",
    } as RootlessTurnCancelResult;
  }

  async lookupCompatibleProjects(
    request: CompatibleProjectLookupRequest,
  ): Promise<ReadonlyArray<CompatibleProjectEntry>> {
    const projects = this.#persistence.readProjects({ type: request.mode });
    return projects
      .filter((project) => project.lifecycle === "active" && project.type === request.mode)
      .filter(
        (project): project is Extract<Project, { type: "work" | "code" }> =>
          project.type === "work" || project.type === "code",
      )
      .map((project) => ({
        projectId: project.id,
        displayName: project.name,
        rootPath: project.binding.canonicalRoot,
      }));
  }

  async attachFolder(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<FolderAttachmentResult> {
    const command = decodeAttachFolderCommandInput(input);
    const threadId = decodeRootlessThreadId(command.threadId);
    const projectId = decodeProjectId(command.projectId);
    const attachmentId = decodeFolderAttachmentId(command.attachmentId);

    const projected = readRootlessThread(this.#persistence.connection, threadId);
    if (projected === undefined) {
      throw new RootlessThreadServiceError("not-found", "Rootless thread was not found.");
    }

    const project = this.#persistence.readProject(projectId);
    if (project === undefined) {
      throw new RootlessThreadServiceError("not-found", "Project was not found.");
    }
    if (project.type !== projected.mode) {
      throw new RootlessThreadServiceError(
        "conflict",
        "Project mode does not match.",
        "wrong-mode",
      );
    }
    if (project.lifecycle === "archived") {
      throw new RootlessThreadServiceError("conflict", "Project is archived.", "archived");
    }

    const boundProject = project as Extract<Project, { type: "work" | "code" }>;

    let canonicalRoot: string | undefined;
    try {
      const binding = this.#receipts.consume({
        receiptId: command.receiptId,
        authenticatedWindowId,
        projectType: boundProject.type,
        now: this.#now(),
      });
      canonicalRoot = binding.canonicalRoot;
    } catch (error) {
      if (error instanceof BindingReceiptError) {
        throw new RootlessThreadServiceError(
          error.category === "unavailable" ? "unavailable" : "unauthorized",
          "Project binding receipt is invalid or expired.",
        );
      }
      throw error;
    }

    const bindingFresh = boundProject.binding.canonicalRoot === canonicalRoot;

    const decision = validateFolderAttachmentAuthority({
      workspace:
        projected.workspaceKind === "rootless"
          ? { kind: "rootless" }
          : { kind: "project-backed", projectId: projectId },
      threadMode: projected.mode,
      projectMode: project.type,
      hasActiveTurn: this.#isActiveTurn(threadId),
      hostConnected: this.#hostConnected(projected.hostId),
      hostAuthorized: true,
      projectLifecycle: project.lifecycle,
      rootValid: true,
      bindingFresh,
      authorityGranted: true,
      requestCancelled: false,
    });

    if (decision.kind === "denied") {
      const now = this.#clock();
      this.#journalDenied(threadId, attachmentId, projectId, decision.reason, now);
      throw new RootlessThreadServiceError(
        "conflict",
        denialMessage(decision.reason),
        decision.reason,
      );
    }

    const attachedAt = this.#clock();
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: "rootless-thread",
          aggregateId: decodeAggregateId(threadId),
        },
        expectedVersion: decodeAggregateVersion(projected.aggregateVersion),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: "rootless.folder-attached@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: attachedAt,
            payload: {
              kind: "folder-attached",
              attachmentId,
              threadId,
              projectId,
              attachedAt,
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new RootlessThreadServiceError(
          "conflict",
          "Rootless thread changed concurrently.",
          "stale-binding",
        );
      }
      throw error;
    }

    return {
      kind: "attached",
      attachmentId,
      threadId,
      projectId,
      attachedAt: decodeUtcTimestamp(attachedAt),
    };
  }

  #launchTurn(
    command: StartRootlessThreadTurnCommand,
    providerSessionId: ProviderSessionId,
    driver: ProviderDriver,
  ): void {
    const controller = new AbortController();
    const completion = this.#executeTurn(command, providerSessionId, driver, controller.signal);
    this.#activeTurns.set(command.requestId, { controller, completion });
    void completion.then(
      () => {
        if (this.#activeTurns.get(command.requestId)?.completion === completion) {
          this.#activeTurns.delete(command.requestId);
        }
      },
      () => {
        // Retain the failed completion so cancellation/coordination observes the
        // unpersisted transition instead of silently deleting active bookkeeping.
      },
    );
  }

  async #executeTurn(
    command: StartRootlessThreadTurnCommand,
    providerSessionId: ProviderSessionId,
    driver: ProviderDriver,
    signal: AbortSignal,
  ): Promise<void> {
    this.#journalTurnUpdate(command, "running");
    const outcome = await this.#turnRuntime!.run({ command, providerSessionId, driver, signal });
    switch (outcome.kind) {
      case "completed":
        this.#journalTurnUpdate(command, "completed", { response: outcome.response });
        return;
      case "cancelled":
        this.#journalTurnUpdate(command, "cancelled");
        return;
      case "waiting":
        this.#journalTurnUpdate(command, "waiting", { failure: outcome.failure });
        return;
      case "failed":
        this.#journalTurnUpdate(command, "failed", { failure: outcome.failure });
        return;
    }
  }

  #journalTurnUpdate(
    command: Pick<StartRootlessThreadTurnCommand, "requestId" | "threadId" | "turnId">,
    status: "running" | "completed" | "cancelled" | "failed" | "waiting",
    detail: { readonly response?: string; readonly failure?: RootlessTurnFailure } = {},
  ): void {
    for (let attempt = 0; attempt < ROOTLESS_TURN_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const projected = readRootlessThread(this.#persistence.connection, command.threadId);
      const turn = projected?.initialTurn;
      if (projected === undefined || turn === undefined) {
        throw new RootlessThreadServiceError(
          "unavailable",
          "Rootless turn transition could not be persisted.",
        );
      }
      if (isTerminalRootlessTurnStatus(turn.status)) return;
      const updatedAt = this.#clock();
      try {
        const supportIncident =
          status === "failed" && detail.failure?.code !== undefined
            ? createDiagnosticsFailureIncidentEvent(
                {
                  correlationId: decodeCorrelationId(command.requestId),
                  domain: "provider",
                  failureCode: detail.failure.code,
                  observedAt: updatedAt,
                },
                { eventIdGenerator: this.#uuid },
              )
            : undefined;
        this.#journal.append({
          aggregate: {
            aggregateType: "rootless-thread",
            aggregateId: decodeAggregateId(command.threadId),
          },
          expectedVersion: decodeAggregateVersion(projected.aggregateVersion),
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: "rootless.turn-updated@1",
              eventVersion: 1,
              correlationId: decodeCorrelationId(command.requestId),
              ...(projected.initialTurnAcceptedEventId === undefined
                ? {}
                : { causationId: decodeCausationId(projected.initialTurnAcceptedEventId) }),
              actor: { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
              occurredAt: updatedAt,
              payload: {
                kind: "turn-updated",
                requestId: command.requestId,
                threadId: command.threadId,
                turnId: command.turnId,
                status,
                ...(detail.response === undefined ? {} : { response: detail.response }),
                ...(detail.failure === undefined ? {} : { failure: detail.failure }),
                updatedAt,
              },
            },
            ...(supportIncident === undefined ? [] : [supportIncident]),
          ],
        });
        return;
      } catch (error) {
        if (
          !(error instanceof ConcurrencyConflict) ||
          attempt === ROOTLESS_TURN_UPDATE_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
  }

  #lookupFor(projected: ProjectedRootlessThread): RootlessTurnLookupResult {
    const turn = projected.initialTurn;
    if (turn === undefined) {
      throw new RootlessThreadServiceError("not-found", "Rootless turn was not found.");
    }
    if (turn.status === "waiting") {
      return decodeRootlessTurnLookupResult({
        kind: "ambiguous",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        prompt: turn.prompt,
        capabilities: turn.capabilities,
        message: "The provider turn was accepted but its terminal outcome is unknown.",
        acceptedAt: turn.acceptedAt,
        updatedAt: turn.updatedAt,
      });
    }
    return decodeRootlessTurnLookupResult({ kind: "accepted", turn });
  }

  #isActiveTurn(threadId: RootlessThreadId): boolean {
    if (this.#hasActiveTurn(threadId)) return true;
    const status = readRootlessThread(this.#persistence.connection, threadId)?.initialTurn?.status;
    return status === "accepted" || status === "running";
  }

  #reconcileInterruptedTurns(): void {
    for (const thread of readRootlessThreads(this.#persistence.connection)) {
      const turn = thread.initialTurn;
      if (turn === undefined || (turn.status !== "accepted" && turn.status !== "running")) continue;
      this.#journalTurnUpdate(turn, "waiting", {
        failure: {
          category: "interrupted",
          message: "Provider turn outcome is ambiguous after server restart.",
        },
      });
    }
  }

  #journalDenied(
    threadId: RootlessThreadId,
    attachmentId: typeof FolderAttachmentId.Type,
    projectId: ProjectId,
    reason: FolderDenialReason,
    deniedAt: string,
  ): void {
    const projected = readRootlessThread(this.#persistence.connection, threadId);
    const expectedVersion = projected?.aggregateVersion ?? 0;
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: "rootless-thread",
          aggregateId: decodeAggregateId(threadId),
        },
        expectedVersion: decodeAggregateVersion(expectedVersion),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: "rootless.folder-attachment-denied@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: deniedAt,
            payload: {
              kind: "folder-attachment-denied",
              attachmentId,
              threadId,
              reason,
              message: denialMessage(reason),
              deniedAt,
            },
          },
        ],
      });
    } catch {
      // Auditing a denial is best-effort; the denial result is authoritative.
    }
  }
}

function isTerminalRootlessTurnStatus(status: RootlessTurnLifecycleStatus): boolean {
  return (
    status === "completed" || status === "cancelled" || status === "failed" || status === "waiting"
  );
}

function denialMessage(reason: FolderDenialReason): string {
  switch (reason) {
    case "wrong-mode":
      return "Project mode does not match the thread.";
    case "unavailable":
      return "Project or host is unavailable.";
    case "archived":
      return "Project is archived.";
    case "stale-binding":
      return "Project binding is stale.";
    case "disconnected-host":
      return "Host is disconnected.";
    case "concurrent-turn":
      return "Cannot attach during an active turn.";
    case "cancelled":
      return "Attachment request was cancelled.";
    case "policy-denied":
      return "Attachment is not authorized.";
  }
}

interface AttachFolderCommandInput {
  readonly threadId: RootlessThreadId;
  readonly projectId: ProjectId;
  readonly receiptId: string;
  readonly attachmentId: typeof FolderAttachmentId.Type;
}

function decodeAttachFolderCommandInput(value: unknown): AttachFolderCommandInput {
  if (typeof value !== "object" || value === null) {
    throw new RootlessThreadServiceError("invalid", "Attach-folder command is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    !("threadId" in record) ||
    !("projectId" in record) ||
    !("receiptId" in record) ||
    !("attachmentId" in record)
  ) {
    throw new RootlessThreadServiceError("invalid", "Attach-folder command is invalid.");
  }
  try {
    return {
      threadId: decodeRootlessThreadId(record.threadId),
      projectId: decodeProjectId(record.projectId),
      receiptId: String(record.receiptId),
      attachmentId: decodeFolderAttachmentId(record.attachmentId),
    };
  } catch {
    throw new RootlessThreadServiceError("invalid", "Attach-folder command is invalid.");
  }
}
