import type {
  CorrelationId,
  ProviderFailure,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSessionId,
  UtcTimestamp,
} from "@octant/contracts";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ClaudeAssistantContent,
  ClaudeDecodedMessage,
  ClaudeJsonValue,
  ClaudeTaskUsage,
  ClaudeToolRequest,
  ClaudeUsage,
} from "./claudeAgentSdkPort";

const STREAM_CHUNK_CHARACTERS = 65_536;
const DIFF_MAX_CHARACTERS = 65_536;
const LABEL_MAX_CHARACTERS = 256;
const SUMMARY_MAX_CHARACTERS = 1_024;
const PATH_MAX_CHARACTERS = 4_096;
const DIGEST_INPUT_MAX_CHARACTERS = 1_048_576;
const MAX_RETRY_AFTER_MS = 3_600_000;
const DECODED_MESSAGE_KINDS = new Set([
  "initialized",
  "assistant",
  "stream-event",
  "tool-results",
  "result",
  "tool-progress",
  "tool-summary",
  "task",
  "rate-limit",
  "authentication",
  "status",
  "ignored",
]);

interface ClaudeFileChange {
  readonly path: string;
  readonly change: "modified";
  readonly diff: string;
  readonly successSummary: string;
}

export interface ClaudeToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly emitsActivity: boolean;
  lifecycle: "active" | "terminal";
  fileChange?: ClaudeFileChange;
}

export interface ClaudeRequestCorrelation {
  readonly kind: "approval" | "question";
  readonly toolName: string;
  readonly providerSessionId: string;
  readonly providerToolUseId: string;
  readonly inputDigest: string;
  readonly requestId: string;
}

export interface ClaudeTaskState {
  readonly taskId: string;
  readonly lifecycle: "pending" | "running" | "paused" | "completed" | "failed";
  readonly lastSubtype: "task_started" | "task_updated" | "task_progress" | "task_notification";
  readonly summary: string;
}

export interface ClaudeEventContext {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly correlationId: CorrelationId;
  readonly occurredAt: UtcTimestamp;
  readonly projectRoot: string;
  readonly isProjectConfinedPath: (absolutePath: string) => boolean;
  readonly claudeSessionId: string;
  sequence: number;
  terminal: boolean;
  readonly requestIds: Map<string, ClaudeRequestCorrelation>;
  readonly taskIds: Map<string, ClaudeTaskState>;
  readonly toolStates: Map<string, ClaudeToolState>;
  readonly makeRequestId: () => string;
  readonly makeTaskId: () => string;
  readonly makeToolCallId: () => string;
}

interface ClaudePendingRequestBase {
  readonly requestId: string;
  readonly providerSessionId: string;
  readonly providerToolUseId: string;
  readonly inputDigest: string;
  readonly event: ProviderRuntimeEvent;
}

export interface ClaudePendingApproval extends ClaudePendingRequestBase {
  readonly kind: "approval";
  readonly toolName: string;
}

export interface ClaudePendingQuestion extends ClaudePendingRequestBase {
  readonly kind: "question";
}

export type ClaudeMappedMessage =
  | { readonly kind: "event"; readonly event: ProviderRuntimeEvent }
  | { readonly kind: "approval"; readonly request: ClaudePendingApproval }
  | { readonly kind: "question"; readonly request: ClaudePendingQuestion }
  | { readonly kind: "ignored" }
  | { readonly kind: "failure"; readonly failure: ProviderFailure };

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

function failure(message: string, category: ProviderFailure["category"] = "protocol") {
  return { kind: "failure", failure: { category, message } } as const;
}

function mappedEvent(
  context: ClaudeEventContext,
  value: RuntimeEventWithoutEnvelope,
): ProviderRuntimeEvent {
  const event = {
    ...value,
    instanceId: context.instanceId,
    sessionId: context.sessionId,
    sequence: context.sequence,
    correlationId: context.correlationId,
    occurredAt: context.occurredAt,
  } as ProviderRuntimeEvent;
  context.sequence += 1;
  return event;
}

function event(
  context: ClaudeEventContext,
  value: RuntimeEventWithoutEnvelope,
): ClaudeMappedMessage {
  return { kind: "event", event: mappedEvent(context, value) };
}

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value);
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

