import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";

import type {
  ClaudeAccountState,
  ClaudeAssistantContent,
  ClaudeDecodedMessage,
  ClaudeInitialization,
  ClaudeJsonValue,
  ClaudeModelInfo,
  ClaudeOpenQueryInput,
  ClaudePermissionMode,
  ClaudeResultSubtype,
  ClaudeSessionMetadata,
  ClaudeStreamEvent,
  ClaudeTaskUsage,
  ClaudeUsage,
} from "./claudeAgentSdkPort";

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const API_PROVIDERS = new Set([
  "firstParty",
  "bedrock",
  "vertex",
  "foundry",
  "anthropicAws",
  "mantle",
  "gateway",
]);

class ClaudePortError {
  constructor(readonly failure: ProviderFailure) {}
}

export function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

export function protocol(message = "Claude returned an invalid SDK response."): ClaudePortError {
  return new ClaudePortError(failure("protocol", message));
}

export function sanitizeFailure(error: unknown, operation: string): ProviderFailure {
  if (error instanceof ClaudePortError) return error.failure;
  return failure("provider-failed", `Claude ${operation} failed.`);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw protocol("Claude returned an unsupported runtime message.");
  return value;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const decoded = nonNegativeNumber(value);
  if (decoded === undefined) throw protocol("Claude returned an unsupported runtime message.");
  return decoded;
}

export function decodeInterruptReceipt(value: unknown): readonly string[] | undefined {
  const receipt = object(value);
  return receipt === undefined ? undefined : stringArray(receipt.still_queued);
}

function nullableTokenCount(value: unknown): number | undefined {
  if (value === null) return 0;
  return nonNegativeNumber(value);
}

