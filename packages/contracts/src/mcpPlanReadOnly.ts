import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";

/**
 * The providers whose own MCP servers Octant starts or withholds per session,
 * and so whose servers a person may let into Plan.
 */
export const McpPlanServerProvider = Schema.Literals(["claude", "codex", "opencode"]);
export type McpPlanServerProvider = typeof McpPlanServerProvider.Type;

/**
 * A server's name as the provider's own configuration names it. The name is
 * matched exactly when a Plan session starts; Claude Code and OpenCode build
 * tool names from it, so it holds no `__` separator and no whitespace.
 */
export const McpPlanServerName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Schema.makeFilter((value) => !value.includes("__"), {
    message: "An MCP server name has no double underscore.",
  }),
);
export type McpPlanServerName = typeof McpPlanServerName.Type;

/** One server the person marked "Read-only — allowed in Plan" on this host. */
export const McpPlanReadOnlyServer = Schema.Struct({
  provider: McpPlanServerProvider,
  serverName: McpPlanServerName,
});
export type McpPlanReadOnlyServer = typeof McpPlanReadOnlyServer.Type;

export const McpPlanReadOnlySettings = Schema.Struct({
  kind: Schema.Literal("mcp-plan-read-only-settings"),
  servers: Schema.Array(McpPlanReadOnlyServer).check(Schema.isMaxLength(256)),
  version: AggregateVersion,
  updatedAt: Schema.optional(UtcTimestamp),
});
export type McpPlanReadOnlySettings = typeof McpPlanReadOnlySettings.Type;

/**
 * Marking or unmarking one server, made from the version the person read. A
 * server's own `readOnlyHint` is its claim and never reaches this command: the
 * mark is only ever the person's.
 */
export const McpPlanReadOnlyCommand = Schema.Struct({
  kind: Schema.Literal("set-mcp-server-plan-read-only"),
  provider: McpPlanServerProvider,
  serverName: McpPlanServerName,
  readOnly: Schema.Boolean,
  expectedVersion: AggregateVersion,
});
export type McpPlanReadOnlyCommand = typeof McpPlanReadOnlyCommand.Type;

export const McpPlanReadOnlyResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mcp-plan-read-only-settings"),
    settings: McpPlanReadOnlySettings,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp-plan-read-only-refused"),
    reason: Schema.Literals(["malformed", "stale-version", "unauthorized", "no-change"]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type McpPlanReadOnlyResult = typeof McpPlanReadOnlyResult.Type;

export const MCP_PLAN_READ_ONLY_AGGREGATE_TYPE = "mcp-plan-read-only";
export const MCP_SERVER_PLAN_READ_ONLY_SET = "mcp-plan-read-only.server-set@1";

/** Journaled for every mark and unmark; the actor names who changed it. */
export const McpServerPlanReadOnlySet = Schema.Struct({
  provider: McpPlanServerProvider,
  serverName: McpPlanServerName,
  readOnly: Schema.Boolean,
});
export type McpServerPlanReadOnlySet = typeof McpServerPlanReadOnlySet.Type;

export const decodeMcpPlanReadOnlySettings = Schema.decodeUnknownSync(
  McpPlanReadOnlySettings,
  STRICT_DECODE_OPTIONS,
);
export const decodeMcpPlanReadOnlyCommand = Schema.decodeUnknownSync(
  McpPlanReadOnlyCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeMcpPlanReadOnlyResult = Schema.decodeUnknownSync(
  McpPlanReadOnlyResult,
  STRICT_DECODE_OPTIONS,
);