function normalized(value: string, maximum: number): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : truncate(trimmed, maximum);
}

function streamedEvents(
  context: ClaudeEventContext,
  kind: "text-delta" | "reasoning-delta",
  text: string,
): ReadonlyArray<ClaudeMappedMessage> {
  if (text.length === 0) return [{ kind: "ignored" }];
  const characters = Array.from(text);
  const results: ClaudeMappedMessage[] = [];
  for (let index = 0; index < characters.length; index += STREAM_CHUNK_CHARACTERS) {
    results.push(
      event(context, {
        kind,
        text: characters.slice(index, index + STREAM_CHUNK_CHARACTERS).join(""),
      }),
    );
  }
  return results;
}

function usageEvent(
  context: ClaudeEventContext,
  value: ClaudeUsage,
  providerExecutionDurationMs?: number,
  costUsd?: number,
): ClaudeMappedMessage {
  return event(context, {
    kind: "usage",
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadInputTokens: value.cacheReadInputTokens,
    cacheWriteInputTokens: value.cacheCreationInputTokens,
    ...(providerExecutionDurationMs === undefined ? {} : { providerExecutionDurationMs }),
    ...(costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0 ? {} : { costUsd }),
  });
}

function isSafeUsageValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function usageIsSafe(value: ClaudeUsage): boolean {
  return (
    isSafeUsageValue(value.inputTokens) &&
    isSafeUsageValue(value.outputTokens) &&
    isSafeUsageValue(value.cacheCreationInputTokens) &&
    isSafeUsageValue(value.cacheReadInputTokens)
  );
}

function taskUsageIsSafe(value: ClaudeTaskUsage): boolean {
  return (
    isSafeUsageValue(value.totalTokens) &&
    isSafeUsageValue(value.toolUses) &&
    isSafeUsageValue(value.durationMs)
  );
}

function terminal(
  context: ClaudeEventContext,
  value: RuntimeEventWithoutEnvelope,
): ClaudeMappedMessage {
  context.terminal = true;
  return event(context, value);
}