function decodeUsage(value: unknown, nullableCache: boolean, nullableInput = false): ClaudeUsage {
  const usage = object(value);
  const inputTokens = nullableInput
    ? nullableTokenCount(usage?.input_tokens)
    : nonNegativeNumber(usage?.input_tokens);
  const outputTokens = nonNegativeNumber(usage?.output_tokens);
  const cacheCreationInputTokens = nullableCache
    ? nullableTokenCount(usage?.cache_creation_input_tokens)
    : nonNegativeNumber(usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = nullableCache
    ? nullableTokenCount(usage?.cache_read_input_tokens)
    : nonNegativeNumber(usage?.cache_read_input_tokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    cacheReadInputTokens === undefined
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
}

function decodeJsonValue(value: unknown, depth = 0): ClaudeJsonValue {
  if (depth > 16) throw protocol("Claude returned an unsupported runtime message.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => decodeJsonValue(entry, depth + 1));
  const record = object(value);
  if (record === undefined) throw protocol("Claude returned an unsupported runtime message.");
  const decoded: Record<string, ClaudeJsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    decoded[key] = decodeJsonValue(entry, depth + 1);
  }
  return decoded;
}

function decodeAssistantContent(
  value: unknown,
  allowedTools: readonly string[],
): ClaudeAssistantContent {
  const block = object(value);
  if (block === undefined || typeof block.type !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (block.type === "text") {
    if (
      typeof block.text !== "string" ||
      (block.citations !== null &&
        block.citations !== undefined &&
        (!Array.isArray(block.citations) || block.citations.length > 0))
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return { kind: "text", text: block.text };
  }
  if (block.type === "thinking") {
    if (typeof block.thinking !== "string" || typeof block.signature !== "string") {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return { kind: "reasoning", text: block.thinking };
  }
  if (block.type === "redacted_thinking") {
    if (typeof block.data !== "string") {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return { kind: "redacted-reasoning" };
  }
  if (block.type === "tool_use") {
    const decodedInput = decodeJsonValue(block.input);
    const decodedInputObject = object(decodedInput);
    if (
      typeof block.id !== "string" ||
      typeof block.name !== "string" ||
      !allowedTools.includes(block.name) ||
      decodedInputObject === undefined ||
      block.caller !== undefined
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "tool-use",
      toolUseId: block.id,
      toolName: block.name,
      input: decodedInputObject as { readonly [key: string]: ClaudeJsonValue },
    };
  }
  throw protocol("Claude returned an unsupported runtime message.");
}

const STREAM_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "compaction",
  "refusal",
  "model_context_window_exceeded",
]);

function decodeStreamEvent(value: unknown, allowedTools: readonly string[]): ClaudeStreamEvent {
  const event = object(value);
  if (event === undefined || typeof event.type !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (event.type === "message_start") {
    const message = object(event.message);
    if (
      message === undefined ||
      typeof message.id !== "string" ||
      typeof message.model !== "string" ||
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      message.content.length > 0
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "message-start",
      messageId: message.id,
      model: message.model,
      usage: decodeUsage(message.usage, true),
    };
  }
  if (event.type === "message_delta") {
    const delta = object(event.delta);
    if (
      delta === undefined ||
      (delta.stop_reason !== null &&
        (typeof delta.stop_reason !== "string" || !STREAM_STOP_REASONS.has(delta.stop_reason))) ||
      (delta.stop_sequence !== null && typeof delta.stop_sequence !== "string") ||
      delta.stop_details !== null ||
      delta.container !== null ||
      event.context_management !== null
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "message-delta",
      stopReason: delta.stop_reason,
      usage: decodeUsage(event.usage, true, true),
    };
  }
  if (event.type === "message_stop") return { kind: "message-stop" };
  const index = nonNegativeNumber(event.index);
  if (index === undefined || !Number.isInteger(index)) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (event.type === "content_block_start") {
    return {
      kind: "content-start",
      index,
      content: decodeAssistantContent(event.content_block, allowedTools),
    };
  }
  if (event.type === "content_block_stop") return { kind: "content-stop", index };
  if (event.type !== "content_block_delta") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  const delta = object(event.delta);
  if (delta === undefined || typeof delta.type !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return { kind: "text-delta", index, text: delta.text };
  }
  const estimatedTokens = nonNegativeNumber(delta.estimated_tokens);
  if (
    delta.type === "thinking_delta" &&
    typeof delta.thinking === "string" &&
    (delta.estimated_tokens === null || estimatedTokens !== undefined)
  ) {
    return {
      kind: "reasoning-delta",
      index,
      text: delta.thinking,
      ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
    };
  }
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return { kind: "tool-input-delta", index };
  }
  if (delta.type === "signature_delta" && typeof delta.signature === "string") {
    return { kind: "reasoning-signature", index };
  }
  if (delta.type === "citations_delta" && object(delta.citation) !== undefined) {
    return { kind: "citation-delta", index };
  }
  if (
    delta.type === "compaction_delta" &&
    (delta.content === null || typeof delta.content === "string") &&
    (delta.encrypted_content === null || typeof delta.encrypted_content === "string")
  ) {
    return { kind: "compaction-delta", index };
  }
  throw protocol("Claude returned an unsupported runtime message.");
}

function decodeToolResults(message: Record<string, unknown>): ClaudeDecodedMessage {
  const user = object(message.message);
  if (user === undefined || user.role !== "user" || message.parent_tool_use_id !== null) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (message.isReplay === true || typeof user.content === "string") return { kind: "ignored" };
  if (!Array.isArray(user.content) || typeof message.session_id !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  const results = user.content.map((value) => {
    const block = object(value);
    if (
      block === undefined ||
      block.type !== "tool_result" ||
      typeof block.tool_use_id !== "string" ||
      (block.is_error !== undefined && typeof block.is_error !== "boolean")
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return { toolUseId: block.tool_use_id, isError: block.is_error === true };
  });
  if (results.length === 0) throw protocol("Claude returned an unsupported runtime message.");
  return { kind: "tool-results", sessionId: message.session_id, results };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isHarmlessInformational(message: Record<string, unknown>): boolean {
  if (message.type === "keep_alive") return hasOnlyKeys(message, ["type"]);
  if (message.type === "prompt_suggestion") {
    return (
      hasOnlyKeys(message, ["type", "suggestion", "uuid", "session_id"]) &&
      typeof message.suggestion === "string" &&
      typeof message.uuid === "string" &&
      typeof message.session_id === "string"
    );
  }
  if (message.type !== "system") return false;
  if (message.subtype === "notification") {
    return (
      hasOnlyKeys(message, [
        "type",
        "subtype",
        "key",
        "text",
        "priority",
        "color",
        "timeout_ms",
        "uuid",
        "session_id",
      ]) &&
      typeof message.key === "string" &&
      typeof message.text === "string" &&
      (message.priority === "low" ||
        message.priority === "medium" ||
        message.priority === "high" ||
        message.priority === "immediate") &&
      (message.color === undefined || typeof message.color === "string") &&
      (message.timeout_ms === undefined || nonNegativeNumber(message.timeout_ms) !== undefined) &&
      typeof message.uuid === "string" &&
      typeof message.session_id === "string"
    );
  }
  if (message.subtype === "informational") {
    return (
      hasOnlyKeys(message, [
        "type",
        "subtype",
        "content",
        "level",
        "tool_use_id",
        "prevent_continuation",
        "uuid",
        "session_id",
      ]) &&
      typeof message.content === "string" &&
      (message.level === "info" ||
        message.level === "notice" ||
        message.level === "suggestion" ||
        message.level === "warning") &&
      (message.tool_use_id === undefined || typeof message.tool_use_id === "string") &&
      (message.prevent_continuation === undefined || message.prevent_continuation === false) &&
      typeof message.uuid === "string" &&
      typeof message.session_id === "string"
    );
  }
  return false;
}

export function decodeModels(value: unknown): readonly ClaudeModelInfo[] {
  if (!Array.isArray(value)) throw protocol();
  return value.map((entry) => {
    const model = object(entry);
    if (
      model === undefined ||
      typeof model.value !== "string" ||
      typeof model.displayName !== "string" ||
      typeof model.description !== "string" ||
      (model.resolvedModel !== undefined && typeof model.resolvedModel !== "string") ||
      (model.supportsEffort !== undefined && typeof model.supportsEffort !== "boolean") ||
      (model.supportedEffortLevels !== undefined &&
        (!Array.isArray(model.supportedEffortLevels) ||
          !model.supportedEffortLevels.every(
            (level) => typeof level === "string" && EFFORT_LEVELS.has(level),
          )))
    ) {
      throw protocol();
    }
    return {
      id: model.value,
      ...(model.resolvedModel === undefined ? {} : { resolvedId: model.resolvedModel }),
      displayName: model.displayName,
      description: model.description,
      supportsEffort: model.supportsEffort === true,
      supportedEffortLevels:
        model.supportedEffortLevels === undefined
          ? []
          : (model.supportedEffortLevels as ClaudeModelInfo["supportedEffortLevels"]),
    };
  });
}

export function decodeAccount(value: unknown): ClaudeAccountState {
  const account = object(value);
  if (
    account === undefined ||
    (account.apiProvider !== undefined &&
      (typeof account.apiProvider !== "string" || !API_PROVIDERS.has(account.apiProvider)))
  ) {
    throw protocol();
  }
  if (account.apiProvider === undefined) return { ready: true };
  return {
    ready: true,
    apiProvider: account.apiProvider as NonNullable<ClaudeAccountState["apiProvider"]>,
  };
}

export function decodeInitialization(value: unknown): ClaudeInitialization {
  const initialized = object(value);
  const commands = initialized === undefined ? undefined : stringArray(initialized.commands);
  const availableOutputStyles =
    initialized === undefined ? undefined : stringArray(initialized.available_output_styles);
  if (
    initialized === undefined ||
    !Array.isArray(initialized.agents) ||
    commands === undefined ||
    typeof initialized.output_style !== "string" ||
    availableOutputStyles === undefined
  ) {
    throw protocol();
  }
  if (
    initialized.agents.length > 0 ||
    commands.length > 0 ||
    initialized.output_style !== "default"
  ) {
    throw protocol("Claude initialized an unexpected runtime surface.");
  }
  return {
    models: decodeModels(initialized.models),
    account: decodeAccount(initialized.account),
  };
}

export function permissionMode(policy: ProviderExecutionPolicy): ClaudePermissionMode {
  if (policy === "full-access") return "bypassPermissions";
  if (policy === "plan") return "plan";
  return "default";
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function decodeInitializedMessage(
  message: Record<string, unknown>,
  input: ClaudeOpenQueryInput,
): ClaudeDecodedMessage {
  const agents = message.agents === undefined ? [] : stringArray(message.agents);
  const mcpServers = Array.isArray(message.mcp_servers) ? message.mcp_servers : undefined;
  const skills = stringArray(message.skills);
  const plugins = Array.isArray(message.plugins) ? message.plugins : undefined;
  const tools = stringArray(message.tools);
  const slashCommands = stringArray(message.slash_commands);
  const capabilities = message.capabilities === undefined ? [] : stringArray(message.capabilities);
  const expectedPermissionMode = permissionMode(input.executionPolicy);
  if (
    agents === undefined ||
    mcpServers === undefined ||
    skills === undefined ||
    plugins === undefined ||
    tools === undefined ||
    slashCommands === undefined ||
    capabilities === undefined ||
    typeof message.session_id !== "string" ||
    typeof message.cwd !== "string" ||
    typeof message.model !== "string" ||
    typeof message.permissionMode !== "string" ||
    typeof message.output_style !== "string" ||
    typeof message.claude_code_version !== "string"
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (
    message.cwd !== input.projectRoot ||
    message.model !== input.model ||
    message.permissionMode !== expectedPermissionMode ||
    (input.resumeSessionId !== undefined && message.session_id !== input.resumeSessionId) ||
    agents.length > 0 ||
    mcpServers.length > 0 ||
    skills.length > 0 ||
    plugins.length > 0 ||
    slashCommands.length > 0 ||
    message.output_style !== "default" ||
    !sameStrings(tools, input.tools)
  ) {
    throw protocol("Claude initialized an unexpected runtime surface.");
  }
  return {
    kind: "initialized",
    sessionId: message.session_id,
    projectRoot: message.cwd,
    model: message.model,
    permissionMode: expectedPermissionMode,
    tools,
    capabilities,
    runtimeVersion: message.claude_code_version,
  };
}

const RESULT_SUBTYPES = new Set<ClaudeResultSubtype>([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);

const TERMINAL_REASONS = new Set([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
  "api_error",
  "malformed_tool_use_exhausted",
  "aborted_streaming",
  "aborted_tools",
  "stop_hook_prevented",
  "hook_stopped",
  "tool_deferred",
  "max_turns",
  "completed",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
]);

const ASSISTANT_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);

const RATE_LIMIT_TYPES = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);

const TASK_NOTIFICATION_STATUSES = new Set(["completed", "failed", "stopped"]);
const TASK_UPDATE_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "killed",
  "paused",
]);

function decodeTaskUsage(value: unknown): ClaudeTaskUsage {
  const usage = object(value);
  const totalTokens = nonNegativeNumber(usage?.total_tokens);
  const toolUses = nonNegativeNumber(usage?.tool_uses);
  const durationMs = nonNegativeNumber(usage?.duration_ms);
  if (
    totalTokens === undefined ||
    toolUses === undefined ||
    !Number.isInteger(toolUses) ||
    durationMs === undefined
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return { totalTokens, toolUses, durationMs };
}

function decodeResult(
  message: Record<string, unknown>,
  allowedTools: readonly string[],
): ClaudeDecodedMessage {
  const usage = decodeUsage(message.usage, false);
  const durationMs = nonNegativeNumber(message.duration_ms);
  const permissionDenials = Array.isArray(message.permission_denials)
    ? message.permission_denials.map((entry) => object(entry))
    : undefined;
  if (
    typeof message.session_id !== "string" ||
    typeof message.subtype !== "string" ||
    !RESULT_SUBTYPES.has(message.subtype as ClaudeResultSubtype) ||
    typeof message.uuid !== "string" ||
    durationMs === undefined ||
    nonNegativeNumber(message.duration_api_ms) === undefined ||
    nonNegativeNumber(message.num_turns) === undefined ||
    !Number.isInteger(message.num_turns) ||
    nonNegativeNumber(message.total_cost_usd) === undefined ||
    typeof message.is_error !== "boolean" ||
    (message.subtype === "success" && (message.is_error || typeof message.result !== "string")) ||
    (message.subtype !== "success" &&
      (!message.is_error ||
        !Array.isArray(message.errors) ||
        !message.errors.every((entry) => typeof entry === "string"))) ||
    (message.stop_reason !== null && typeof message.stop_reason !== "string") ||
    (message.terminal_reason !== undefined &&
      (typeof message.terminal_reason !== "string" ||
        !TERMINAL_REASONS.has(message.terminal_reason))) ||
    object(message.modelUsage) === undefined ||
    permissionDenials === undefined ||
    permissionDenials.some(
      (entry) =>
        entry === undefined ||
        typeof entry.tool_name !== "string" ||
        !allowedTools.includes(entry.tool_name) ||
        typeof entry.tool_use_id !== "string" ||
        object(decodeJsonValue(entry.tool_input)) === undefined,
    )
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return {
    kind: "result",
    sessionId: message.session_id,
    outcome: message.subtype === "success" ? "success" : "error",
    subtype: message.subtype as ClaudeResultSubtype,
    stopReason: message.stop_reason,
    ...(typeof message.terminal_reason === "string"
      ? { terminalReason: message.terminal_reason }
      : {}),
    durationMs,
    usage,
    // Claude states the turn's price itself. Carrying it through is the only
    // way Octant can show a cost: it holds no price list of its own.
    totalCostUsd: message.total_cost_usd as number,
    permissionDenials: permissionDenials.map((entry) => ({
      toolName: entry!.tool_name as string,
      toolUseId: entry!.tool_use_id as string,
    })),
  };
}

export type ClaudeDecodePhase =
  | { readonly kind: "initializing" }
  | { readonly kind: "active"; readonly sessionId: string };

export function decodeMessage(
  value: unknown,
  input: ClaudeOpenQueryInput,
  phase: ClaudeDecodePhase,
): ClaudeDecodedMessage {
  const message = object(value);
  if (message === undefined || typeof message.type !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  const isInitialization = message.type === "system" && message.subtype === "init";
  if (phase.kind === "initializing") {
    if (!isInitialization) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return decodeInitializedMessage(message, input);
  }
  if (
    isInitialization ||
    (message.type !== "keep_alive" && message.session_id !== phase.sessionId)
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (message.subagent_type !== undefined || message.task_description !== undefined) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (message.type === "assistant") {
    const assistant = object(message.message);
    if (
      assistant === undefined ||
      typeof assistant.id !== "string" ||
      assistant.type !== "message" ||
      assistant.role !== "assistant" ||
      typeof assistant.model !== "string" ||
      !Array.isArray(assistant.content) ||
      assistant.container !== null ||
      assistant.context_management !== null ||
      assistant.diagnostics !== null ||
      assistant.stop_details !== null ||
      (assistant.stop_reason !== null &&
        (typeof assistant.stop_reason !== "string" ||
          !STREAM_STOP_REASONS.has(assistant.stop_reason))) ||
      (assistant.stop_sequence !== null && typeof assistant.stop_sequence !== "string") ||
      typeof message.session_id !== "string" ||
      message.parent_tool_use_id !== null ||
      (message.error !== undefined &&
        (typeof message.error !== "string" || !ASSISTANT_ERRORS.has(message.error)))
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "assistant",
      sessionId: message.session_id,
      messageId: assistant.id,
      ...(message.error === undefined ? {} : { error: message.error }),
      content: assistant.content.map((content) => decodeAssistantContent(content, input.tools)),
      usage: decodeUsage(assistant.usage, true),
    };
  }
  if (message.type === "stream_event") {
    if (typeof message.session_id !== "string" || message.parent_tool_use_id !== null) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "stream-event",
      sessionId: message.session_id,
      event: decodeStreamEvent(message.event, input.tools),
    };
  }
  if (message.type === "user") return decodeToolResults(message);
  if (message.type === "result") return decodeResult(message, input.tools);
  if (message.type === "tool_progress") {
    const elapsedSeconds = nonNegativeNumber(message.elapsed_time_seconds);
    if (
      typeof message.session_id !== "string" ||
      typeof message.tool_use_id !== "string" ||
      typeof message.tool_name !== "string" ||
      !input.tools.includes(message.tool_name) ||
      elapsedSeconds === undefined ||
      message.parent_tool_use_id !== null ||
      (message.task_id !== undefined && typeof message.task_id !== "string")
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "tool-progress",
      sessionId: message.session_id,
      toolUseId: message.tool_use_id,
      toolName: message.tool_name,
      elapsedSeconds,
      ...(typeof message.task_id === "string" ? { taskId: message.task_id } : {}),
    };
  }
  if (message.type === "tool_use_summary") {
    const toolUseIds = stringArray(message.preceding_tool_use_ids);
    if (
      typeof message.session_id !== "string" ||
      typeof message.summary !== "string" ||
      toolUseIds === undefined
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "tool-summary",
      sessionId: message.session_id,
      summary: message.summary,
      toolUseIds,
    };
  }
  if (message.type === "rate_limit_event") {
    const info = object(message.rate_limit_info);
    const resetsAt = optionalNonNegativeNumber(info?.resetsAt);
    const utilization = optionalNonNegativeNumber(info?.utilization);
    if (
      typeof message.session_id !== "string" ||
      info === undefined ||
      (info.status !== "allowed" &&
        info.status !== "allowed_warning" &&
        info.status !== "rejected") ||
      (info.rateLimitType !== undefined &&
        (typeof info.rateLimitType !== "string" || !RATE_LIMIT_TYPES.has(info.rateLimitType)))
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "rate-limit",
      sessionId: message.session_id,
      status: info.status,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(typeof info.rateLimitType === "string" ? { rateLimitType: info.rateLimitType } : {}),
      ...(utilization === undefined ? {} : { utilization }),
    };
  }
  if (message.type === "auth_status") {
    if (
      typeof message.session_id !== "string" ||
      typeof message.isAuthenticating !== "boolean" ||
      stringArray(message.output) === undefined ||
      (message.error !== undefined && typeof message.error !== "string")
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "authentication",
      sessionId: message.session_id,
      authenticating: message.isAuthenticating,
      failed: typeof message.error === "string",
    };
  }
  if (message.type === "system" && message.subtype === "status") {
    const mode = message.permissionMode;
    if (
      typeof message.session_id !== "string" ||
      (message.status !== null &&
        message.status !== "compacting" &&
        message.status !== "requesting") ||
      (mode !== undefined &&
        ((mode !== "default" && mode !== "bypassPermissions" && mode !== "plan") ||
          mode !== permissionMode(input.executionPolicy))) ||
      (message.compact_result !== undefined &&
        message.compact_result !== "success" &&
        message.compact_result !== "failed") ||
      (message.compact_error !== undefined && typeof message.compact_error !== "string")
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "status",
      sessionId: message.session_id,
      status: message.status,
      ...(mode === "default" || mode === "bypassPermissions" || mode === "plan"
        ? { permissionMode: mode }
        : {}),
    };
  }
  if (
    message.type === "system" &&
    (message.subtype === "task_started" ||
      message.subtype === "task_updated" ||
      message.subtype === "task_progress" ||
      message.subtype === "task_notification")
  ) {
    if (
      typeof message.session_id !== "string" ||
      typeof message.task_id !== "string" ||
      typeof message.uuid !== "string" ||
      (message.tool_use_id !== undefined && typeof message.tool_use_id !== "string")
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    let status: string | undefined;
    let description: string | undefined;
    let summary: string | undefined;
    let usage: ClaudeTaskUsage | undefined;
    if (message.subtype === "task_started") {
      if (
        typeof message.description !== "string" ||
        message.subagent_type !== undefined ||
        message.task_type !== undefined ||
        message.workflow_name !== undefined ||
        message.prompt !== undefined ||
        (message.skip_transcript !== undefined && message.skip_transcript !== false)
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      description = message.description;
    } else if (message.subtype === "task_progress") {
      if (
        typeof message.description !== "string" ||
        message.subagent_type !== undefined ||
        (message.last_tool_name !== undefined && typeof message.last_tool_name !== "string") ||
        (message.summary !== undefined && typeof message.summary !== "string")
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      description = message.description;
      summary = optionalString(message.summary);
      usage = decodeTaskUsage(message.usage);
    } else if (message.subtype === "task_notification") {
      if (
        typeof message.status !== "string" ||
        !TASK_NOTIFICATION_STATUSES.has(message.status) ||
        typeof message.output_file !== "string" ||
        typeof message.summary !== "string" ||
        (message.skip_transcript !== undefined && message.skip_transcript !== false)
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      status = message.status;
      summary = message.summary;
      if (message.usage !== undefined) usage = decodeTaskUsage(message.usage);
    } else {
      const patch = object(message.patch);
      if (
        patch === undefined ||
        (patch.status !== undefined &&
          (typeof patch.status !== "string" || !TASK_UPDATE_STATUSES.has(patch.status))) ||
        (patch.description !== undefined && typeof patch.description !== "string") ||
        (patch.error !== undefined && typeof patch.error !== "string") ||
        (patch.is_backgrounded !== undefined && patch.is_backgrounded !== false)
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      optionalNonNegativeNumber(patch.end_time);
      optionalNonNegativeNumber(patch.total_paused_ms);
      status = optionalString(patch.status);
      description = optionalString(patch.description);
    }
    return {
      kind: "task",
      sessionId: message.session_id,
      subtype: message.subtype,
      taskId: message.task_id,
      ...(typeof message.tool_use_id === "string" ? { toolUseId: message.tool_use_id } : {}),
      ...(status === undefined ? {} : { status }),
      ...(description === undefined ? {} : { description }),
      ...(summary === undefined ? {} : { summary }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  if (isHarmlessInformational(message)) return { kind: "ignored" };
  throw protocol("Claude returned an unsupported runtime message.");
}

export function decodeSessions(
  value: unknown,
  expectedRoot: string,
): readonly ClaudeSessionMetadata[] {
  if (!Array.isArray(value)) throw protocol();
  return value.flatMap((entry) => {
    const session = object(entry);
    if (
      session === undefined ||
      typeof session.sessionId !== "string" ||
      typeof session.lastModified !== "number" ||
      (session.createdAt !== undefined && typeof session.createdAt !== "number") ||
      (session.cwd !== undefined && typeof session.cwd !== "string")
    ) {
      throw protocol();
    }
    if (session.cwd !== expectedRoot) return [];
    return [
      {
        sessionId: session.sessionId,
        projectRoot: session.cwd,
        lastModified: session.lastModified,
        ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
      },
    ];
  });
}
