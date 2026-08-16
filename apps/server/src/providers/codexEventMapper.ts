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
import type { CodexRpcId, CodexServerMessage, CodexServerRequest } from "./codexProtocol";

const STREAM_CHUNK_CHARACTERS = 65_536;
const DIFF_MAX_CHARACTERS = 65_536;
const LABEL_MAX_CHARACTERS = 256;
const SUMMARY_MAX_CHARACTERS = 1_024;
const PATH_MAX_CHARACTERS = 4_096;

export interface CodexEventContext {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly correlationId: CorrelationId;
  readonly occurredAt: UtcTimestamp;
  readonly projectRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  sequence: number;
  terminal: boolean;
  readonly requestIds: Map<CodexRpcId, string>;
  readonly agentMessages: Map<string, CodexAgentMessageState>;
  readonly taskIds: Map<string, string>;
  readonly toolStates: Map<string, CodexToolState>;
  readonly makeRequestId: () => string;
  readonly makeTaskId: () => string;
  readonly makeToolCallId: () => string;
}

export interface CodexToolState {
  readonly toolCallId: string;
  lifecycle: "active" | "terminal";
}

interface CodexAgentMessageState {
  lifecycle: "active" | "terminal";
  text: string;
}

type RequestFor<Method extends CodexServerRequest["method"]> = Extract<
  CodexServerRequest,
  { readonly method: Method }
>;

interface PendingApprovalBase {
  readonly requestId: string;
  readonly providerRequestId: CodexRpcId;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly event: ProviderRuntimeEvent;
}

export type CodexPendingApproval =
  | (PendingApprovalBase & {
      readonly kind: "command";
      readonly requestedCwd: RequestFor<"item/commandExecution/requestApproval">["params"]["cwd"];
      readonly networkApprovalContext: RequestFor<"item/commandExecution/requestApproval">["params"]["networkApprovalContext"];
    })
  | (PendingApprovalBase & {
      readonly kind: "file-change";
      readonly grantRoot: RequestFor<"item/fileChange/requestApproval">["params"]["grantRoot"];
    })
  | (PendingApprovalBase & {
      readonly kind: "permissions";
      readonly requestedCwd: string;
      readonly permissions: RequestFor<"item/permissions/requestApproval">["params"]["permissions"];
    });

export type CodexMappedMessage =
  | { readonly kind: "event"; readonly event: ProviderRuntimeEvent }
  | { readonly kind: "approval"; readonly approval: CodexPendingApproval }
  | { readonly kind: "ignored" }
  | { readonly kind: "protocol-failure"; readonly failure: ProviderFailure };

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

type ItemLifecycleMessage = Extract<
  CodexServerMessage,
  { readonly kind: "notification"; readonly method: "item/started" | "item/completed" }
>;
type ThreadItem = ItemLifecycleMessage["params"]["item"];
type ToolItem = Extract<
  ThreadItem,
  { readonly type: "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" }
>;

function protocolFailure(message: string, category: ProviderFailure["category"] = "protocol") {
  return [{ kind: "protocol-failure", failure: { category, message } }] as const;
}

function mappedEvent(
  context: CodexEventContext,
  event: RuntimeEventWithoutEnvelope,
): ProviderRuntimeEvent {
  const mapped = {
    ...event,
    instanceId: context.instanceId,
    sessionId: context.sessionId,
    sequence: context.sequence,
    correlationId: context.correlationId,
    occurredAt: context.occurredAt,
  } as ProviderRuntimeEvent;
  context.sequence += 1;
  return mapped;
}