function confinedRelativePath(context: ClaudeEventContext, value: string): string | undefined {
  const root = resolve(context.projectRoot);
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const confined = relative(root, target);
  if (
    confined.length === 0 ||
    isAbsolute(confined) ||
    confined === ".." ||
    confined.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  try {
    if (!context.isProjectConfinedPath(target)) return undefined;
  } catch {
    return undefined;
  }
  const portable = confined.split(sep).join("/");
  return portable.length <= PATH_MAX_CHARACTERS ? portable : undefined;
}

function jsonString(
  input: { readonly [key: string]: ClaudeJsonValue },
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function contentShape(value: string): string {
  const lines = value.split("\n").length;
  const characters = Array.from(value).length;
  return `${lines} ${lines === 1 ? "line" : "lines"}, ${characters} ${characters === 1 ? "character" : "characters"}`;
}

function fileChange(
  context: ClaudeEventContext,
  content: Extract<ClaudeAssistantContent, { readonly kind: "tool-use" }>,
): ClaudeFileChange | undefined {
  if (content.toolName !== "Edit" && content.toolName !== "Write") return undefined;
  const pathValue = jsonString(content.input, "file_path");
  const path = pathValue === undefined ? undefined : confinedRelativePath(context, pathValue);
  if (path === undefined) return undefined;
  if (content.toolName === "Edit") {
    const previous = jsonString(content.input, "old_string");
    const replacement = jsonString(content.input, "new_string");
    if (previous === undefined || replacement === undefined) return undefined;
    return {
      path,
      change: "modified",
      diff: truncate(
        `--- a/${path}\n+++ b/${path}\n@@ Claude Edit (content redacted) @@\n- [previous content redacted: ${contentShape(previous)}]\n+ [replacement content redacted: ${contentShape(replacement)}]`,
        DIFF_MAX_CHARACTERS,
      ),
      successSummary: "File edit completed.",
    };
  }
  const replacement = jsonString(content.input, "content");
  if (replacement === undefined) return undefined;
  return {
    path,
    change: "modified",
    diff: truncate(
      `--- a/${path}\n+++ b/${path}\n@@ Claude Write (content redacted) @@\n+ [written content redacted: ${contentShape(replacement)}]`,
      DIFF_MAX_CHARACTERS,
    ),
    successSummary: "File write completed.",
  };
}

function toolState(
  context: ClaudeEventContext,
  providerToolUseId: string,
  toolName: string,
): { readonly state: ClaudeToolState; readonly created: boolean } | undefined {
  const existing = context.toolStates.get(providerToolUseId);
  if (existing !== undefined) {
    return existing.toolName === normalized(toolName, LABEL_MAX_CHARACTERS)
      ? { state: existing, created: false }
      : undefined;
  }
  const normalizedToolName = normalized(toolName, LABEL_MAX_CHARACTERS);
  if (normalizedToolName === undefined) return undefined;
  const state: ClaudeToolState = {
    toolCallId: context.makeToolCallId(),
    toolName: normalizedToolName,
    emitsActivity: toolName !== "AskUserQuestion",
    lifecycle: "active",
  };
  context.toolStates.set(providerToolUseId, state);
  return { state, created: true };
}

function mapToolUse(
  context: ClaudeEventContext,
  content: Extract<ClaudeAssistantContent, { readonly kind: "tool-use" }>,
  authoritativeInput: boolean,
  authoritativeFileChange?: ClaudeFileChange,
): ReadonlyArray<ClaudeMappedMessage> {
  const resolved = toolState(context, content.toolUseId, content.toolName);
  if (resolved === undefined) {
    return [failure("Claude returned invalid tool correlation metadata.")];
  }
  if (resolved.state.lifecycle === "terminal") {
    return [failure("Claude returned tool activity after completion.")];
  }
  if (authoritativeInput && (content.toolName === "Edit" || content.toolName === "Write")) {
    if (authoritativeFileChange === undefined) {
      return [failure("Claude returned invalid file-change metadata.")];
    }
    if (resolved.state.fileChange !== undefined) {
      return [failure("Claude returned duplicate authoritative file metadata.")];
    }
    resolved.state.fileChange = authoritativeFileChange;
  }
  if (!resolved.created || !resolved.state.emitsActivity) return [{ kind: "ignored" }];
  return [
    event(context, {
      kind: "tool-start",
      toolCallId: resolved.state.toolCallId,
      toolName: resolved.state.toolName,
    }),
  ];
}

function withoutIgnored(
  results: ReadonlyArray<ClaudeMappedMessage>,
): ReadonlyArray<ClaudeMappedMessage> {
  const meaningful = results.filter((result) => result.kind !== "ignored");
  return meaningful.length === 0 ? [{ kind: "ignored" }] : meaningful;
}

function mapAssistant(
  context: ClaudeEventContext,
  message: Extract<ClaudeDecodedMessage, { readonly kind: "assistant" }>,
): ReadonlyArray<ClaudeMappedMessage> {
  if (!usageIsSafe(message.usage)) {
    return [failure("Claude returned invalid usage metadata.")];
  }
  const messageToolNames = new Map<string, string>();
  const fileChanges = new Map<string, ClaudeFileChange>();
  for (const content of message.content) {
    if (content.kind !== "tool-use") continue;
    const existing = context.toolStates.get(content.toolUseId);
    const messageToolName = messageToolNames.get(content.toolUseId);
    const normalizedToolName = normalized(content.toolName, LABEL_MAX_CHARACTERS);
    const authoritativeFileTool = content.toolName === "Edit" || content.toolName === "Write";
    if (messageToolName !== undefined) {
      const duplicateAuthoritativeFileTool =
        authoritativeFileTool || messageToolName === "Edit" || messageToolName === "Write";
      return [
        failure(
          duplicateAuthoritativeFileTool
            ? "Claude returned duplicate authoritative file metadata."
            : "Claude returned invalid tool correlation metadata.",
        ),
      ];
    }
    if (
      normalizedToolName === undefined ||
      (existing !== undefined &&
        (existing.toolName !== normalizedToolName || existing.lifecycle !== "active"))
    ) {
      return [failure("Claude returned invalid tool correlation metadata.")];
    }
    if (authoritativeFileTool && existing?.fileChange !== undefined) {
      return [failure("Claude returned duplicate authoritative file metadata.")];
    }
    messageToolNames.set(content.toolUseId, content.toolName);
  }
  for (const content of message.content) {
    if (content.kind !== "tool-use") continue;
    if (content.toolName === "Edit" || content.toolName === "Write") {
      const metadata = fileChange(context, content);
      if (metadata === undefined) {
        return [failure("Claude returned invalid file-change metadata.")];
      }
      fileChanges.set(content.toolUseId, metadata);
    }
  }
  const results: ClaudeMappedMessage[] = [];
  for (const content of message.content) {
    if (content.kind !== "tool-use") continue;
    results.push(...mapToolUse(context, content, true, fileChanges.get(content.toolUseId)));
  }
  results.push(usageEvent(context, message.usage));
  if (message.error !== undefined) {
    if (context.terminal) return [failure("Claude returned a duplicate terminal message.")];
    const category: ProviderFailure["category"] =
      message.error === "authentication_failed" || message.error === "oauth_org_not_allowed"
        ? "unauthenticated"
        : message.error === "rate_limit"
          ? "rate-limited"
          : "provider-failed";
    const failureMessage =
      category === "unauthenticated"
        ? "Claude authentication is required."
        : category === "rate-limited"
          ? "Claude is temporarily rate limited."
          : "Claude execution failed.";
    results.push(
      terminal(context, { kind: "failed", failure: { category, message: failureMessage } }),
    );
  }
  return withoutIgnored(results);
}

function mapToolResults(
  context: ClaudeEventContext,
  message: Extract<ClaudeDecodedMessage, { readonly kind: "tool-results" }>,
): ReadonlyArray<ClaudeMappedMessage> {
  const providerToolUseIds = new Set<string>();
  for (const result of message.results) {
    if (providerToolUseIds.has(result.toolUseId)) {
      return [failure("Claude returned duplicate or contradictory tool results.")];
    }
    providerToolUseIds.add(result.toolUseId);
  }
  const states = message.results.map((result) => ({
    result,
    state: context.toolStates.get(result.toolUseId),
  }));
  if (states.some(({ state }) => state === undefined)) {
    return [failure("Claude tool result did not match an active tool.")];
  }
  if (states.some(({ state }) => state?.lifecycle !== "active")) {
    return [failure("Claude returned a duplicate tool result.")];
  }
  const results: ClaudeMappedMessage[] = [];
  for (const pair of states) {
    const state = pair.state!;
    state.lifecycle = "terminal";
    if (!state.emitsActivity) continue;
    if (pair.result.isError) {
      results.push(
        event(context, {
          kind: "tool-failure",
          toolCallId: state.toolCallId,
          message: "Tool failed.",
        }),
      );
      continue;
    }
    if (state.fileChange !== undefined) {
      results.push(
        event(context, {
          kind: "file-change",
          path: state.fileChange.path,
          change: state.fileChange.change,
        }),
        event(context, { kind: "diff", diff: state.fileChange.diff }),
        event(context, {
          kind: "tool-success",
          toolCallId: state.toolCallId,
          summary: state.fileChange.successSummary,
        }),
      );
      continue;
    }
    results.push(
      event(context, {
        kind: "tool-success",
        toolCallId: state.toolCallId,
        summary: "Tool completed.",
      }),
    );
  }
  return withoutIgnored(results);
}

function resultMetadataIsValid(
  message: Extract<ClaudeDecodedMessage, { readonly kind: "result" }>,
): boolean {
  const noPermissionDenials = message.permissionDenials.length === 0;
  if (message.subtype === "success") {
    return (
      message.outcome === "success" &&
      noPermissionDenials &&
      (message.terminalReason === undefined || message.terminalReason === "completed")
    );
  }
  if (message.outcome !== "error") return false;
  if (message.subtype === "error_during_execution") {
    return (
      message.terminalReason !== "completed" &&
      message.terminalReason !== "max_turns" &&
      message.terminalReason !== "budget_exhausted" &&
      message.terminalReason !== "structured_output_retry_exhausted"
    );
  }
  if (!noPermissionDenials) return false;
  if (message.subtype === "error_max_turns") {
    return message.terminalReason === undefined || message.terminalReason === "max_turns";
  }
  if (message.subtype === "error_max_budget_usd") {
    return message.terminalReason === undefined || message.terminalReason === "budget_exhausted";
  }
  return (
    message.terminalReason === undefined ||
    message.terminalReason === "structured_output_retry_exhausted"
  );
}

const TASK_UPDATE_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "killed",
  "paused",
]);
const TASK_NOTIFICATION_STATUSES = new Set(["completed", "failed", "stopped"]);

