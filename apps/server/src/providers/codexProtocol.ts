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
  // Codex reports `usesCodexManagedCredentials` when the Bedrock key or access
  // keys it signs in with are the ones stored in this account's own home
  // (`account_state` in codex-rs `model-provider/src/amazon_bedrock/mod.rs`,
  // rust-v0.162.1). Releases before that send no field, which reads as false.
  Schema.Struct({
    type: Schema.Literal("amazonBedrock"),
    usesCodexManagedCredentials: Schema.optional(Schema.Boolean),
  }),
);

const AccountReadResult = Schema.Struct({
  account: Schema.NullOr(Account),
  requiresOpenaiAuth: Schema.Boolean,
});
export type CodexAccountReadResult = typeof AccountReadResult.Type;
export const decodeAccountReadResult = decode(AccountReadResult);

/**
 * Whether Codex's own Windows sandbox can run commands now
 * (`windowsSandbox/readiness`, codex-rs `windows_sandbox_processor.rs`).
 * `ready` for the elevated backend means its one-time setup has completed;
 * `updateRequired` means it has not, and `notConfigured` that no sandbox is
 * configured at all. Any other value is kept as a string so the caller refuses
 * it instead of failing to decode.
 */
const WindowsSandboxReadinessResult = Schema.Struct({ status: Schema.String });
export type CodexWindowsSandboxReadinessResult = typeof WindowsSandboxReadinessResult.Type;
export const decodeWindowsSandboxReadinessResult = decode(WindowsSandboxReadinessResult);

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
  // A modality a newer Codex lists is left out, so one new name cannot fail
  // the whole model list.
  inputModalities: Schema.transform(
    Schema.Array(Schema.String),
    Schema.Array(Schema.Literal("text", "image")),
    {
      strict: true,
      decode: (modalities) =>
        modalities.filter(
          (modality): modality is "text" | "image" => modality === "text" || modality === "image",
        ),
      encode: (modalities) => modalities,
    },
  ),
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
/**
 * `completed`, `interrupted`, `failed` or `inProgress` today. Statuses stay
 * open strings throughout this file: a value a newer Codex adds must not make
 * the notification that carries it undecodable, least of all the one that ends
 * a turn. The mapper reads the values it knows and treats any other neutrally.
 */
const TurnStatus = Schema.String;
/**
 * The reason the app-server reports on a failed turn. `codexErrorInfo` is the
 * classified signal (`"usageLimitExceeded"`, `"rateLimitExceeded"`, ...);
 * structured variants decode as records and only their string form classifies.
 */
const TurnError = Schema.Struct({
  message: Schema.String,
  codexErrorInfo: Schema.optionalWith(
    Schema.Union(Schema.String, Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    { nullable: true },
  ),
  additionalDetails: Schema.optional(NullableString),
});
const TurnReference = Schema.Struct({
  id: Schema.String,
  status: TurnStatus,
  // 0.157.x emits `"error": null` on healthy turns; null reads as absent.
  error: Schema.optionalWith(TurnError, { nullable: true }),
});
export type CodexTurnReference = typeof TurnReference.Type;

const ThreadResult = Schema.Struct({
  thread: ThreadReference,
  model: Schema.String,
  modelProvider: Schema.String,
  serviceTier: NullableString,
  cwd: Schema.String,
  reasoningEffort: Schema.optional(NullableString),
  /**
   * The collaboration mode a resumed thread recorded; Codex keeps it for the
   * thread's later turns. Absent from a fresh thread and an older server.
   */
  collaborationMode: Schema.optional(Schema.NullOr(Schema.Struct({ mode: Schema.String }))),
});
export type CodexThreadResult = typeof ThreadResult.Type;
export const decodeThreadStartResult = decode(ThreadResult);
export const decodeThreadResumeResult = decode(ThreadResult);
export const decodeThreadForkResult = decode(ThreadResult);

/**
 * A thread switches the skills Codex found in the Project off by their paths,
 * and every package it could not load as well, which carries a path but no
 * scope. The name, description and `enabled` flag label the composer's `@`
 * menu and resolve a `$name` the person wrote; a release that omits them
 * offers nothing there.
 */
const SkillsListResult = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      skills: Schema.Array(
        Schema.Struct({
          path: Schema.NonEmptyString,
          scope: Schema.String,
          name: Schema.optional(Schema.String),
          description: Schema.optional(Schema.String),
          shortDescription: Schema.optional(Schema.String),
          enabled: Schema.optional(Schema.Boolean),
        }),
      ),
      errors: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString })),
    }),
  ),
});
export type CodexSkillsListResult = typeof SkillsListResult.Type;
export const decodeSkillsListResult = decode(SkillsListResult);

