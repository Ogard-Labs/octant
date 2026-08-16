import {
  ActorId,
  CorrelationId,
  EventId,
  ProviderSessionId,
  UtcTimestamp,
  WORK_TURN_CAPABILITIES,
  decodeCancelWorkTurnCommand,
  decodeWorkThreadTranscript,
  decodeWorkTurnCancelResult,
  decodeWorkTurnFailure,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  decodeWorkTurnState,
  decodeStartWorkThreadTurnCommand,
  type WorkThread,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnCancelResult,
  type WorkTurnLookupResult,
  type WorkTurnRequestId,
  type WorkTurnState,
  type Project,
  type ProjectId,
  type ProviderInstance,
  type ThreadWorkingDirectory,
  type WindowId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { decideWorkTurnAuthority } from "@octant/domain";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { WorkTurnProjection } from "./workTurnProjection";
import {
  WorkTurnRuntime,
  type WorkTurnRuntimeOutcome,
  type WorkTurnRuntimePort,
} from "./workTurnRuntime";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeProviderSessionId = Schema.decodeUnknownSync(ProviderSessionId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export class WorkTurnServiceError extends Error {
  override readonly name = "WorkTurnServiceError";
  constructor(
    readonly failure: {
      readonly category:
        | "invalid"
        | "unauthorized"
        | "unavailable"
        | "unsupported"
        | "interrupted"
        | "failed"
        | "stale";
      readonly message: string;
    },
  ) {
    super(failure.message);
  }
}

export interface WorkTurnServiceDependencies {
  readonly persistence: {
    readonly status: () => { readonly state: string; readonly integrity: string };
    readonly readProject: (projectId: ProjectId) => Project | undefined;
    readonly readProviderInstance: (
      instanceId: WorkThread["providerInstanceId"],
    ) => ProviderInstance | undefined;
    readonly journal: {
      append: (request: {
        readonly aggregate: {
          readonly aggregateType: string;
          readonly aggregateId: string;
        };
        readonly expectedVersion: number;
        readonly events: ReadonlyArray<{
          readonly eventId: string;
          readonly eventName: string;
          readonly eventVersion: 1;
          readonly correlationId: string;
          readonly actor: { readonly kind: "local-user"; readonly actorId: string };
          readonly occurredAt: string;
          readonly payload: unknown;
        }>;
      }) => void;
    };
  };
  readonly threads: {
    readonly bootstrap: (windowId: WindowId) => Promise<{
      readonly threads: ReadonlyArray<WorkThread>;
    }>;
  };
  readonly projects: {
    readonly bootstrap: (windowId: WindowId) => Promise<{
      readonly active: ReadonlyArray<{
        readonly id: ProjectId;
        readonly type: string;
        readonly lifecycle: string;
      }>;
    }>;
  };
  readonly projection: WorkTurnProjection;
  readonly workingDirectories: {
    readonly resolve: (
      authoritativeRoot: string,
      workingDirectory: ThreadWorkingDirectory,
    ) => Promise<string>;
  };
  readonly resolveDriver: (
    providerInstanceId: WorkThread["providerInstanceId"],
  ) => ProviderDriver | undefined;
  readonly turnRuntime?: WorkTurnRuntimePort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly expectedHostId?: string;
}

export class WorkTurnService {
  readonly #persistence: WorkTurnServiceDependencies["persistence"];
  readonly #threads: WorkTurnServiceDependencies["threads"];
  readonly #projects: WorkTurnServiceDependencies["projects"];
  readonly #projection: WorkTurnProjection;
  readonly #workingDirectories: WorkTurnServiceDependencies["workingDirectories"];
  readonly #resolveDriver: WorkTurnServiceDependencies["resolveDriver"];
  readonly #turnRuntime: WorkTurnRuntimePort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #expectedHostId: string;
  readonly #controllers = new Map<string, AbortController>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #liveResponses = new Map<string, string>();

  constructor(dependencies: WorkTurnServiceDependencies) {
    this.#persistence = dependencies.persistence;
    this.#threads = dependencies.threads;
    this.#projects = dependencies.projects;
    this.#projection = dependencies.projection;
    this.#workingDirectories = dependencies.workingDirectories;
    this.#resolveDriver = dependencies.resolveDriver;
    this.#turnRuntime = dependencies.turnRuntime ?? new WorkTurnRuntime();
    this.#uuid = dependencies.uuid;
    this.#clock = dependencies.clock;
    this.#expectedHostId = dependencies.expectedHostId ?? "local";
  }

  async startFirstTurn(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<WorkTurnLookupResult> {
    this.#assertReady();
    const command = decodeStartWorkThreadTurnCommand(input);
    const existing = this.#projection.lookup(command.requestId);
    if (existing !== undefined) {
      return this.#lookupMatching(command, existing);
    }

    const threadBootstrap = await this.#threads.bootstrap(authenticatedWindowId);
    const thread = threadBootstrap.threads.find(
      (candidate) => String(candidate.id) === String(command.threadId),
    );
    const projectBootstrap = await this.#projects.bootstrap(authenticatedWindowId);
    const accessible = projectBootstrap.active.some(
      (project) =>
        project.type === "work" &&
        project.lifecycle === "active" &&
        String(project.id) === String(command.authority.projectId),
    );
    if (!accessible) {
      throw this.#failure("unauthorized", "Work Project is unavailable for this window.");
    }
    const project = this.#persistence.readProject(command.authority.projectId);
    const decision = decideWorkTurnAuthority({
      authority: command.authority,
      expectedHostId: this.#expectedHostId,
      project:
        project === undefined
          ? undefined
          : {
              type: project.type,
              lifecycle: project.lifecycle,
              bindingHistory: project.type === "work" ? project.bindingHistory : [],
              binding:
                project.type === "work"
                  ? { canonicalRoot: project.binding.canonicalRoot }
                  : { canonicalRoot: "" },
            },
      thread:
        thread === undefined
          ? undefined
          : {
              projectId: String(thread.projectId),
              lifecycle: thread.lifecycle,
              providerInstanceId: String(thread.providerInstanceId),
              modelId: String(thread.modelId),
              bindingRevisionId:
                thread.bindingRevisionId === undefined
                  ? undefined
                  : String(thread.bindingRevisionId),
              workingDirectory:
                thread.workingDirectory === undefined ? undefined : String(thread.workingDirectory),
            },
    });
    if (decision.kind === "deny") {
      throw this.#failure(decision.category, decision.message);
    }
    if (project?.type !== "work") {
      throw this.#failure("unauthorized", "Work Project is unavailable for this turn.");
    }

    let projectRoot: string;
    try {
      projectRoot = await this.#workingDirectories.resolve(
        project.binding.canonicalRoot,
        command.authority.workingDirectory,
      );
    } catch {
      throw this.#failure("invalid", "Work working directory is unavailable.");
    }

    const provider = this.#persistence.readProviderInstance(command.authority.providerInstanceId);
    if (provider === undefined || !provider.enabled) {
      throw this.#failure("unavailable", "Selected Work provider is unavailable.");
    }
    const driver = this.#resolveDriver(command.authority.providerInstanceId);
    if (driver === undefined) {
      throw this.#failure("unavailable", "Selected provider cannot start a Work turn.");
    }

    const acceptedAt = decodeTimestamp(this.#clock());
    const providerSessionId = decodeProviderSessionId(this.#uuid());
    try {
      this.#append(command.requestId, 0, "work.turn-accepted@1", {
        kind: "turn-accepted",
        requestId: command.requestId,
        threadId: command.threadId,
        turnId: command.turnId,
        projectId: command.authority.projectId,
        authority: command.authority,
        providerSessionId,
        prompt: command.prompt,
        capabilities: WORK_TURN_CAPABILITIES,
        acceptedAt,
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        const duplicate = this.#projection.lookup(command.requestId);
        if (duplicate !== undefined) return this.#lookupMatching(command, duplicate);
        throw this.#failure("stale", "Work turn already exists.");
      }
      throw this.#mapFailure(error);
    }

    const accepted = this.#projection.lookup(command.requestId);
    if (accepted === undefined) {
      throw this.#failure("unavailable", "Work turn acceptance could not be projected.");
    }

    const controller = new AbortController();
    this.#controllers.set(String(command.requestId), controller);
    const launch = this.#runTurn({
      command,
      providerSessionId,
      projectRoot,
      driver,
      signal: controller.signal,
    }).finally(() => {
      this.#controllers.delete(String(command.requestId));
      this.#inflight.delete(String(command.requestId));
      this.#liveResponses.delete(String(command.requestId));
    });
    this.#inflight.set(String(command.requestId), launch);
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: this.#withLive(accepted) });
  }

  async lookupFirstTurn(
    authenticatedWindowId: WindowId,
    requestIdInput: string,
  ): Promise<WorkTurnLookupResult> {
    this.#assertReady();
    const requestId = decodeWorkTurnRequestId(requestIdInput);
    const turn = this.#projection.lookup(requestId);
    if (turn === undefined) {
      return decodeWorkTurnLookupResult({
        kind: "not-created",
        requestId,
        message: "Work turn was not created.",
      });
    }
    await this.#assertThreadAccess(authenticatedWindowId, turn.threadId, turn.projectId);
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: this.#withLive(turn) });
  }

  async cancelFirstTurn(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<WorkTurnCancelResult> {
    this.#assertReady();
    const command = decodeCancelWorkTurnCommand(input);
    const turn = this.#projection.lookup(command.requestId);
    if (turn === undefined) {
      throw this.#failure("invalid", "Work turn was not found.");
    }
    await this.#assertThreadAccess(authenticatedWindowId, turn.threadId, turn.projectId);
    if (
      String(turn.threadId) !== String(command.threadId) ||
      String(turn.turnId) !== String(command.turnId)
    ) {
      throw this.#failure("invalid", "Work turn identity does not match.");
    }
    if (turn.status === "completed" || turn.status === "cancelled" || turn.status === "failed") {
      return decodeWorkTurnCancelResult({
        kind: "turn-already-terminal",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: turn.status,
      });
    }
    this.#controllers.get(String(command.requestId))?.abort();
    this.#persistUpdate(turn, {
      status: "cancelled",
      ...(turn.response === undefined ? {} : { response: turn.response }),
    });
    return decodeWorkTurnCancelResult({
      kind: "turn-cancelled",
      requestId: turn.requestId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: "cancelled",
    });
  }

  async transcript(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<WorkThreadTranscript> {
    this.#assertReady();
    const bootstrap = await this.#threads.bootstrap(authenticatedWindowId);
    const thread = bootstrap.threads.find((candidate) => String(candidate.id) === String(threadId));
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    return decodeWorkThreadTranscript({
      threadId,
      turns: this.#projection.listForThread(threadId).map((turn) => this.#withLive(turn)),
    });
  }

  #withLive(turn: WorkTurnState): WorkTurnState {
    const live = this.#liveResponses.get(String(turn.requestId));
    if (live === undefined || turn.status === "completed" || turn.status === "cancelled") {
      return turn;
    }
    return decodeWorkTurnState({
      ...turn,
      status: turn.status === "accepted" ? "running" : turn.status,
      response: live,
      transcript: [
        { role: "user", text: turn.prompt },
        { role: "assistant", text: live, status: "running" },
      ],
    });
  }

  async #runTurn(input: {
    readonly command: ReturnType<typeof decodeStartWorkThreadTurnCommand>;
    readonly providerSessionId: ProviderSessionId;
    readonly projectRoot: string;
    readonly driver: ProviderDriver;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const current = this.#projection.lookup(input.command.requestId);
    if (current === undefined) return;
    this.#persistUpdate(current, { status: "running" });

    const outcome = await this.#turnRuntime.run({
      command: input.command,
      providerSessionId: input.providerSessionId,
      projectRoot: input.projectRoot,
      driver: input.driver,
      signal: input.signal,
      onDelta: (response) => {
        this.#liveResponses.set(String(input.command.requestId), response);
      },
    });
    const latest = this.#projection.lookup(input.command.requestId);
    if (latest === undefined || latest.status === "cancelled") return;
    const live = this.#liveResponses.get(String(input.command.requestId));
    this.#persistOutcome(
      live === undefined ? latest : decodeWorkTurnState({ ...latest, response: live }),
      outcome,
    );
  }

  #persistOutcome(turn: WorkTurnState, outcome: WorkTurnRuntimeOutcome): void {
    if (outcome.kind === "completed") {
      this.#persistUpdate(turn, { status: "completed", response: outcome.response });
      return;
    }
    if (outcome.kind === "cancelled") {
      this.#persistUpdate(turn, {
        status: "cancelled",
        ...(turn.response === undefined ? {} : { response: turn.response }),
      });
      return;
    }
    this.#persistUpdate(turn, {
      status: outcome.kind === "waiting" ? "waiting" : "failed",
      ...(turn.response === undefined ? {} : { response: turn.response }),
      failure: outcome.failure,
    });
  }

  #persistUpdate(
    turn: WorkTurnState,
    update: {
      readonly status: "running" | "completed" | "cancelled" | "failed" | "waiting";
      readonly response?: string;
      readonly failure?: WorkTurnState["failure"];
    },
  ): void {
    const latest = this.#projection.lookup(turn.requestId) ?? turn;
    const updatedAt = decodeTimestamp(this.#clock());
    const response = update.response ?? latest.response;
    const transcript = [
      { role: "user" as const, text: latest.prompt },
      ...(response === undefined && update.status === "running"
        ? [{ role: "assistant" as const, text: "", status: "running" as const }]
        : response === undefined
          ? []
          : [
              {
                role: "assistant" as const,
                text: response,
                status: update.status,
              },
            ]),
    ];
    try {
      this.#append(latest.requestId, latest.version, "work.turn-updated@1", {
        kind: "turn-updated",
        requestId: latest.requestId,
        threadId: latest.threadId,
        turnId: latest.turnId,
        status: update.status,
        ...(response === undefined ? {} : { response }),
        transcript,
        ...(update.failure === undefined ? {} : { failure: update.failure }),
        updatedAt,
      });
    } catch {
      // Projection/journal failures after acceptance are retained as waiting so
      // reconnect can surface an honest interrupted/recovery state.
    }
  }

  #append(
    requestId: WorkTurnRequestId,
    expectedVersion: number,
    eventName: "work.turn-accepted@1" | "work.turn-updated@1",
    payload: unknown,
  ): void {
    this.#persistence.journal.append({
      aggregate: {
        aggregateType: "work-turn",
        aggregateId: String(requestId),
      },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: {
            kind: "local-user",
            actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
          },
          occurredAt: decodeTimestamp(this.#clock()),
          payload,
        },
      ],
    });
    if (eventName === "work.turn-accepted@1") {
      this.#projection.apply(payload as never);
    } else {
      this.#projection.apply(payload as never);
    }
  }

  #lookupMatching(
    command: ReturnType<typeof decodeStartWorkThreadTurnCommand>,
    existing: WorkTurnState,
  ): WorkTurnLookupResult {
    if (
      String(existing.threadId) !== String(command.threadId) ||
      String(existing.turnId) !== String(command.turnId) ||
      existing.prompt !== command.prompt
    ) {
      throw this.#failure("stale", "Work turn request identity conflict.");
    }
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: existing });
  }

  async #assertThreadAccess(
    windowId: WindowId,
    threadId: WorkThreadId,
    projectId: ProjectId,
  ): Promise<void> {
    const bootstrap = await this.#threads.bootstrap(windowId);
    const thread = bootstrap.threads.find((candidate) => String(candidate.id) === String(threadId));
    if (thread === undefined || String(thread.projectId) !== String(projectId)) {
      throw this.#failure("unauthorized", "Work turn is unavailable for this window.");
    }
  }

  #assertReady(): void {
    const status = this.#persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw this.#failure("unavailable", "Octant Work turn service is unavailable.");
    }
  }

  #mapFailure(error: unknown): WorkTurnServiceError {
    if (error instanceof WorkTurnServiceError) return error;
    if (error instanceof ConcurrencyConflict) {
      return this.#failure("stale", "Work turn changed; reload and retry.");
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#failure("unavailable", "Octant Work turn service is unavailable.");
    }
    return this.#failure("unavailable", "Octant Work turn service is unavailable.");
  }

  #failure(
    category: WorkTurnServiceError["failure"]["category"],
    message: string,
  ): WorkTurnServiceError {
    return new WorkTurnServiceError(decodeWorkTurnFailure({ category, message }));
  }
}
