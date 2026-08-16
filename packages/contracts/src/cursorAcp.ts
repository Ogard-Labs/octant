import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const boundedNonEmptyText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));

/**
 * Cursor ACP configuration is non-secret only. API keys never appear here;
 * subscription mode uses the official browser/account flow outside this schema.
 */
export const CursorAcpAuthMode = Schema.Literal("subscription", "api-key");
export type CursorAcpAuthMode = typeof CursorAcpAuthMode.Type;

export const CursorAcpConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("cursor-acp-config"),
  /** Absolute path to the cursor-agent executable. */
  executablePath: boundedNonEmptyText(1024).pipe(
    Schema.filter((value) => value.startsWith("/"), {
      message: () => "Cursor ACP executable path must be absolute.",
    }),
  ),
  authMode: CursorAcpAuthMode,
  /**
   * Production enablement remains fail-closed until a future compatibility
   * probe revises the NO-GO residual. Configuration may be authored for tests, but runtime
   * selection stays blocked while this flag is false.
   */
  productionEnabled: Schema.Literal(false),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CursorAcpConfig = typeof CursorAcpConfig.Type;

export const CursorAcpConnectionCheckRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("cursor-acp-connection-check"),
  config: CursorAcpConfig,
  /** Connection Check is prompt-free by contract. */
  sendPrompt: Schema.Literal(false),
}).annotations(strict);
export type CursorAcpConnectionCheckRequest = typeof CursorAcpConnectionCheckRequest.Type;

export const CursorAcpConnectionCheckResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("cursor-acp-connection-check-result"),
  status: Schema.Literal("blocked", "ready", "failed"),
  version: Schema.optional(boundedNonEmptyText(128)),
  authReady: Schema.optional(Schema.Boolean),
  modelCount: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  capabilities: Schema.Array(boundedNonEmptyText(64)).pipe(Schema.maxItems(32)),
  residualPacketId: Schema.optional(boundedNonEmptyText(128)),
  message: boundedNonEmptyText(1024),
}).annotations(strict);
export type CursorAcpConnectionCheckResult = typeof CursorAcpConnectionCheckResult.Type;

export const decodeCursorAcpConfig = Schema.decodeUnknownSync(CursorAcpConfig);
export const decodeCursorAcpConnectionCheckRequest = Schema.decodeUnknownSync(
  CursorAcpConnectionCheckRequest,
);
export const decodeCursorAcpConnectionCheckResult = Schema.decodeUnknownSync(
  CursorAcpConnectionCheckResult,
);