/**
 * `plugin/installed` (codex-cli 0.135.0 and later): the plugins installed for
 * the account, by marketplace. A plugin's `id` is `<name>@<marketplace>`, the
 * target a `mention` input item names as `plugin://<id>`.
 */
const PluginInstalledResult = Schema.Struct({
  marketplaces: Schema.Array(
    Schema.Struct({
      plugins: Schema.Array(
        Schema.Struct({
          id: Schema.NonEmptyString,
          name: Schema.NonEmptyString,
          installed: Schema.Boolean,
          enabled: Schema.Boolean,
          interface: Schema.optionalWith(
            Schema.Struct({
              shortDescription: Schema.optionalWith(Schema.String, { nullable: true }),
            }),
            { nullable: true },
          ),
        }),
      ),
    }),
  ),
});
export type CodexPluginInstalledResult = typeof PluginInstalledResult.Type;
export const decodePluginInstalledResult = decode(PluginInstalledResult);

/**
 * One stored thread as `thread/list` and `thread/read` describe it. Only what
 * offering and adopting a session needs is read: its folder, whether it is a
 * subagent's or ephemeral, who created it (`originator`, the `initialize`
 * client name, from codex-cli 0.154.0), its title, and when it last changed.
 */
const StoredThread = Schema.Struct({
  id: Schema.NonEmptyString,
  cwd: Schema.String,
  preview: Schema.optionalWith(Schema.String, { nullable: true }),
  name: Schema.optionalWith(Schema.String, { nullable: true }),
  updatedAt: Schema.Number,
  ephemeral: Schema.optionalWith(Schema.Boolean, { nullable: true }),
  parentThreadId: Schema.optionalWith(Schema.String, { nullable: true }),
  originator: Schema.optionalWith(Schema.String, { nullable: true }),
  gitInfo: Schema.optionalWith(
    Schema.Struct({ branch: Schema.optionalWith(Schema.String, { nullable: true }) }),
    { nullable: true },
  ),
});
export type CodexStoredThread = typeof StoredThread.Type;

const ThreadListResult = Schema.Struct({
  data: Schema.Array(StoredThread),
  nextCursor: NullableString,
});
export type CodexThreadListResult = typeof ThreadListResult.Type;
export const decodeThreadListResult = decode(ThreadListResult);

const ThreadReadResult = Schema.Struct({ thread: StoredThread });

/**
 * `thread/read` with `includeTurns`: the stored thread's turns, each with its
 * items as Codex keeps them. Items stay unknown here; only the imported
 * history reads them, by their `type`. `turns` is absent from a server that
 * ignores the flag.
 */
const ThreadTurnsReadResult = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.NonEmptyString,
    turns: Schema.optionalWith(
      Schema.Array(Schema.Struct({ items: Schema.Array(Schema.Unknown) })),
      { nullable: true },
    ),
  }),
});
export type CodexThreadTurnsReadResult = typeof ThreadTurnsReadResult.Type;
export const decodeThreadTurnsReadResult = decode(ThreadTurnsReadResult);
export type CodexThreadReadResult = typeof ThreadReadResult.Type;
export const decodeThreadReadResult = decode(ThreadReadResult);

/**
 * Of the effective config only the configured MCP server names are read: a
 * Chat thread switches each one off by name. The selected model provider and
 * the provider tables are read too, so a Bedrock sign-in can be traced to its
 * source; they stay unknown values that `codexBedrockSignIn` inspects.
 */
const ConfigReadResult = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
      nullable: true,
    }),
    model_provider: Schema.optionalWith(Schema.String, { nullable: true }),
    model_providers: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      { nullable: true },
    ),
  }),
});
export type CodexConfigReadResult = typeof ConfigReadResult.Type;
/**
 * A server named `__proto__` decodes out of the record without an error, so a
 * Chat thread would leave it running. Such a config is refused instead.
 */
export const decodeConfigReadResult = (value: unknown): CodexConfigReadResult => {
  const servers = isRecord(value) && isRecord(value.config) ? value.config.mcp_servers : undefined;
  if (isRecord(servers) && hasOwn(servers, "__proto__")) {
    throw new TypeError("Codex config names an MCP server Octant cannot switch off.");
  }
  return decode(ConfigReadResult)(value);
};

