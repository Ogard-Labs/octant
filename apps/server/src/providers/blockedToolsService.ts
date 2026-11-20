import type { EventActor, UtcTimestamp } from "@octant/contracts";
import {
  BLOCKED_TOOLS_AGGREGATE_TYPE,
  PROVIDER_TOOL_BLOCKED_SET,
  ProviderToolBlockedSet,
  decodeBlockedToolsResult,
  decodeBlockedToolsSettings,
  type BlockableToolProvider,
  type BlockedTool,
  type BlockedToolsCommand,
  type BlockedToolsResult,
  type BlockedToolsSettings,
} from "@octant/contracts/blocked-tools";
import { blockedToolRefusal } from "@octant/domain";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

/** The one aggregate the host's blocked tools live in. */
const BLOCKED_TOOLS_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000db";
const MAX_BLOCKED_TOOLS = 256;

const decodeSet = Schema.decodeUnknownSync(ProviderToolBlockedSet);

export function registerBlockedToolsEvents(registry: EventRegistry): EventRegistry {
  return registry.register(PROVIDER_TOOL_BLOCKED_SET, 1, ProviderToolBlockedSet);
}

export interface BlockedToolsServiceDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: EventActor;
}

/**
 * The provider tools a person blocked in Settings › Permissions › Blocked
 * tools, per provider and per host. Every session of that provider starts
 * with them blocked, at every level and with or without Strict; the list is
 * empty until the person adds to it. Every block and unblock is journaled
 * with who made it.
 */
export class BlockedToolsService {
  readonly #dependencies: BlockedToolsServiceDependencies;
  #tools: ReadonlyArray<BlockedTool> = [];
  #version = 0;
  #updatedAt: UtcTimestamp | undefined;

  constructor(dependencies: BlockedToolsServiceDependencies) {
    this.#dependencies = dependencies;
    for (const envelope of replayAggregateTypesInOrder(this.#dependencies.journal, [
      BLOCKED_TOOLS_AGGREGATE_TYPE,
    ])) {
      if (envelope.eventName === PROVIDER_TOOL_BLOCKED_SET) {
        this.#apply(decodeSet(envelope.payload));
      }
      this.#version = envelope.aggregateVersion;
      this.#updatedAt = envelope.occurredAt;
    }
  }

  /** The names a session of this provider starts with blocked, read at each launch. */
  toolsFor(provider: BlockableToolProvider): ReadonlyArray<string> {
    return this.#tools.filter((entry) => entry.provider === provider).map((entry) => entry.tool);
  }

  settings(): BlockedToolsSettings {
    return decodeBlockedToolsSettings({
      kind: "blocked-tools-settings",
      tools: this.#tools,
      version: this.#version,
      ...(this.#updatedAt === undefined ? {} : { updatedAt: this.#updatedAt }),
    });
  }

  /** `actor` is the paired device that asked; absent, the change is the local person's. */
  change(command: BlockedToolsCommand, actor?: EventActor): BlockedToolsResult {
    if (command.expectedVersion !== this.#version) {
      return refused("stale-version", "The blocked tools changed since you read them.");
    }
    const blocked = this.#tools.some(
      (entry) => entry.provider === command.provider && entry.tool === command.tool,
    );
    if (blocked === command.blocked) {
      return refused("no-change", "That tool is already set that way.");
    }
    if (command.blocked) {
      const refusal = blockedToolRefusal(command.provider, command.tool);
      if (refusal !== undefined) return refused("unsupported", refusal);
      if (this.#tools.length >= MAX_BLOCKED_TOOLS) {
        return refused("unsupported", `At most ${MAX_BLOCKED_TOOLS} tools can be blocked.`);
      }
    }
    const payload: ProviderToolBlockedSet = {
      provider: command.provider,
      tool: command.tool,
      blocked: command.blocked,
    };
    const occurredAt = this.#dependencies.clock();
    try {
      this.#dependencies.journal.append({
        aggregate: {
          aggregateType: BLOCKED_TOOLS_AGGREGATE_TYPE,
          aggregateId: BLOCKED_TOOLS_AGGREGATE_ID,
        },
        expectedVersion: this.#version,
        events: [
          {
            eventId: this.#dependencies.uuid(),
            eventName: PROVIDER_TOOL_BLOCKED_SET,
            eventVersion: 1,
            correlationId: this.#dependencies.uuid(),
            actor: actor ?? this.#dependencies.actor,
            occurredAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        return refused("stale-version", "The blocked tools changed since you read them.");
      }
      throw error;
    }
    this.#apply(payload);
    this.#version += 1;
    this.#updatedAt = occurredAt;
    return decodeBlockedToolsResult({ kind: "blocked-tools-settings", settings: this.settings() });
  }

  #apply(event: ProviderToolBlockedSet): void {
    const others = this.#tools.filter(
      (entry) => !(entry.provider === event.provider && entry.tool === event.tool),
    );
    this.#tools = event.blocked
      ? [...others, { provider: event.provider, tool: event.tool }]
      : others;
  }
}

function refused(
  reason: "malformed" | "stale-version" | "unauthorized" | "no-change" | "unsupported",
  message: string,
): BlockedToolsResult {
  return decodeBlockedToolsResult({ kind: "blocked-tools-refused", reason, message });
}
