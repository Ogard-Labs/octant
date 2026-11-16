import type { EventActor, UtcTimestamp } from "@octant/contracts";
import {
  MCP_PLAN_READ_ONLY_AGGREGATE_TYPE,
  MCP_SERVER_PLAN_READ_ONLY_SET,
  McpServerPlanReadOnlySet,
  decodeMcpPlanReadOnlyResult,
  decodeMcpPlanReadOnlySettings,
  type McpPlanReadOnlyCommand,
  type McpPlanReadOnlyResult,
  type McpPlanReadOnlyServer,
  type McpPlanReadOnlySettings,
  type McpPlanServerProvider,
} from "@octant/contracts/mcp-plan-read-only";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

/** The one aggregate the host's marks live in. */
const MCP_PLAN_READ_ONLY_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000d8";

const decodeSet = Schema.decodeUnknownSync(McpServerPlanReadOnlySet);

export function registerMcpPlanReadOnlyEvents(registry: EventRegistry): EventRegistry {
  return registry.register(MCP_SERVER_PLAN_READ_ONLY_SET, 1, McpServerPlanReadOnlySet);
}

export interface McpPlanReadOnlyServiceDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: EventActor;
}

/**
 * The MCP servers a person marked "Read-only — allowed in Plan", per server
 * and per host. A Plan session of Claude Code, Codex or OpenCode starts the
 * provider's own servers this list names and no other; a server's own
 * `readOnlyHint` never adds one. Every mark and unmark is journaled with who
 * made it.
 */
export class McpPlanReadOnlyService {
  readonly #dependencies: McpPlanReadOnlyServiceDependencies;
  #servers: ReadonlyArray<McpPlanReadOnlyServer> = [];
  #version = 0;
  #updatedAt: UtcTimestamp | undefined;

  constructor(dependencies: McpPlanReadOnlyServiceDependencies) {
    this.#dependencies = dependencies;
    for (const envelope of replayAggregateTypesInOrder(this.#dependencies.journal, [
      MCP_PLAN_READ_ONLY_AGGREGATE_TYPE,
    ])) {
      if (envelope.eventName === MCP_SERVER_PLAN_READ_ONLY_SET) {
        this.#apply(decodeSet(envelope.payload));
      }
      this.#version = envelope.aggregateVersion;
      this.#updatedAt = envelope.occurredAt;
    }
  }

  /** The names a Plan session of this provider may start, read at each launch. */
  serversFor(provider: McpPlanServerProvider): ReadonlyArray<string> {
    return this.#servers
      .filter((server) => server.provider === provider)
      .map((server) => server.serverName);
  }

  settings(): McpPlanReadOnlySettings {
    return decodeMcpPlanReadOnlySettings({
      kind: "mcp-plan-read-only-settings",
      servers: this.#servers,
      version: this.#version,
      ...(this.#updatedAt === undefined ? {} : { updatedAt: this.#updatedAt }),
    });
  }

  /** `actor` is the paired device that asked; absent, the change is the local person's. */
  change(command: McpPlanReadOnlyCommand, actor?: EventActor): McpPlanReadOnlyResult {
    if (command.expectedVersion !== this.#version) {
      return refused("stale-version", "The servers allowed in Plan changed since you read them.");
    }
    const marked = this.#servers.some(
      (server) => server.provider === command.provider && server.serverName === command.serverName,
    );
    if (marked === command.readOnly) {
      return refused("no-change", "That server is already set that way.");
    }
    const payload: McpServerPlanReadOnlySet = {
      provider: command.provider,
      serverName: command.serverName,
      readOnly: command.readOnly,
    };
    const occurredAt = this.#dependencies.clock();
    try {
      this.#dependencies.journal.append({
        aggregate: {
          aggregateType: MCP_PLAN_READ_ONLY_AGGREGATE_TYPE,
          aggregateId: MCP_PLAN_READ_ONLY_AGGREGATE_ID,
        },
        expectedVersion: this.#version,
        events: [
          {
            eventId: this.#dependencies.uuid(),
            eventName: MCP_SERVER_PLAN_READ_ONLY_SET,
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
        return refused("stale-version", "The servers allowed in Plan changed since you read them.");
      }
      throw error;
    }
    this.#apply(payload);
    this.#version += 1;
    this.#updatedAt = occurredAt;
    return decodeMcpPlanReadOnlyResult({
      kind: "mcp-plan-read-only-settings",
      settings: this.settings(),
    });
  }

  #apply(event: McpServerPlanReadOnlySet): void {
    const others = this.#servers.filter(
      (server) => !(server.provider === event.provider && server.serverName === event.serverName),
    );
    this.#servers = event.readOnly
      ? [...others, { provider: event.provider, serverName: event.serverName }]
      : others;
  }
}

function refused(
  reason: "malformed" | "stale-version" | "unauthorized" | "no-change",
  message: string,
): McpPlanReadOnlyResult {
  return decodeMcpPlanReadOnlyResult({ kind: "mcp-plan-read-only-refused", reason, message });
}