const TurnStartResult = Schema.Struct({ turn: TurnReference });
export type CodexTurnResult = typeof TurnStartResult.Type;
export const decodeTurnStartResult = decode(TurnStartResult);

/**
 * `review/start` answers the review's turn and the thread it runs on, which is
 * the one it was given for an inline review (`ReviewStartResponse` in codex-rs
 * `app-server-protocol` `v2/review.rs`, rust-v0.169.0).
 */
const ReviewStartResult = Schema.Struct({
  turn: TurnReference,
  reviewThreadId: Schema.NonEmptyString,
});
export type CodexReviewStartResult = typeof ReviewStartResult.Type;
export const decodeReviewStartResult = decode(ReviewStartResult);

const TurnSteerResult = Schema.Struct({ turnId: Schema.NonEmptyString });
export type CodexTurnSteerResult = typeof TurnSteerResult.Type;
export const decodeTurnSteerResult = decode(TurnSteerResult);

const TurnInterruptResult = Schema.Struct({});
export type CodexTurnInterruptResult = typeof TurnInterruptResult.Type;
export const decodeTurnInterruptResult = (value: unknown): CodexTurnInterruptResult => {
  decode(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(value);
  return {};
};

/** `thread/inject_items` answers `{}` once the items are in the thread's history. */
export const decodeThreadInjectItemsResult = (value: unknown): Record<string, never> => {
  decode(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(value);
  return {};
};

/** `thread/compact/start` answers `{}` once it has queued the compaction. */
export const decodeThreadCompactStartResult = (value: unknown): Record<string, never> => {
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

/**
 * Tool-execution progress. Only the correlation is decoded: the output, the
 * progress message and the patch are content the adapter must not carry, and
 * it uses these notifications as proof of life alone.
 */
const ToolProgressNotification = Schema.Struct(CorrelatedItemParams);

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
  "enteredReviewMode",
  "exitedReviewMode",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "collabAgentToolCall",
]);

/**
 * Codex adds item kinds over time (image views, ...). Anything
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
  // A review run's markers: `review` is the hint shown on entering, and on
  // leaving the review's findings as Codex renders them (`review_output_text`).
  Schema.Struct({
    type: Schema.Literal("enteredReviewMode", "exitedReviewMode"),
    id: Schema.String,
    review: Schema.String,
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
    status: Schema.String,
    aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
    exitCode: Schema.optional(NullableNonNegativeInteger),
    durationMs: Schema.optional(NullableNonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal("fileChange"),
    id: Schema.String,
    changes: Schema.Array(FileUpdate),
    status: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("mcpToolCall"),
    id: Schema.String,
    server: Schema.String,
    tool: Schema.String,
    status: Schema.String,
    durationMs: Schema.optional(NullableNonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal("dynamicToolCall"),
    id: Schema.String,
    namespace: Schema.NullOr(Schema.String),
    tool: Schema.String,
    status: Schema.String,
    success: Schema.NullOr(Schema.Boolean),
    durationMs: Schema.optional(NullableNonNegativeInteger),
  }),
  Schema.Struct({
    type: Schema.Literal("webSearch"),
    id: Schema.String,
    query: Schema.String,
    /**
     * What a standalone search returned (codex-cli 0.164.0
     * `WebSearchItem.results`), as opaque JSON. A search the model's provider
     * runs itself reports none.
     */
    results: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  }),
  /**
   * One of Codex's own subagent calls (codex-cli 0.164.0 `ThreadItem`):
   * starting a subagent, waiting on one, or closing it. Only a thread the
   * person let run Codex's own subagents ever carries one; Octant reads which
   * agent threads it names and how they stand, not what they said.
   */
  Schema.Struct({
    type: Schema.Literal("collabAgentToolCall"),
    id: Schema.String,
    tool: Schema.String,
    status: Schema.String,
    receiverThreadIds: Schema.Array(Schema.String).pipe(Schema.maxItems(32)),
    prompt: Schema.optional(Schema.NullOr(Schema.String)),
    /** The model a `spawnAgent` call asked for, when it named one. */
    model: Schema.optional(Schema.NullOr(Schema.String)),
    agentsStates: Schema.optional(
      Schema.Record({
        key: Schema.String,
        /**
         * `message` is the agent's last answer once it completed, or its
         * error once it errored (codex-cli 0.164.0 `CollabAgentState`).
         */
        value: Schema.Struct({
          status: Schema.String,
          message: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      }),
    ),
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
  status: Schema.String,
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
  normalModelSlug: Schema.optional(NullableString),
  primary: Schema.optional(NullableRateLimitWindow),
  secondary: Schema.optional(NullableRateLimitWindow),
  rateLimitReachedType: Schema.optional(NullableString),
});
export type RateLimitSnapshot = typeof RateLimitSnapshot.Type;

/** Result of the account-scoped, non-generating rate-limit refresh request. */
const AccountRateLimitsReadResult = Schema.Struct({
  rateLimits: RateLimitSnapshot,
  ordinaryUsageAllowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  rateLimitsByLimitId: Schema.optional(
    Schema.NullOr(Schema.Record({ key: Schema.String, value: RateLimitSnapshot })),
  ),
});
export type CodexRateLimitsReadResult = typeof AccountRateLimitsReadResult.Type;
export const decodeAccountRateLimitsReadResult = decode(AccountRateLimitsReadResult);

/**
 * Account-scoped and therefore carrying no thread or turn: the app-server
 * sends it whenever the backend reports usage, not as part of a turn.
 */
const AccountRateLimitsNotification = Schema.Struct({
  rateLimits: RateLimitSnapshot,
});

/**
 * The reviewer's per-call notices. The app-server marks them unstable, so the
 * fields read here are the few the verdict needs and every one but the ids is
 * optional: a reshaped notice then degrades to a verdict with less detail
 * instead of failing the turn.
 */
const AutoReviewStartedNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  reviewId: Schema.String,
});

const AutoReviewCompletedNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  reviewId: Schema.String,
  targetItemId: Schema.optional(Schema.NullOr(Schema.String)),
  action: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      command: Schema.optional(Schema.NullOr(Schema.String)),
      program: Schema.optional(Schema.NullOr(Schema.String)),
      files: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      host: Schema.optional(Schema.NullOr(Schema.String)),
      toolName: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  review: Schema.Struct({
    status: Schema.String,
    rationale: Schema.optional(Schema.NullOr(Schema.String)),
    riskLevel: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const stableNotificationSchemas = {
  "turn/started": TurnStartedNotification,
  "turn/completed": TurnCompletedNotification,
  "item/started": ItemStartedNotification,
  "item/completed": ItemCompletedNotification,
  "item/autoApprovalReview/started": AutoReviewStartedNotification,
  "item/autoApprovalReview/completed": AutoReviewCompletedNotification,
  "item/agentMessage/delta": DeltaNotification,
  "item/plan/delta": DeltaNotification,
  "item/commandExecution/outputDelta": ToolProgressNotification,
  "item/mcpToolCall/progress": ToolProgressNotification,
  "item/fileChange/patchUpdated": ToolProgressNotification,
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
  } & (Method extends "turn/completed"
    ? {
        /**
         * The completion named its thread but no turn this build could read
         * (`readableTurnCompletion`): it ends whichever turn that thread is
         * running, and `params.turn.id` is empty.
         */
        readonly turnUnreadable?: true;
      }
    : unknown);
}[CodexStableNotificationMethod];

const stableNotificationDecoders: Record<
  CodexStableNotificationMethod,
  (value: unknown) => unknown
> = {
  "turn/started": decode(TurnStartedNotification),
  "turn/completed": decode(TurnCompletedNotification),
  "item/started": decode(ItemStartedNotification),
  "item/completed": decode(ItemCompletedNotification),
  "item/autoApprovalReview/started": decode(AutoReviewStartedNotification),
  "item/autoApprovalReview/completed": decode(AutoReviewCompletedNotification),
  "item/agentMessage/delta": decode(DeltaNotification),
  "item/plan/delta": decode(DeltaNotification),
  "item/commandExecution/outputDelta": decode(ToolProgressNotification),
  "item/mcpToolCall/progress": decode(ToolProgressNotification),
  "item/fileChange/patchUpdated": decode(ToolProgressNotification),
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

/** A function-shaped app tool registered on `thread/start`. */
const DynamicToolSpec = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Unknown,
  deferLoading: Schema.optional(Schema.Boolean),
});
export type CodexDynamicToolSpec = typeof DynamicToolSpec.Type;

