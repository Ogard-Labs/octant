import {
  ActorId,
  AggregateVersion,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeAgentProfile,
  decodeAgentProfileCommand,
  decodeAgentProfileCommandResult,
  decodeResolveEffectiveProfileRequest,
  type AgentProfile,
  type AgentProfileCommand,
  type AgentProfileCommandResult,
  type AgentProfileId,
  type AgentProfileScope,
  type ExecutionResolutionReceipt,
  type ResolveEffectiveProfileRequest,
} from "@octant/contracts";
import { resolveEffectiveProfile } from "@octant/domain";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "./persistence/journalErrors";
import type { PersistenceService } from "./persistence/persistenceService";
import { ProjectionApplicationFailed } from "./persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface AgentProfileServiceApi {
  readonly list: () => Promise<ReadonlyArray<AgentProfile>>;
  readonly read: (profileId: AgentProfileId) => Promise<AgentProfile | undefined>;
  readonly execute: (command: unknown) => Promise<AgentProfileCommandResult>;
  readonly resolveEffectiveProfile: (request: unknown) => Promise<ExecutionResolutionReceipt>;
}

export interface AgentProfileServiceOptions {
  readonly persistence: PersistenceService;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class AgentProfileServiceError extends Error {
  override readonly name = "AgentProfileServiceError";
  constructor(
    readonly failure: {
      readonly reason: "invalid" | "stale-version" | "unauthorized" | "in-use";
      readonly message: string;
    },
  ) {
    super(failure.message);
  }
}

export class AgentProfileService implements AgentProfileServiceApi {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: AgentProfileServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  async list(): Promise<ReadonlyArray<AgentProfile>> {
    this.#assertReady();
    try {
      return this.#persistence.readAgentProfiles();
    } catch {
      throw this.#invalid("Agent profile service is unavailable.");
    }
  }

  async read(profileId: AgentProfileId): Promise<AgentProfile | undefined> {
    this.#assertReady();
    try {
      return this.#persistence.readAgentProfile(profileId);
    } catch {
      throw this.#invalid("Agent profile service is unavailable.");
    }
  }

