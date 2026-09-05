import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
  EventActor,
  EventId,
  NATIVE_HARNESS_ROUTING_AGGREGATE_TYPE,
  NATIVE_HARNESS_ROUTING_EVENT_NAMES,
  decodeNativeHarnessProjectRoutingOverride,
  decodeNativeHarnessRoutingSettings,
  type NativeHarnessProjectRoutingCommand,
  type NativeHarnessProjectRoutingOverride,
  type NativeHarnessRoutingCommandResult,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessRoutingSettings,
  type ProjectId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

export const NATIVE_HARNESS_ROUTING_HOST_AGGREGATE_ID = decodeAggregateId(
  "00000000-0000-4000-8000-0000000000b1",
);
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregate" | "replay">;

export interface NativeHarnessRoutingStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

/**
 * Server-authoritative slot routing: one host default and any number of
 * Project overrides, each its own journal aggregate so an override's version
 * moves independently of the host's. Every read comes from replayed state,
 * never from a client value.
 */
export class NativeHarnessRoutingStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  #host: NativeHarnessRoutingSettings;
  readonly #projects = new Map<string, NativeHarnessProjectRoutingOverride>();
  readonly #clearedVersions = new Map<string, number>();

  constructor(options: NativeHarnessRoutingStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
    this.#host = decodeNativeHarnessRoutingSettings({
      ...DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
      updatedAt: this.#clock(),
    });
    this.#hydrate();
  }

  host(): NativeHarnessRoutingSettings {
    return this.#host;
  }

  projectOverride(projectId: ProjectId): NativeHarnessProjectRoutingOverride | undefined {
    return this.#projects.get(String(projectId));
  }

  updateHost(input: {
    readonly configuration: NativeHarnessRoutingConfiguration;
    readonly expectedVersion: number;
  }): NativeHarnessRoutingCommandResult {
    if (input.expectedVersion !== this.#host.version) {
      return refused(
        "stale-version",
        `Expected version ${input.expectedVersion}, current is ${this.#host.version}.`,
      );
    }
    const updatedAt = this.#clock();
    const settings = decodeNativeHarnessRoutingSettings({
      configuration: input.configuration,
      version: decodeAggregateVersion(this.#host.version + 1),
      updatedAt,
    });
    const appended = this.#append(
      NATIVE_HARNESS_ROUTING_HOST_AGGREGATE_ID,
      this.#host.version,
      NATIVE_HARNESS_ROUTING_EVENT_NAMES.settingsUpdated,
      settings,
      updatedAt,
    );
    if (appended !== undefined) return appended;
    this.#host = settings;
    return { kind: "routing-settings", settings };
  }

  applyProjectCommand(
    command: NativeHarnessProjectRoutingCommand,
  ): NativeHarnessRoutingCommandResult {
    const current = this.#projects.get(String(command.projectId));
    // A cleared override keeps its aggregate version, or the next set would
    // expect version 0 against a journal that has moved on.
    const currentVersion =
      current?.version ?? this.#clearedVersions.get(String(command.projectId)) ?? 0;
    if (command.expectedVersion !== currentVersion) {
      return refused(
        "stale-version",
        `Expected version ${command.expectedVersion}, current is ${currentVersion}.`,
      );
    }
    const updatedAt = this.#clock();
    const version = decodeAggregateVersion(currentVersion + 1);
    const aggregateId = decodeAggregateId(String(command.projectId));
    if (command.kind === "set-project-routing-override") {
      const outside = outsideHost(command.configuration, this.#host.configuration);
      if (outside !== undefined) return refused("not-a-subset", outside);
      const override = decodeNativeHarnessProjectRoutingOverride({
        projectId: command.projectId,
        configuration: command.configuration,
        version,
        updatedAt,
      });
      const appended = this.#append(
        aggregateId,
        currentVersion,
        NATIVE_HARNESS_ROUTING_EVENT_NAMES.projectOverrideSet,
        override,
        updatedAt,
      );
      if (appended !== undefined) return appended;
      this.#projects.set(String(command.projectId), override);
      return { kind: "project-routing-override", override };
    }
    const appended = this.#append(
      aggregateId,
      currentVersion,
      NATIVE_HARNESS_ROUTING_EVENT_NAMES.projectOverrideCleared,
      { projectId: command.projectId, version },
      updatedAt,
    );
    if (appended !== undefined) return appended;
    this.#projects.delete(String(command.projectId));
    this.#clearedVersions.set(String(command.projectId), version);
    return { kind: "project-routing-override-cleared", projectId: command.projectId, version };
  }

  #append(
    aggregateId: typeof AggregateId.Type,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
    occurredAt: string,
  ): NativeHarnessRoutingCommandResult | undefined {
    try {
      this.#journal.append({
        aggregate: { aggregateType: NATIVE_HARNESS_ROUTING_AGGREGATE_TYPE, aggregateId },
        expectedVersion: decodeAggregateVersion(expectedVersion),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt,
            payload,
          },
        ],
      } as never);
      return undefined;
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        return refused("stale-version", "Routing changed; reload before applying your update.");
      }
      throw error;
    }
  }

  #hydrate(): void {
    // The host aggregate has a fixed id; Project overrides are found by
    // walking the aggregate type across the journal, which is the one read
    // that cannot know its aggregate ids in advance.
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replay({
        afterSequence: afterSequence as never,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      } as never);
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.aggregateType !== NATIVE_HARNESS_ROUTING_AGGREGATE_TYPE) continue;
        if (envelope.eventName === NATIVE_HARNESS_ROUTING_EVENT_NAMES.settingsUpdated) {
          this.#host = decodeNativeHarnessRoutingSettings(envelope.payload);
        } else if (envelope.eventName === NATIVE_HARNESS_ROUTING_EVENT_NAMES.projectOverrideSet) {
          const override = decodeNativeHarnessProjectRoutingOverride(envelope.payload);
          this.#projects.set(String(override.projectId), override);
        } else if (
          envelope.eventName === NATIVE_HARNESS_ROUTING_EVENT_NAMES.projectOverrideCleared
        ) {
          const cleared = envelope.payload as {
            readonly projectId: string;
            readonly version: number;
          };
          this.#projects.delete(String(cleared.projectId));
          this.#clearedVersions.set(String(cleared.projectId), cleared.version);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }
}