/** A dynamic tool call the app-server sends back to its client. */
const DynamicToolCallParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  callId: Schema.String,
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  tool: Schema.String,
  arguments: Schema.Unknown,
});
export type CodexDynamicToolCallParams = typeof DynamicToolCallParams.Type;
export const decodeDynamicToolCallParams = decode(DynamicToolCallParams);

/**
 * Codex's own question form (`request_user_input`), which its Plan
 * collaboration mode offers the model. Codex answers with
 * `{ answers: { [questionId]: { answers: string[] } } }`; `isSecret` marks a
 * question whose answer Codex would mask (`ToolRequestUserInputParams` in the
 * app-server schema at `rust-v0.169.0`).
 */
const UserInputQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  isOther: Schema.optional(Schema.Boolean),
  isSecret: Schema.optional(Schema.Boolean),
  options: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
    ),
  ),
});
const UserInputRequestParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  questions: Schema.Array(UserInputQuestion),
});
export type CodexUserInputRequestParams = typeof UserInputRequestParams.Type;

const stableRequestSchemas = {
  "item/commandExecution/requestApproval": CommandApprovalParams,
  "item/fileChange/requestApproval": FileChangeApprovalParams,
  "item/permissions/requestApproval": PermissionsApprovalParams,
  "item/tool/call": DynamicToolCallParams,
  "item/tool/requestUserInput": UserInputRequestParams,
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
  "item/tool/call": decode(DynamicToolCallParams),
  "item/tool/requestUserInput": decode(UserInputRequestParams),
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

/**
 * A `turn/completed` whose params fail the schema, read by hand. It is the
 * one notification that ends a turn, so it is never dropped as other
 * unreadable notifications are: dropped, the turn stayed running until a
 * stall limit that may be off. With a thread and turn id it ends that turn:
 * failed when it carries an error of any shape or a status that is not text,
 * and by its status otherwise. With only the thread it fails that thread's
 * running turn. With no thread nothing says whose turn ended, so it throws
 * and the caller fails the stream, as every undecodable notification once did.
 */
function readableTurnCompletion(
  params: unknown,
): Extract<CodexServerNotification, { readonly method: "turn/completed" }> {
  if (!isRecord(params) || typeof params.threadId !== "string") {
    throw new TypeError("Codex turn completion names no thread");
  }
  const threadId = params.threadId;
  const turn = isRecord(params.turn) ? params.turn : undefined;
  if (turn === undefined || typeof turn.id !== "string") {
    return {
      kind: "notification",
      method: "turn/completed",
      params: { threadId, turn: { id: "", status: "failed" } },
      turnUnreadable: true,
    };
  }
  const hasError = turn.error !== undefined && turn.error !== null;
  if (!hasError) {
    return {
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turn.id, status: typeof turn.status === "string" ? turn.status : "failed" },
      },
    };
  }
  const reported = isRecord(turn.error) ? turn.error : {};
  return {
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turn.id,
        status: "failed",
        error: {
          message: typeof reported.message === "string" ? reported.message : "",
          ...(typeof reported.codexErrorInfo === "string"
            ? { codexErrorInfo: reported.codexErrorInfo }
            : {}),
        },
      },
    },
  };
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
      let params: unknown;
      try {
        params = stableRequestDecoders[stableMethod](value.params);
      } catch {
        // An approval, question or tool call this build cannot read is never
        // answered as allowed: Codex is told the request is not supported,
        // as for a method this build does not know, and the connection and
        // every other thread on it stay up.
        return { kind: "unsupported-request", id, method };
      }
      return { kind: "request", id, method: stableMethod, params } as CodexServerRequest;
    }
    return { kind: "unsupported-request", id, method };
  }

  if (hasOwn(stableNotificationSchemas, method)) {
    const stableMethod = method as CodexStableNotificationMethod;
    let params: unknown;
    try {
      params = stableNotificationDecoders[stableMethod](value.params);
    } catch {
      if (stableMethod === "turn/completed") return readableTurnCompletion(value.params);
      // One app-server process carries every thread, so a notification whose
      // shape a newer Codex changed is dropped like one this build does not
      // know. Failing it closed the connection under all of them.
      return { kind: "unknown-notification", method };
    }
    return { kind: "notification", method: stableMethod, params } as CodexServerNotification;
  }

  return { kind: "unknown-notification", method };
}
