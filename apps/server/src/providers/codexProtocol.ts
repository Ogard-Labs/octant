import { Schema } from "effect";

const decode = <A, I>(schema: Schema.Schema<A, I>) => Schema.decodeUnknownSync(schema);

export const CodexRpcId = Schema.Union(Schema.String, Schema.Int);
export type CodexRpcId = typeof CodexRpcId.Type;

const CodexRpcError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
});
export type CodexRpcError = typeof CodexRpcError.Type;

const CodexRpcSuccessResponse = Schema.Struct({
  id: CodexRpcId,
  result: Schema.Unknown,
});

const CodexRpcErrorResponse = Schema.Struct({
  id: CodexRpcId,
  error: CodexRpcError,
});

export type CodexRpcResponse =
  | typeof CodexRpcSuccessResponse.Type
  | typeof CodexRpcErrorResponse.Type;

const NonNegativeInteger = Schema.Int.pipe(Schema.nonNegative());
const NullableString = Schema.NullOr(Schema.String);
const NullableNonNegativeInteger = Schema.NullOr(NonNegativeInteger);

const InitializeResult = Schema.Struct({
  userAgent: Schema.String,
});
export type CodexInitializeResult = typeof InitializeResult.Type;
export const decodeInitializeResult = decode(InitializeResult);

const Account = Schema.Union(
  Schema.Struct({ type: Schema.Literal("apiKey") }),
  Schema.Struct({ type: Schema.Literal("chatgpt") }),
  Schema.Struct({ type: Schema.Literal("amazonBedrock") }),
);

const AccountReadResult = Schema.Struct({
  account: Schema.NullOr(Account),
  requiresOpenaiAuth: Schema.Boolean,
});
export type CodexAccountReadResult = typeof AccountReadResult.Type;
export const decodeAccountReadResult = decode(AccountReadResult);

const ReasoningEffortOption = Schema.Struct({
  reasoningEffort: Schema.String,
  description: Schema.String,
});

const ModelServiceTier = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
});

const Model = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  displayName: Schema.String,
  hidden: Schema.Boolean,
  supportedReasoningEfforts: Schema.Array(ReasoningEffortOption),
  defaultReasoningEffort: Schema.String,
  inputModalities: Schema.Array(Schema.Literal("text", "image")),
  serviceTiers: Schema.Array(ModelServiceTier),
  defaultServiceTier: NullableString,
  isDefault: Schema.Boolean,
});

const ModelListResult = Schema.Struct({
  data: Schema.Array(Model),
  nextCursor: NullableString,
});
export type CodexModelListResult = typeof ModelListResult.Type;
export const decodeModelListResult = decode(ModelListResult);

const ThreadReference = Schema.Struct({ id: Schema.String });
const TurnStatus = Schema.Literal("completed", "interrupted", "failed", "inProgress");
const TurnReference = Schema.Struct({
  id: Schema.String,
  status: TurnStatus,
});

const ThreadResult = Schema.Struct({
  thread: ThreadReference,
  model: Schema.String,
  modelProvider: Schema.String,
  serviceTier: NullableString,
  cwd: Schema.String,
});
export type CodexThreadResult = typeof ThreadResult.Type;
export const decodeThreadStartResult = decode(ThreadResult);
export const decodeThreadResumeResult = decode(ThreadResult);

const TurnStartResult = Schema.Struct({ turn: TurnReference });
export type CodexTurnResult = typeof TurnStartResult.Type;
export const decodeTurnStartResult = decode(TurnStartResult);

const TurnInterruptResult = Schema.Struct({});
export type CodexTurnInterruptResult = typeof TurnInterruptResult.Type;
export const decodeTurnInterruptResult = (value: unknown): CodexTurnInterruptResult => {
  decode(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(value);
  return {};
};

const CorrelatedItemParams = {
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
} as const;

const DeltaNotification = Schema.Struct({
  ...CorrelatedItemParams,
  delta: Schema.String,
});

const ReasoningSummaryDeltaNotification = Schema.Struct({
  ...CorrelatedItemParams,
  delta: Schema.String,
  summaryIndex: NonNegativeInteger,
});

const ReasoningTextDeltaNotification = Schema.Struct({
  ...CorrelatedItemParams,
  delta: Schema.String,
  contentIndex: NonNegativeInteger,
});

const FileUpdateKind = Schema.Union(
  Schema.Struct({ type: Schema.Literal("add") }),
  Schema.Struct({ type: Schema.Literal("delete") }),
  Schema.Struct({
    type: Schema.Literal("update"),
    move_path: NullableString,
  }),
);

const FileUpdate = Schema.Struct({
  path: Schema.String,
  kind: FileUpdateKind,
  diff: Schema.String,
});

const MODELED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "userMessage",
  "contextCompaction",
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
]);