  async execute(input: unknown): Promise<AgentProfileCommandResult> {
    let command: AgentProfileCommand;
    try {
      if (
        typeof input === "object" &&
        input !== null &&
        (input as Record<string, unknown>).kind === "create-agent-profile" &&
        (input as Record<string, unknown>).profileId === undefined
      ) {
        (input as Record<string, unknown>).profileId = this.#uuid();
      }
      command = decodeAgentProfileCommand(input);
    } catch {
      throw this.#invalid("Agent profile command is invalid.");
    }
    this.#assertReady();
    try {
      if (command.kind === "create-agent-profile") {
        return await this.#create(command);
      }
      if (command.kind === "update-agent-profile") {
        return await this.#update(command);
      }
      return await this.#remove(command);
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async resolveEffectiveProfile(input: unknown): Promise<ExecutionResolutionReceipt> {
    let request: ResolveEffectiveProfileRequest;
    try {
      request = decodeResolveEffectiveProfileRequest(input);
    } catch {
      throw this.#invalid("Resolution request is invalid.");
    }
    this.#assertReady();
    try {
      const profiles = this.#persistence.readAgentProfiles();
      const providers = this.#persistence.readProviderInstances();
      const catalogs = this.#persistence.readProviderCatalogs?.() ?? [];

      const profileById = new Map(profiles.map((p) => [String(p.id), p]));
      const providerIds = providers.filter((p) => p.enabled).map((p) => p.id);
      const catalogByInstance = new Map(catalogs.map((c) => [String(c.instanceId), c]));

      const oneOffProfile = request.oneOffOverride
        ? profileById.get(String(request.oneOffOverride.profileId))
        : undefined;
      const oneOffOverride =
        request.oneOffOverride !== undefined && oneOffProfile !== undefined
          ? {
              profile: oneOffProfile,
              providerInstanceId: request.oneOffOverride.providerInstanceId,
              modelId: request.oneOffOverride.modelId,
            }
          : undefined;
      const projectProfile = request.projectDefault
        ? profileById.get(String(request.projectDefault.profileId))
        : undefined;
      const projectDefault =
        request.projectDefault !== undefined && projectProfile !== undefined
          ? {
              profile: projectProfile,
              providerInstanceId: request.projectDefault.providerInstanceId,
              modelId: request.projectDefault.modelId,
            }
          : undefined;
      const modeProfile = request.modeDefault
        ? profileById.get(String(request.modeDefault.profileId))
        : undefined;
      const modeDefault =
        request.modeDefault !== undefined && modeProfile !== undefined
          ? {
              profile: modeProfile,
              providerInstanceId: request.modeDefault.providerInstanceId,
              modelId: request.modeDefault.modelId,
            }
          : undefined;

      const baseInput = {
        mode: request.mode,
        hostId: request.hostId,
        projectExecutionPolicy: request.projectExecutionPolicy,
        requestedExecutionPolicy:
          request.requestedExecutionPolicy ?? request.projectExecutionPolicy,
        providers: providerIds,
        catalogs,
        profiles: profiles.map((p) => ({
          profile: p,
          scope: request.scope,
        })),
      };
      return resolveEffectiveProfile({
        ...baseInput,
        ...(oneOffOverride !== undefined ? { oneOffOverride } : {}),
        ...(projectDefault !== undefined ? { projectDefault } : {}),
        ...(modeDefault !== undefined ? { modeDefault } : {}),
      });
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async #create(
    command: Extract<AgentProfileCommand, { kind: "create-agent-profile" }>,
  ): Promise<AgentProfileCommandResult> {
    if (this.#persistence.readAgentProfile(command.profileId) !== undefined) {
      throw this.#invalid("Profile ID is already in use.");
    }
    const timestamp = decodeTimestamp(this.#clock());
    const profile: AgentProfile = decodeAgentProfile({
      id: command.profileId,
      displayName: command.displayName,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
      approvedSkillIds: command.approvedSkillIds,
      toolConstraints: command.toolConstraints,
      modelConstraints: command.modelConstraints,
      defaultExecutionPolicy: command.defaultExecutionPolicy,
      defaultPermissionPersistence: command.defaultPermissionPersistence,
      compatibleModes: command.compatibleModes,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#persistence.journal.append({
      aggregate: { aggregateType: "agent-profile", aggregateId: command.profileId },
      expectedVersion: decodeAggregateVersion(0),
      events: [this.#pendingEvent("agent.profile-created@1", { profile, scope: command.scope })],
    });
    const authoritative = this.#persistence.readAgentProfile(command.profileId);
    if (authoritative === undefined || authoritative.version !== 1) {
      throw this.#invalid("Agent profile service is unavailable.");
    }
    return decodeAgentProfileCommandResult({ kind: "profile-created", profile: authoritative });
  }

  async #update(
    command: Extract<AgentProfileCommand, { kind: "update-agent-profile" }>,
  ): Promise<AgentProfileCommandResult> {
    const current = this.#persistence.readAgentProfile(command.profileId);
    if (current === undefined) {
      throw this.#invalid("Profile was not found.");
    }
    this.#assertVersion(current.version, command.expectedVersion);
    const timestamp = decodeTimestamp(this.#clock());
    const updated: AgentProfile = decodeAgentProfile({
      ...current,
      ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
      ...(command.approvedSkillIds === undefined
        ? {}
        : { approvedSkillIds: command.approvedSkillIds }),
      ...(command.toolConstraints === undefined
        ? {}
        : { toolConstraints: command.toolConstraints }),
      ...(command.modelConstraints === undefined
        ? {}
        : { modelConstraints: command.modelConstraints }),
      ...(command.defaultExecutionPolicy === undefined
        ? {}
        : { defaultExecutionPolicy: command.defaultExecutionPolicy }),
      ...(command.defaultPermissionPersistence === undefined
        ? {}
        : { defaultPermissionPersistence: command.defaultPermissionPersistence }),
      ...(command.compatibleModes === undefined
        ? {}
        : { compatibleModes: command.compatibleModes }),
      version: current.version + 1,
      updatedAt: timestamp,
    });
    const scope = this.#scopeForProfile(current.id);
    this.#persistence.journal.append({
      aggregate: { aggregateType: "agent-profile", aggregateId: command.profileId },
      expectedVersion: command.expectedVersion,
      events: [this.#pendingEvent("agent.profile-updated@1", { profile: updated, scope })],
    });
    const authoritative = this.#persistence.readAgentProfile(command.profileId);
    if (authoritative === undefined || authoritative.version !== updated.version) {
      throw this.#invalid("Agent profile service is unavailable.");
    }
    return decodeAgentProfileCommandResult({ kind: "profile-updated", profile: authoritative });
  }

  async #remove(
    command: Extract<AgentProfileCommand, { kind: "remove-agent-profile" }>,
  ): Promise<AgentProfileCommandResult> {
    const current = this.#persistence.readAgentProfile(command.profileId);
    if (current === undefined) {
      throw this.#invalid("Profile was not found.");
    }
    this.#assertVersion(current.version, command.expectedVersion);
    const version = current.version + 1;
    this.#persistence.journal.append({
      aggregate: { aggregateType: "agent-profile", aggregateId: command.profileId },
      expectedVersion: command.expectedVersion,
      events: [
        this.#pendingEvent("agent.profile-removed@1", {
          profileId: command.profileId,
          version: decodeAggregateVersion(version),
        }),
      ],
    });
    if (this.#persistence.readAgentProfile(command.profileId) !== undefined) {
      throw this.#invalid("Agent profile service is unavailable.");
    }
    return decodeAgentProfileCommandResult({
      kind: "profile-removed",
      profileId: command.profileId,
    });
  }

  /**
   * The scope a profile already has. An update carries the scope forward
   * rather than restating one: a profile that is relabelled user-wide every
   * time it is edited stops belonging to the Project, mode, or thread that
   * made it, and any of them could then bind it.
   */
  #scopeForProfile(profileId: AgentProfileId): AgentProfileScope {
    const binding = this.#persistence.readAgentProfileBinding(profileId);
    if (binding === undefined) {
      throw this.#invalid("Profile was not found.");
    }
    return binding.scope;
  }

  #pendingEvent(eventName: string, payload: unknown) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: { kind: "local-user" as const, actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertVersion(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new AgentProfileServiceError({
        reason: "stale-version",
        message: "Profile was modified by another session.",
      });
    }
  }

  #assertReady(): void {
    try {
      const status = this.#persistence.status();
      if (status.state !== "current" || status.integrity !== "ok") throw new Error("not ready");
    } catch {
      throw this.#invalid("Agent profile service is unavailable.");
    }
  }

  #mapFailure(error: unknown): AgentProfileServiceError {
    if (error instanceof AgentProfileServiceError) return error;
    if (error instanceof ConcurrencyConflict) {
      return new AgentProfileServiceError({
        reason: "stale-version",
        message: "Profile was modified by another session.",
      });
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#invalid("Agent profile service is unavailable.");
    }
    return this.#invalid("Agent profile service is unavailable.");
  }

  #invalid(message: string): AgentProfileServiceError {
    return new AgentProfileServiceError({ reason: "invalid", message });
  }
}