function taskMessageShapeIsValid(
  message: Extract<ClaudeDecodedMessage, { readonly kind: "task" }>,
): boolean {
  switch (message.subtype) {
    case "task_started":
      return (
        message.status === undefined &&
        typeof message.description === "string" &&
        message.summary === undefined &&
        message.usage === undefined
      );
    case "task_progress":
      return (
        message.status === undefined &&
        typeof message.description === "string" &&
        message.usage !== undefined
      );
    case "task_notification":
      return (
        typeof message.status === "string" &&
        TASK_NOTIFICATION_STATUSES.has(message.status) &&
        message.description === undefined &&
        typeof message.summary === "string"
      );
    case "task_updated":
      return (
        (message.status === undefined || TASK_UPDATE_STATUSES.has(message.status)) &&
        message.summary === undefined &&
        message.usage === undefined
      );
    default:
      return false;
  }
}

function normalizedTaskStatus(
  lifecycle: ClaudeTaskState["lifecycle"],
): "pending" | "in-progress" | "completed" | "failed" {
  if (lifecycle === "completed" || lifecycle === "failed") return lifecycle;
  return lifecycle === "running" ? "in-progress" : "pending";
}

function mapTask(
  context: ClaudeEventContext,
  message: Extract<ClaudeDecodedMessage, { readonly kind: "task" }>,
): ReadonlyArray<ClaudeMappedMessage> {
  if (message.usage !== undefined && !taskUsageIsSafe(message.usage)) {
    return [failure("Claude returned invalid usage metadata.")];
  }
  if (!taskMessageShapeIsValid(message)) {
    return [failure("Claude returned an invalid task lifecycle transition.")];
  }
  const existing = context.taskIds.get(message.taskId);
  const providedSummary = normalized(
    message.summary ?? message.description ?? "",
    SUMMARY_MAX_CHARACTERS,
  );
  let next: ClaudeTaskState | undefined;
  if (message.subtype === "task_started") {
    if (existing !== undefined || providedSummary === undefined) {
      return [failure("Claude returned an invalid task lifecycle transition.")];
    }
    next = {
      taskId: context.makeTaskId(),
      lifecycle: "running",
      lastSubtype: message.subtype,
      summary: providedSummary,
    };
  } else {
    if (existing === undefined) {
      return [failure("Claude returned an invalid task lifecycle transition.")];
    }
    const summary = providedSummary ?? existing.summary;
    if (existing.lifecycle === "completed" || existing.lifecycle === "failed") {
      const repeatedTerminal =
        message.subtype === "task_notification" &&
        (message.status === "completed" ? "completed" : "failed") === existing.lifecycle;
      return repeatedTerminal
        ? [{ kind: "ignored" }]
        : [failure("Claude returned an invalid task lifecycle transition.")];
    }
    if (message.subtype === "task_progress") {
      if (existing.lifecycle !== "running") {
        return [failure("Claude returned an invalid task lifecycle transition.")];
      }
      next = { ...existing, lastSubtype: message.subtype, summary };
    } else if (message.subtype === "task_notification") {
      next = {
        ...existing,
        lifecycle: message.status === "completed" ? "completed" : "failed",
        lastSubtype: message.subtype,
        summary,
      };
    } else {
      let lifecycle: ClaudeTaskState["lifecycle"] = existing.lifecycle;
      switch (message.status) {
        case undefined:
          break;
        case "running":
          lifecycle = "running";
          break;
        case "paused":
          if (existing.lifecycle !== "running") {
            return [failure("Claude returned an invalid task lifecycle transition.")];
          }
          lifecycle = "paused";
          break;
        case "pending":
          if (existing.lifecycle !== "pending") {
            return [failure("Claude returned an invalid task lifecycle transition.")];
          }
          break;
        case "completed":
          lifecycle = "completed";
          break;
        case "failed":
        case "killed":
          lifecycle = "failed";
          break;
        default:
          return [failure("Claude returned an invalid task lifecycle transition.")];
      }
      next = { ...existing, lifecycle, lastSubtype: message.subtype, summary };
    }
  }
  context.taskIds.set(message.taskId, next);
  return [
    event(context, {
      kind: "task-progress",
      taskId: next.taskId,
      status: normalizedTaskStatus(next.lifecycle),
      summary: next.summary,
    }),
  ];
}

