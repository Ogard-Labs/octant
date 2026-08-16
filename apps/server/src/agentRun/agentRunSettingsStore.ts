import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  decodeAgentRunPolicySettings,
  type AgentRunCreationPosture,
  type AgentRunPolicySettings,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

export const AGENT_RUN_SETTINGS_AGGREGATE_TYPE = "agent-run-settings";
export const AGENT_RUN_SETTINGS_UPDATED = "agent-run-settings.updated@1";
export const AGENT_RUN_SETTINGS_AGGREGATE_ID = decodeAggregateId(
  "00000000-0000-4000-8000-0000000000a1",
);

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregate">;

export class AgentRunSettingsStoreError extends Error {
  override readonly name = "AgentRunSettingsStoreError";
  readonly category: "invalid" | "conflict";

  constructor(category: AgentRunSettingsStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface AgentRunSettingsStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

export interface UpdateAgentRunSettingsInput {
  readonly creationPosture: AgentRunCreationPosture;
  readonly expectedVersion: number;
}

/**
 * Server-authoritative Agents settings: a dedicated single-aggregate event
 * stream for the global creation posture (Off / Ask / Automatic within
 * policy). Mirrors `ThemeService`'s append-then-cache pattern so the
 * effective posture is durable, replay-rebuildable after restart, and never
 * trusted from a raw client value — every AgentRun creation route reads
 * `current()` itself rather than accepting a posture in the request body.
 */
export class AgentRunSettingsStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  #current: AgentRunPolicySettings;

  constructor(options: AgentRunSettingsStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new AgentRunSettingsStoreError("invalid", "AgentRun settings actor is invalid.");
    }
    this.#current = decodeAgentRunPolicySettings({
      creationPosture: "ask",
      version: 0,
      updatedAt: this.#clock(),
    });
    this.#hydrate();
  }

  current(): AgentRunPolicySettings {
    return this.#current;
  }

  update(input: UpdateAgentRunSettingsInput): AgentRunPolicySettings {
    if (input.expectedVersion !== this.#current.version) {
      throw new AgentRunSettingsStoreError(
        "conflict",
        `Expected version ${input.expectedVersion}, current is ${this.#current.version}.`,
      );
    }
    const updatedAt = this.#clock();
    let settings: AgentRunPolicySettings;
    try {
      settings = decodeAgentRunPolicySettings({
        creationPosture: input.creationPosture,
        version: decodeAggregateVersion(this.#current.version + 1),
        updatedAt,
      });
    } catch {
      throw new AgentRunSettingsStoreError("invalid", "AgentRun settings update is invalid.");
    }

    try {
      this.#journal.append({
        aggregate: {
          aggregateType: AGENT_RUN_SETTINGS_AGGREGATE_TYPE,
          aggregateId: AGENT_RUN_SETTINGS_AGGREGATE_ID,
        },
        expectedVersion: this.#current.version,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: AGENT_RUN_SETTINGS_UPDATED,
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: updatedAt,
            payload: settings,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new AgentRunSettingsStoreError(
          "conflict",
          "AgentRun settings changed; reload before applying your update.",
        );
      }
      throw error;
    }

    this.#current = settings;
    return settings;
  }

  #hydrate(): void {
    let afterVersion = 0;
    let latest: AgentRunPolicySettings | undefined;
    for (;;) {
      const batch = this.#journal.replayAggregate({
        aggregateType: AGENT_RUN_SETTINGS_AGGREGATE_TYPE,
        aggregateId: AGENT_RUN_SETTINGS_AGGREGATE_ID,
        afterVersion,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterVersion = envelope.aggregateVersion;
        if (envelope.eventName === AGENT_RUN_SETTINGS_UPDATED) {
          latest = decodeAgentRunPolicySettings(envelope.payload);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    if (latest !== undefined) this.#current = latest;
  }
}
