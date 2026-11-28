import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";

/**
 * The providers whose tools a person may block in Settings › Permissions ›
 * Blocked tools: each one has a way to keep a named tool from its runtime at
 * every level (Claude Code's `disallowedTools`, OpenCode's permission deny,
 * Codex's own configuration, Pi's tool list and Octant's approval bridge).
 * A provider with no such way is not offered, rather than listed and left
 * unenforced.
 */
export const BlockableToolProvider = Schema.Literals(["claude", "codex", "opencode", "pi"]);
export type BlockableToolProvider = typeof BlockableToolProvider.Type;

/**
 * A tool's name as the provider's runtime names it (`WebFetch`, `shell`,
 * `webfetch`, `bash`), or `server__tool` for a tool of one of the provider's
 * own MCP servers. Matched exactly when a session starts.
 */
export const BlockedToolName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type BlockedToolName = typeof BlockedToolName.Type;

/** One tool the person blocked for one provider on this host. */
export const BlockedTool = Schema.Struct({
  provider: BlockableToolProvider,
  tool: BlockedToolName,
});
export type BlockedTool = typeof BlockedTool.Type;

export const BlockedToolsSettings = Schema.Struct({
  kind: Schema.Literal("blocked-tools-settings"),
  tools: Schema.Array(BlockedTool).check(Schema.isMaxLength(256)),
  version: AggregateVersion,
  updatedAt: Schema.optional(UtcTimestamp),
});
export type BlockedToolsSettings = typeof BlockedToolsSettings.Type;

/** Blocking or unblocking one tool, made from the version the person read. */
export const BlockedToolsCommand = Schema.Struct({
  kind: Schema.Literal("set-provider-tool-blocked"),
  provider: BlockableToolProvider,
  tool: BlockedToolName,
  blocked: Schema.Boolean,
  expectedVersion: AggregateVersion,
});
export type BlockedToolsCommand = typeof BlockedToolsCommand.Type;

export const BlockedToolsResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("blocked-tools-settings"),
    settings: BlockedToolsSettings,
  }),
  Schema.Struct({
    kind: Schema.Literal("blocked-tools-refused"),
    reason: Schema.Literals([
      "malformed",
      "stale-version",
      "unauthorized",
      "no-change",
      "unsupported",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type BlockedToolsResult = typeof BlockedToolsResult.Type;

export const BLOCKED_TOOLS_AGGREGATE_TYPE = "blocked-tools";
export const PROVIDER_TOOL_BLOCKED_SET = "blocked-tools.tool-set@1";

/** Journaled for every block and unblock; the actor names who changed it. */
export const ProviderToolBlockedSet = Schema.Struct({
  provider: BlockableToolProvider,
  tool: BlockedToolName,
  blocked: Schema.Boolean,
});
export type ProviderToolBlockedSet = typeof ProviderToolBlockedSet.Type;

export const decodeBlockedToolsSettings = Schema.decodeUnknownSync(
  BlockedToolsSettings,
  STRICT_DECODE_OPTIONS,
);
export const decodeBlockedToolsCommand = Schema.decodeUnknownSync(
  BlockedToolsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBlockedToolsResult = Schema.decodeUnknownSync(
  BlockedToolsResult,
  STRICT_DECODE_OPTIONS,
);