/**
 * Codex adds item kinds over time (image views, review markers, ...). Anything
 * Octant does not model decodes to this opaque item so one new kind cannot take
 * down the whole connection; the mapper ignores it. Modeled kinds keep their
 * strict shapes because the filter excludes their names.
 */
const UnmodeledThreadItem = Schema.Struct({
  type: Schema.String.pipe(
    Schema.filter((type) => !MODELED_ITEM_TYPES.has(type)),
    Schema.brand("UnmodeledCodexItemType"),
  ),
  id: Schema.String,
});
export type UnmodeledThreadItem = Schema.Schema.Type<typeof UnmodeledThreadItem>;

export function isUnmodeledThreadItem(item: {
  readonly type: string;
}): item is UnmodeledThreadItem {
  return !MODELED_ITEM_TYPES.has(item.type);
}

const ThreadItem = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("userMessage"),
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("contextCompaction"),
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("agentMessage"),
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("plan"),
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    id: Schema.String,
    summary: Schema.Array(Schema.String),
    content: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("commandExecution"),
    id: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    status: Schema.Literal("inProgress", "completed", "failed", "declined"),
    aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
    exitCode: Schema.optional(NullableNonNegativeInteger),
    durationMs: Schema.optional(NullableNonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal("fileChange"),
    id: Schema.String,
    changes: Schema.Array(FileUpdate),
    status: Schema.Literal("inProgress", "completed", "failed", "declined"),
  }),
  Schema.Struct({
    type: Schema.Literal("mcpToolCall"),
    id: Schema.String,
    server: Schema.String,
    tool: Schema.String,
    status: Schema.Literal("inProgress", "completed", "failed"),
    durationMs: Schema.optional(NullableNonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal("dynamicToolCall"),
    id: Schema.String,
    namespace: Schema.NullOr(Schema.String),
    tool: Schema.String,
    status: Schema.Literal("inProgress", "completed", "failed"),
    success: Schema.NullOr(Schema.Boolean),
    durationMs: Schema.optional(NullableNonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal("webSearch"),
    id: Schema.String,
    query: Schema.String,
  }),
  UnmodeledThreadItem,
);

const ItemStartedNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  item: ThreadItem,
  startedAtMs: NonNegativeInteger,
});

const ItemCompletedNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  item: ThreadItem,
  completedAtMs: NonNegativeInteger,
});

const TurnStartedNotification = Schema.Struct({
  threadId: Schema.String,
  turn: TurnReference,
});

const TurnCompletedNotification = Schema.Struct({
  threadId: Schema.String,
  turn: TurnReference,
});

const TurnDiffNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  diff: Schema.String,
});

const TurnPlanStep = Schema.Struct({
  step: Schema.String,
  status: Schema.Literal("pending", "inProgress", "completed"),
});

const TurnPlanNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  explanation: NullableString,
  plan: Schema.Array(TurnPlanStep),
});

const TokenUsageBreakdown = Schema.Struct({
  totalTokens: NonNegativeInteger,
  inputTokens: NonNegativeInteger,
  cachedInputTokens: NonNegativeInteger,
  outputTokens: NonNegativeInteger,
  reasoningOutputTokens: NonNegativeInteger,
});

const TokenUsageNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  tokenUsage: Schema.Struct({
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown,
    modelContextWindow: NullableNonNegativeInteger,
  }),
});

/**
 * One rolling usage window of the account behind the app-server, as the
 * `account/rateLimits/updated` notification and `account/rateLimits/read`
 * response describe it. `resetsAt` is a Unix instant; `usedPercent` is the
 * share spent on a 0–100 scale.
 */
const RateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowDurationMins: Schema.optional(NullableNonNegativeInteger),
  resetsAt: Schema.optional(NullableNonNegativeInteger),
});
const NullableRateLimitWindow = Schema.NullOr(RateLimitWindow);