/**
 * Claude's own window facts, normalized. A message that names no window is
 * dropped rather than reported under an invented name: only the provider
 * decides what a window covers.
 */
function rateLimitWindowEvent(
  context: ClaudeEventContext,
  message: Extract<ClaudeDecodedMessage, { readonly kind: "rate-limit" }>,
): ClaudeMappedMessage | undefined {
  const window = normalized(message.rateLimitType ?? "", LABEL_MAX_CHARACTERS);
  if (window === undefined || window.length === 0) return undefined;
  const utilization = message.utilization;
  const resetsAt = resetTimestamp(message.resetsAt);
  return event(context, {
    kind: "rate-limit-window",
    window,
    status:
      message.status === "rejected"
        ? "exhausted"
        : message.status === "allowed_warning"
          ? "warning"
          : "allowed",
    ...(utilization === undefined || !Number.isFinite(utilization) || utilization < 0
      ? {}
      : { utilization: Math.min(utilization, 1) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
}

/** Claude reports a reset instant in seconds or milliseconds; both are accepted. */
function resetTimestamp(
  resetsAt: number | undefined,
): ProviderRuntimeEvent["occurredAt"] | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  const absolute = resetsAt < 10_000_000_000 ? resetsAt * 1_000 : resetsAt;
  const at = new Date(absolute);
  return Number.isNaN(at.getTime())
    ? undefined
    : (at.toISOString() as ProviderRuntimeEvent["occurredAt"]);
}

function retryAfterMs(
  context: ClaudeEventContext,
  resetsAt: number | undefined,
): number | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt < 0) return undefined;
  const occurredAt = Date.parse(context.occurredAt);
  if (!Number.isFinite(occurredAt)) return undefined;
  const absolute = resetsAt < 10_000_000_000 ? resetsAt * 1_000 : resetsAt;
  const remaining = Math.ceil(absolute - occurredAt);
  if (remaining <= 0) return undefined;
  return Math.min(remaining, MAX_RETRY_AFTER_MS);
}

function mapResult(
  context: ClaudeEventContext,
  message: Extract<ClaudeDecodedMessage, { readonly kind: "result" }>,
): ReadonlyArray<ClaudeMappedMessage> {
  if (context.terminal) return [failure("Claude returned a duplicate terminal message.")];
  if (!resultMetadataIsValid(message)) {
    return [failure("Claude returned contradictory result metadata.")];
  }
  if (!usageIsSafe(message.usage)) {
    return [failure("Claude returned invalid usage metadata.")];
  }
  const results: ClaudeMappedMessage[] = [
    usageEvent(context, message.usage, message.durationMs, message.totalCostUsd),
  ];
  if (message.outcome === "success") {
    results.push(
      terminal(context, {
        kind: "completed",
        resumeCursor: { driverKind: "claude", value: context.claudeSessionId },
      }),
    );
    return results;
  }
  if (
    message.terminalReason === "aborted_streaming" ||
    message.terminalReason === "aborted_tools"
  ) {
    results.push(
      terminal(context, {
        kind: "interrupted",
        message: "Claude execution was interrupted.",
      }),
    );
    return results;
  }
  const providerFailure: ProviderFailure =
    message.permissionDenials.length > 0
      ? { category: "unauthorized", message: "Claude tool execution was denied." }
      : { category: "provider-failed", message: "Claude execution failed." };
  results.push(terminal(context, { kind: "failed", failure: providerFailure }));
  return results;
}

function mapStreamEvent(
  context: ClaudeEventContext,
  message: Extract<ClaudeDecodedMessage, { readonly kind: "stream-event" }>,
): ReadonlyArray<ClaudeMappedMessage> {
  switch (message.event.kind) {
    case "text-delta":
      return streamedEvents(context, "text-delta", message.event.text);
    case "reasoning-delta":
      return streamedEvents(context, "reasoning-delta", message.event.text);
    case "content-start":
      return message.event.content.kind === "tool-use"
        ? mapToolUse(context, message.event.content, false)
        : [{ kind: "ignored" }];
    case "message-start":
    case "message-delta":
      return usageIsSafe(message.event.usage)
        ? [{ kind: "ignored" }]
        : [failure("Claude returned invalid usage metadata.")];
    case "message-stop":
    case "tool-input-delta":
    case "reasoning-signature":
    case "citation-delta":
    case "compaction-delta":
    case "content-stop":
      return [{ kind: "ignored" }];
  }
}

export function mapClaudeMessage(
  context: ClaudeEventContext,
  message: ClaudeDecodedMessage,
): ReadonlyArray<ClaudeMappedMessage> {
  const decoded = message as unknown as { readonly kind?: unknown; readonly sessionId?: unknown };
  if (decoded.kind === "ignored") return [{ kind: "ignored" }];
  if (typeof decoded.kind !== "string" || !DECODED_MESSAGE_KINDS.has(decoded.kind)) {
    return [failure("Claude returned an unsupported decoded message.")];
  }
  if (typeof decoded.sessionId !== "string" || decoded.sessionId !== context.claudeSessionId) {
    return [failure("Claude message did not match the active session.")];
  }
  if (context.terminal) {
    return [
      failure(
        decoded.kind === "result"
          ? "Claude returned a duplicate terminal message."
          : "Claude returned activity after the terminal message.",
      ),
    ];
  }
  switch (message.kind) {
    case "initialized":
      return message.projectRoot === context.projectRoot
        ? [{ kind: "ignored" }]
        : [failure("Claude initialization did not match the active Project.")];
    case "assistant":
      return mapAssistant(context, message);
    case "stream-event":
      return mapStreamEvent(context, message);
    case "tool-results":
      return mapToolResults(context, message);
    case "result":
      return mapResult(context, message);
    case "tool-progress": {
      const state = context.toolStates.get(message.toolUseId);
      if (
        state === undefined ||
        state.toolName !== normalized(message.toolName, LABEL_MAX_CHARACTERS) ||
        state.lifecycle !== "active"
      ) {
        return [failure("Claude tool progress did not match an active tool.")];
      }
      const results: ClaudeMappedMessage[] = [];
      if (state.emitsActivity) {
        results.push(
          event(context, {
            kind: "tool-progress",
            toolCallId: state.toolCallId,
            message: "Tool is running.",
          }),
        );
      }
      return withoutIgnored(results);
    }
    case "tool-summary":
      return [{ kind: "ignored" }];
    case "task":
      return mapTask(context, message);
    case "rate-limit": {
      // Every rate-limit message says how much of a window is spent, not only
      // the ones that reject a turn. Passing the window through is what lets a
      // thread warn before the limit lands instead of after.
      const results: ClaudeMappedMessage[] = [];
      const window = rateLimitWindowEvent(context, message);
      if (window !== undefined) results.push(window);
      if (message.status !== "rejected") return withoutIgnored(results);
      const retry = retryAfterMs(context, message.resetsAt);
      results.push(
        terminal(context, {
          kind: "failed",
          failure: {
            category: "rate-limited",
            message: "Claude is temporarily rate limited.",
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          },
        }),
      );
      return results;
    }
    case "authentication":
      return message.failed
        ? [
            terminal(context, {
              kind: "failed",
              failure: {
                category: "unauthenticated",
                message: "Claude authentication is required.",
              },
            }),
          ]
        : [{ kind: "ignored" }];
    case "status":
      return [{ kind: "ignored" }];
    case "ignored":
      return [{ kind: "ignored" }];
    default:
      return [failure("Claude returned an unsupported decoded message.")];
  }
}

function canonicalJson(value: unknown, seen: Set<object>, depth = 0): string | undefined {
  if (depth > 16) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  let result: string | undefined;
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalJson(entry, seen, depth + 1));
    result = items.some((entry) => entry === undefined) ? undefined : `[${items.join(",")}]`;
  } else {
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalJson((value as Record<string, unknown>)[key], seen, depth + 1);
      if (encoded === undefined) {
        result = undefined;
        break;
      }
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    if (entries.length === Object.keys(value).length) result = `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function inputDigest(input: Readonly<Record<string, unknown>>): string | undefined {
  const canonical = canonicalJson(input, new Set());
  if (canonical === undefined || canonical.length > DIGEST_INPUT_MAX_CHARACTERS) return undefined;
  return createHash("sha256").update(canonical).digest("hex");
}

function correlatedRequestId(
  context: ClaudeEventContext,
  correlation: Omit<ClaudeRequestCorrelation, "requestId">,
):
  | { readonly kind: "request-id"; readonly requestId: string }
  | Extract<ClaudeMappedMessage, { readonly kind: "failure" }> {
  const existing = context.requestIds.get(correlation.providerToolUseId);
  if (existing !== undefined) {
    if (
      existing.kind !== correlation.kind ||
      existing.toolName !== correlation.toolName ||
      existing.providerSessionId !== correlation.providerSessionId ||
      existing.providerToolUseId !== correlation.providerToolUseId ||
      existing.inputDigest !== correlation.inputDigest
    ) {
      return failure("Claude callback did not match its original correlation tuple.");
    }
    return { kind: "request-id", requestId: existing.requestId };
  }
  const requestId = context.makeRequestId();
  context.requestIds.set(correlation.providerToolUseId, { ...correlation, requestId });
  return { kind: "request-id", requestId };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function mapQuestion(
  context: ClaudeEventContext,
  request: ClaudeToolRequest,
  digest: string,
  toolName: string,
): ClaudeMappedMessage {
  const questions = request.input.questions;
  if (!Array.isArray(questions) || questions.length !== 1) {
    return failure("Claude returned an unsupported user question.", "unsupported");
  }
  const question = record(questions[0]);
  const prompt =
    typeof question?.question === "string"
      ? normalized(question.question, SUMMARY_MAX_CHARACTERS)
      : undefined;
  const rawOptions = question?.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap((value) => {
        const option = record(value);
        const label =
          typeof option?.label === "string"
            ? normalized(option.label, LABEL_MAX_CHARACTERS)
            : undefined;
        return label === undefined ? [] : [label];
      })
    : [];
  if (
    prompt === undefined ||
    question?.multiSelect === true ||
    !Array.isArray(rawOptions) ||
    options.length !== rawOptions.length ||
    options.length === 0 ||
    options.length > 20
  ) {
    return failure("Claude returned an unsupported user question.", "unsupported");
  }
  const correlated = correlatedRequestId(context, {
    kind: "question",
    toolName,
    providerSessionId: context.claudeSessionId,
    providerToolUseId: request.toolUseId,
    inputDigest: digest,
  });
  if (correlated.kind === "failure") return correlated;
  const normalizedRequestId = correlated.requestId;
  const requestEvent = mappedEvent(context, {
    kind: "user-input-request",
    requestId: normalizedRequestId,
    prompt,
    options,
  });
  return {
    kind: "question",
    request: {
      kind: "question",
      requestId: normalizedRequestId,
      providerSessionId: context.claudeSessionId,
      providerToolUseId: request.toolUseId,
      inputDigest: digest,
      event: requestEvent,
    },
  };
}

export function mapClaudeToolRequest(
  context: ClaudeEventContext,
  request: ClaudeToolRequest,
): ClaudeMappedMessage {
  if (context.terminal) return failure("Claude requested input after the terminal message.");
  const digest = inputDigest(request.input);
  if (digest === undefined) return failure("Claude returned invalid tool input metadata.");
  const toolName = normalized(request.toolName, LABEL_MAX_CHARACTERS);
  if (toolName === undefined) return failure("Claude returned invalid approval metadata.");
  if (request.toolName === "AskUserQuestion") {
    return mapQuestion(context, request, digest, toolName);
  }
  const correlated = correlatedRequestId(context, {
    kind: "approval",
    toolName,
    providerSessionId: context.claudeSessionId,
    providerToolUseId: request.toolUseId,
    inputDigest: digest,
  });
  if (correlated.kind === "failure") return correlated;
  const normalizedRequestId = correlated.requestId;
  const requestEvent = mappedEvent(context, {
    kind: "approval-request",
    requestId: normalizedRequestId,
    action: toolName,
    description: `Claude requests permission to use ${toolName}.`,
  });
  return {
    kind: "approval",
    request: {
      kind: "approval",
      requestId: normalizedRequestId,
      providerSessionId: context.claudeSessionId,
      providerToolUseId: request.toolUseId,
      inputDigest: digest,
      toolName,
      event: requestEvent,
    },
  };
}