function event(context: CodexEventContext, value: RuntimeEventWithoutEnvelope): CodexMappedMessage {
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

function semanticTaskKey(summary: string, occurrence: number): string {
  const digest = createHash("sha256").update(summary).digest("hex");
  return `${digest}:${occurrence}`;
}

function streamedEvents(
  context: CodexEventContext,
  kind: "text-delta" | "reasoning-delta",
  text: string,
): ReadonlyArray<CodexMappedMessage> {
  if (text.length === 0) return [{ kind: "ignored" }];
  const characters = Array.from(text);
  const results: CodexMappedMessage[] = [];
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

function mapAgentMessageDelta(
  context: CodexEventContext,
  itemId: string,
  delta: string,
): ReadonlyArray<CodexMappedMessage> {
  const state = context.agentMessages.get(itemId);
  if (state?.lifecycle === "terminal") {
    return protocolFailure("Provider streamed text for a completed agent message.");
  }
  if (delta.length === 0) return [{ kind: "ignored" }];
  context.agentMessages.set(itemId, {
    lifecycle: "active",
    text: `${state?.text ?? ""}${delta}`,
  });
  return streamedEvents(context, "text-delta", delta);
}

function mapAgentMessageCompletion(
  context: CodexEventContext,
  item: Extract<ThreadItem, { readonly type: "agentMessage" }>,
): ReadonlyArray<CodexMappedMessage> {
  const state = context.agentMessages.get(item.id);
  if (state?.lifecycle === "terminal") {
    return protocolFailure("Provider completed an agent message more than once.");
  }
  const streamed = state?.text ?? "";
  if (!item.text.startsWith(streamed)) {
    return protocolFailure("Provider completed agent text that contradicted its streamed text.");
  }
  context.agentMessages.set(item.id, { lifecycle: "terminal", text: item.text });
  return streamedEvents(context, "text-delta", item.text.slice(streamed.length));
}

function correlationFailure(): ReadonlyArray<CodexMappedMessage> {
  return protocolFailure("Provider message did not match the active thread and turn.");
}

function matchesCorrelation(context: CodexEventContext, threadId: string, turnId: string): boolean {
  return threadId === context.threadId && turnId === context.turnId;
}

function toolCallId(context: CodexEventContext, itemId: string): string {
  const existing = context.toolStates.get(itemId);
  if (existing !== undefined) return existing.toolCallId;
  const created = context.makeToolCallId();
  context.toolStates.set(itemId, { toolCallId: created, lifecycle: "active" });
  return created;
}

function toolName(item: ToolItem): string {
  switch (item.type) {
    case "commandExecution":
      return "Command";
    case "fileChange":
      return "File change";
    case "mcpToolCall":
      return truncate(`MCP ${item.server}/${item.tool}`, LABEL_MAX_CHARACTERS);
    case "dynamicToolCall":
      return truncate(
        item.namespace === null ? item.tool : `${item.namespace}/${item.tool}`,
        LABEL_MAX_CHARACTERS,
      );
  }
}

function mapToolStart(
  context: CodexEventContext,
  item: ToolItem,
): ReadonlyArray<CodexMappedMessage> {
  const id = toolCallId(context, item.id);
  return [
    event(context, { kind: "tool-start", toolCallId: id, toolName: toolName(item) }),
    event(context, { kind: "tool-progress", toolCallId: id, message: "Tool is running." }),
  ];
}

function confinedRelativePath(context: CodexEventContext, value: string): string | undefined {
  const root = resolve(context.projectRoot);
  const target = resolve(root, value);
  const confined = relative(root, target);
  if (
    confined.length === 0 ||
    isAbsolute(confined) ||
    confined === ".." ||
    confined.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  const portable = confined.split(sep).join("/");
  return portable.length <= PATH_MAX_CHARACTERS ? portable : undefined;
}

function fileChangePathsAreConfined(
  context: CodexEventContext,
  item: Extract<ToolItem, { readonly type: "fileChange" }>,
): boolean {
  return item.changes.every((change) => {
    if (confinedRelativePath(context, change.path) === undefined) return false;
    const movePath = change.kind.type === "update" ? change.kind.move_path : null;
    return movePath === null || confinedRelativePath(context, movePath) !== undefined;
  });
}

function mapFileChangeCompletion(
  context: CodexEventContext,
  item: Extract<ToolItem, { readonly type: "fileChange" }>,
): ReadonlyArray<CodexMappedMessage> {
  const id = toolCallId(context, item.id);
  if (item.status === "failed" || item.status === "declined") {
    return [
      event(context, {
        kind: "tool-failure",
        toolCallId: id,
        message: item.status === "declined" ? "Tool was declined." : "Tool failed.",
      }),
    ];
  }
  if (item.status === "inProgress") {
    return [event(context, { kind: "tool-progress", toolCallId: id, message: "Tool is running." })];
  }

  const changes = item.changes.map((change) => ({
    path: confinedRelativePath(context, change.path),
    change:
      change.kind.type === "add"
        ? ("created" as const)
        : change.kind.type === "delete"
          ? ("deleted" as const)
          : ("modified" as const),
  }));
  return [
    ...changes.map(({ path, change }) =>
      event(context, { kind: "file-change", path: path as string, change }),
    ),
    event(context, { kind: "tool-success", toolCallId: id, summary: "File change completed." }),
  ];
}

function mapToolCompletion(
  context: CodexEventContext,
  item: ToolItem,
): ReadonlyArray<CodexMappedMessage> {
  if (item.type === "fileChange") return mapFileChangeCompletion(context, item);
  const id = toolCallId(context, item.id);
  if (item.status === "inProgress") {
    return [event(context, { kind: "tool-progress", toolCallId: id, message: "Tool is running." })];
  }
  if (item.status === "completed") {
    if (item.type === "dynamicToolCall" && item.success === false) {
      return protocolFailure("Provider returned a contradictory tool completion status.");
    }
    return [event(context, { kind: "tool-success", toolCallId: id, summary: "Tool completed." })];
  }
  return [
    event(context, {
      kind: "tool-failure",
      toolCallId: id,
      message: item.status === "declined" ? "Tool was declined." : "Tool failed.",
    }),
  ];
}

function mapLifecycle(
  context: CodexEventContext,
  message: ItemLifecycleMessage,
): ReadonlyArray<CodexMappedMessage> {
  const { threadId, turnId, item } = message.params;
  if (!matchesCorrelation(context, threadId, turnId)) return correlationFailure();
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall": {
      if (item.type === "fileChange" && !fileChangePathsAreConfined(context, item)) {
        return protocolFailure(
          "Provider reported a file change outside the authorized Project root.",
        );
      }
      const state = context.toolStates.get(item.id);
      if (message.method === "item/started") {
        if (item.status !== "inProgress") {
          return protocolFailure("Provider started a tool item with a terminal status.");
        }
        if (state !== undefined) {
          return protocolFailure("Provider started a tool item more than once.");
        }
        return mapToolStart(context, item);
      }
      if (item.status === "inProgress") {
        return protocolFailure("Provider completed a tool item with a non-terminal status.");
      }
      if (state === undefined) {
        return protocolFailure("Provider completed a tool item that was not started.");
      }
      if (state.lifecycle === "terminal") {
        return protocolFailure("Provider completed a terminal tool item.");
      }
      const mapped = mapToolCompletion(context, item);
      state.lifecycle = "terminal";
      return mapped;
    }
    case "userMessage":
    case "contextCompaction":
    case "plan":
    case "reasoning":
      return [{ kind: "ignored" }];
    case "agentMessage":
      return message.method === "item/completed"
        ? mapAgentMessageCompletion(context, item)
        : [{ kind: "ignored" }];
  }
}

function approval(
  context: CodexEventContext,
  message: CodexServerRequest,
): ReadonlyArray<CodexMappedMessage> {
  if (!matchesCorrelation(context, message.params.threadId, message.params.turnId)) {
    return correlationFailure();
  }
  if (context.requestIds.has(message.id)) {
    return protocolFailure("Provider repeated an approval request ID.");
  }
  const requestId = context.makeRequestId();
  context.requestIds.set(message.id, requestId);
  const action =
    message.method === "item/commandExecution/requestApproval"
      ? "command"
      : message.method === "item/fileChange/requestApproval"
        ? "file change"
        : "permissions";
  const approvalEvent = mappedEvent(context, {
    kind: "approval-request",
    requestId,
    action,
    description: "Approval is required for this action.",
  });
  const base = {
    requestId,
    providerRequestId: message.id,
    threadId: message.params.threadId,
    turnId: message.params.turnId,
    itemId: message.params.itemId,
    event: approvalEvent,
  } as const;

  switch (message.method) {
    case "item/commandExecution/requestApproval":
      return [
        {
          kind: "approval",
          approval: {
            ...base,
            kind: "command",
            requestedCwd: message.params.cwd,
            networkApprovalContext: message.params.networkApprovalContext,
          },
        },
      ];
    case "item/fileChange/requestApproval":
      return [
        {
          kind: "approval",
          approval: { ...base, kind: "file-change", grantRoot: message.params.grantRoot },
        },
      ];
    case "item/permissions/requestApproval":
      return [
        {
          kind: "approval",
          approval: {
            ...base,
            kind: "permissions",
            requestedCwd: message.params.cwd,
            permissions: message.params.permissions,
          },
        },
      ];
  }
}

function mapTerminal(
  context: CodexEventContext,
  status: "completed" | "interrupted" | "failed" | "inProgress",
): ReadonlyArray<CodexMappedMessage> {
  if (context.terminal) {
    return protocolFailure("Provider emitted more than one terminal event.");
  }
  if (status === "inProgress") {
    return protocolFailure("Provider returned a non-terminal turn completion status.");
  }
  const activeTools = [...context.toolStates.values()].filter(
    ({ lifecycle }) => lifecycle === "active",
  );
  if (status === "completed" && activeTools.length > 0) {
    return protocolFailure("Provider completed the turn while tool items were still active.");
  }
  context.terminal = true;
  activeTools.forEach((tool) => {
    tool.lifecycle = "terminal";
  });
  if (status === "interrupted") {
    return [
      event(context, { kind: "interrupted", message: "Provider execution was interrupted." }),
    ];
  }
  if (status === "failed") {
    return [
      event(context, {
        kind: "failed",
        failure: { category: "provider-failed", message: "Provider execution failed." },
      }),
    ];
  }
  return [
    event(context, {
      kind: "completed",
      resumeCursor: { driverKind: "codex", value: context.threadId },
    }),
  ];
}

function mapNotification(
  context: CodexEventContext,
  message: Extract<CodexServerMessage, { readonly kind: "notification" }>,
): ReadonlyArray<CodexMappedMessage> {
  switch (message.method) {
    case "turn/started":
      if (!matchesCorrelation(context, message.params.threadId, message.params.turn.id)) {
        return correlationFailure();
      }
      return message.params.turn.status === "inProgress"
        ? [{ kind: "ignored" }]
        : protocolFailure("Provider returned a non-running turn start status.");
    case "turn/completed":
      if (!matchesCorrelation(context, message.params.threadId, message.params.turn.id)) {
        return correlationFailure();
      }
      return mapTerminal(context, message.params.turn.status);
    case "item/started":
    case "item/completed":
      return mapLifecycle(context, message);
    case "item/agentMessage/delta": {
      if (!matchesCorrelation(context, message.params.threadId, message.params.turnId)) {
        return correlationFailure();
      }
      return mapAgentMessageDelta(context, message.params.itemId, message.params.delta);
    }
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      if (!matchesCorrelation(context, message.params.threadId, message.params.turnId)) {
        return correlationFailure();
      }
      return streamedEvents(context, "reasoning-delta", message.params.delta);
    }
    case "turn/diff/updated": {
      if (!matchesCorrelation(context, message.params.threadId, message.params.turnId)) {
        return correlationFailure();
      }
      if (message.params.diff.length === 0) return [{ kind: "ignored" }];
      if (Array.from(message.params.diff).length > DIFF_MAX_CHARACTERS) {
        return protocolFailure("Provider diff exceeded the supported size.");
      }
      return [event(context, { kind: "diff", diff: message.params.diff })];
    }
    case "turn/plan/updated": {
      if (!matchesCorrelation(context, message.params.threadId, message.params.turnId)) {
        return correlationFailure();
      }
      const results: CodexMappedMessage[] = [];
      const occurrences = new Map<string, number>();
      message.params.plan.forEach((step) => {
        const summary = normalized(step.step, SUMMARY_MAX_CHARACTERS);
        if (summary === undefined) return;
        const occurrence = occurrences.get(summary) ?? 0;
        occurrences.set(summary, occurrence + 1);
        const key = semanticTaskKey(summary, occurrence);
        let taskId = context.taskIds.get(key);
        if (taskId === undefined) {
          taskId = context.makeTaskId();
          context.taskIds.set(key, taskId);
        }
        results.push(
          event(context, {
            kind: "task-progress",
            taskId,
            status: step.status === "inProgress" ? "in-progress" : step.status,
            summary,
          }),
        );
      });
      return results.length === 0 ? [{ kind: "ignored" }] : results;
    }
    case "thread/tokenUsage/updated":
      if (!matchesCorrelation(context, message.params.threadId, message.params.turnId)) {
        return correlationFailure();
      }
      return [
        event(context, {
          kind: "usage",
          inputTokens: message.params.tokenUsage.total.inputTokens,
          outputTokens: message.params.tokenUsage.total.outputTokens,
          reasoningTokens: message.params.tokenUsage.total.reasoningOutputTokens,
          cacheReadInputTokens: message.params.tokenUsage.total.cachedInputTokens,
        }),
      ];
  }
}

function isActiveRuntimeMethod(method: string): boolean {
  return method.startsWith("turn/") || method.startsWith("item/") || method.startsWith("thread/");
}

export function mapCodexMessage(
  context: CodexEventContext,
  message: CodexServerMessage,
): ReadonlyArray<CodexMappedMessage> {
  if (
    context.terminal &&
    (message.kind === "request" ||
      (message.kind === "notification" && message.method !== "turn/completed"))
  ) {
    return protocolFailure("Provider emitted runtime activity after the terminal event.");
  }
  switch (message.kind) {
    case "notification":
      return mapNotification(context, message);
    case "request":
      return approval(context, message);
    case "unknown-notification":
      return isActiveRuntimeMethod(message.method)
        ? protocolFailure("Provider emitted an unsupported active runtime notification.")
        : [{ kind: "ignored" }];
    case "response":
    case "unsupported-request":
      return protocolFailure(
        "Provider message is not supported by the stable Codex adapter.",
        "unsupported",
      );
  }
}