export const RateLimitSnapshot = Schema.Struct({
  limitId: Schema.optional(NullableString),
  limitName: Schema.optional(NullableString),
  primary: Schema.optional(NullableRateLimitWindow),
  secondary: Schema.optional(NullableRateLimitWindow),
  rateLimitReachedType: Schema.optional(NullableString),
});
export type RateLimitSnapshot = typeof RateLimitSnapshot.Type;

/**
 * Account-scoped and therefore carrying no thread or turn: the app-server
 * sends it whenever the backend reports usage, not as part of a turn.
 */
const AccountRateLimitsNotification = Schema.Struct({
  rateLimits: RateLimitSnapshot,
});

const stableNotificationSchemas = {
  "turn/started": TurnStartedNotification,
  "turn/completed": TurnCompletedNotification,
  "item/started": ItemStartedNotification,
  "item/completed": ItemCompletedNotification,
  "item/agentMessage/delta": DeltaNotification,
  "item/plan/delta": DeltaNotification,
  "item/reasoning/summaryTextDelta": ReasoningSummaryDeltaNotification,
  "item/reasoning/textDelta": ReasoningTextDeltaNotification,
  "turn/diff/updated": TurnDiffNotification,
  "turn/plan/updated": TurnPlanNotification,
  "thread/tokenUsage/updated": TokenUsageNotification,
  "account/rateLimits/updated": AccountRateLimitsNotification,
} as const;

export type CodexStableNotificationMethod = keyof typeof stableNotificationSchemas;
type CodexNotificationParams = {
  [Method in CodexStableNotificationMethod]: (typeof stableNotificationSchemas)[Method]["Type"];
};
export type CodexServerNotification = {
  [Method in CodexStableNotificationMethod]: {
    readonly kind: "notification";
    readonly method: Method;
    readonly params: CodexNotificationParams[Method];
  };
}[CodexStableNotificationMethod];

const stableNotificationDecoders: Record<
  CodexStableNotificationMethod,
  (value: unknown) => unknown
> = {
  "turn/started": decode(TurnStartedNotification),
  "turn/completed": decode(TurnCompletedNotification),
  "item/started": decode(ItemStartedNotification),
  "item/completed": decode(ItemCompletedNotification),
  "item/agentMessage/delta": decode(DeltaNotification),
  "item/plan/delta": decode(DeltaNotification),
  "item/reasoning/summaryTextDelta": decode(ReasoningSummaryDeltaNotification),
  "item/reasoning/textDelta": decode(ReasoningTextDeltaNotification),
  "turn/diff/updated": decode(TurnDiffNotification),
  "turn/plan/updated": decode(TurnPlanNotification),
  "thread/tokenUsage/updated": decode(TokenUsageNotification),
  "account/rateLimits/updated": decode(AccountRateLimitsNotification),
};

const StartedAt = { startedAtMs: NonNegativeInteger } as const;

const CommandApprovalParams = Schema.Struct({
  ...CorrelatedItemParams,
  ...StartedAt,
  approvalId: Schema.optional(NullableString),
  environmentId: NullableString,
  reason: Schema.optional(NullableString),
  command: Schema.optional(NullableString),
  cwd: Schema.optional(NullableString),
  networkApprovalContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        host: Schema.String,
        protocol: Schema.Literal("http", "https", "socks5Tcp", "socks5Udp"),
      }),
    ),
  ),
});
export type CodexCommandApprovalParams = typeof CommandApprovalParams.Type;
export const decodeCommandApprovalParams = decode(CommandApprovalParams);

const FileChangeApprovalParams = Schema.Struct({
  ...CorrelatedItemParams,
  ...StartedAt,
  reason: Schema.optional(NullableString),
  grantRoot: Schema.optional(NullableString),
});
export type CodexFileChangeApprovalParams = typeof FileChangeApprovalParams.Type;
export const decodeFileChangeApprovalParams = decode(FileChangeApprovalParams);