/**
 * A Project override may only narrow the host table: every slot and every
 * candidate it names must exist there. The first thing outside is the reason.
 */
function outsideHost(
  override: NativeHarnessRoutingConfiguration,
  host: NativeHarnessRoutingConfiguration,
): string | undefined {
  for (const slot of override.slots) {
    const hostSlot = host.slots.find((entry) => String(entry.id) === String(slot.id));
    if (hostSlot === undefined) return `Slot "${String(slot.id)}" is not in the host table.`;
    for (const candidate of slot.candidates) {
      const known = hostSlot.candidates.some(
        (entry) =>
          String(entry.hostId) === String(candidate.hostId) &&
          String(entry.providerInstanceId) === String(candidate.providerInstanceId) &&
          String(entry.modelId) === String(candidate.modelId),
      );
      if (!known) {
        return `Model "${String(candidate.modelId)}" is not in the host's "${String(slot.id)}" slot.`;
      }
    }
  }
  for (const binding of override.jobSlots) {
    if (!host.slots.some((entry) => String(entry.id) === String(binding.slotId))) {
      return `Job "${binding.job}" points at slot "${String(binding.slotId)}", which is not in the host table.`;
    }
  }
  return undefined;
}

function refused(
  reason: "stale-version" | "not-authorized" | "project-not-found" | "not-a-subset",
  message: string,
): NativeHarnessRoutingCommandResult {
  return { kind: "routing-refused", reason, message };
}