const FileSystemPath = Schema.Union(
  Schema.Struct({ type: Schema.Literal("path"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("glob_pattern"), pattern: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("special"),
    value: Schema.Union(
      Schema.Struct({ kind: Schema.Literal("root") }),
      Schema.Struct({ kind: Schema.Literal("minimal") }),
      Schema.Struct({ kind: Schema.Literal("project_roots"), subpath: NullableString }),
      Schema.Struct({ kind: Schema.Literal("tmpdir") }),
      Schema.Struct({ kind: Schema.Literal("slash_tmp") }),
      Schema.Struct({
        kind: Schema.Literal("unknown"),
        path: Schema.String,
        subpath: NullableString,
      }),
    ),
  }),
);

const PermissionsApprovalParams = Schema.Struct({
  ...CorrelatedItemParams,
  environmentId: NullableString,
  ...StartedAt,
  cwd: Schema.String,
  reason: NullableString,
  permissions: Schema.Struct({
    network: Schema.NullOr(Schema.Struct({ enabled: Schema.NullOr(Schema.Boolean) })),
    fileSystem: Schema.NullOr(
      Schema.Struct({
        read: Schema.NullOr(Schema.Array(Schema.String)),
        write: Schema.NullOr(Schema.Array(Schema.String)),
        entries: Schema.optional(
          Schema.Array(
            Schema.Struct({
              path: FileSystemPath,
              access: Schema.Literal("read", "write", "deny"),
            }),
          ),
        ),
      }),
    ),
  }),
});
export type CodexPermissionsApprovalParams = typeof PermissionsApprovalParams.Type;
export const decodePermissionsApprovalParams = decode(PermissionsApprovalParams);

const stableRequestSchemas = {
  "item/commandExecution/requestApproval": CommandApprovalParams,
  "item/fileChange/requestApproval": FileChangeApprovalParams,
  "item/permissions/requestApproval": PermissionsApprovalParams,
} as const;

export type CodexStableRequestMethod = keyof typeof stableRequestSchemas;
type CodexRequestParams = {
  [Method in CodexStableRequestMethod]: (typeof stableRequestSchemas)[Method]["Type"];
};
export type CodexServerRequest = {
  [Method in CodexStableRequestMethod]: {
    readonly kind: "request";
    readonly id: CodexRpcId;
    readonly method: Method;
    readonly params: CodexRequestParams[Method];
  };
}[CodexStableRequestMethod];

const stableRequestDecoders: Record<CodexStableRequestMethod, (value: unknown) => unknown> = {
  "item/commandExecution/requestApproval": decode(CommandApprovalParams),
  "item/fileChange/requestApproval": decode(FileChangeApprovalParams),
  "item/permissions/requestApproval": decode(PermissionsApprovalParams),
};

export type CodexServerMessage =
  | ({ readonly kind: "response" } & CodexRpcResponse)
  | CodexServerNotification
  | CodexServerRequest
  | { readonly kind: "unknown-notification"; readonly method: string }
  | { readonly kind: "unsupported-request"; readonly id: CodexRpcId; readonly method: string };

const decodeRpcId = decode(CodexRpcId);
const decodeMethod = decode(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeRpcResponse(value: Record<string, unknown>): CodexRpcResponse {
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");
  if (hasResult === hasError) {
    throw new TypeError("Codex response must contain exactly one result or error");
  }
  return hasError ? decode(CodexRpcErrorResponse)(value) : decode(CodexRpcSuccessResponse)(value);
}

export function decodeCodexServerMessage(value: unknown): CodexServerMessage {
  if (!isRecord(value)) {
    throw new TypeError("Codex server message must be an object");
  }

  if (!hasOwn(value, "method")) {
    return { kind: "response", ...decodeRpcResponse(value) };
  }

  const method = decodeMethod(value.method);
  if (hasOwn(value, "id")) {
    const id = decodeRpcId(value.id);
    if (hasOwn(stableRequestSchemas, method)) {
      const stableMethod = method as CodexStableRequestMethod;
      return {
        kind: "request",
        id,
        method: stableMethod,
        params: stableRequestDecoders[stableMethod](value.params),
      } as CodexServerRequest;
    }
    return { kind: "unsupported-request", id, method };
  }

  if (hasOwn(stableNotificationSchemas, method)) {
    const stableMethod = method as CodexStableNotificationMethod;
    return {
      kind: "notification",
      method: stableMethod,
      params: stableNotificationDecoders[stableMethod](value.params),
    } as CodexServerNotification;
  }

  return { kind: "unknown-notification", method };
}
