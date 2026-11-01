import { createHash } from "node:crypto";
import type {
  CorrelationId,
  ProviderFailure,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSessionId,
  UtcTimestamp,
  ProviderApprovalCall,
} from "@octant/contracts";
import { OUTSIDE_CONTENT_RESULT_MAX_CHARACTERS } from "@octant/contracts";
import type { AcpServerNotification, AcpServerRequest } from "./acpProtocol";
import { outsideContentTarget, outsideContentToolName } from "./outsideContentRead";
import { providerApprovalCall } from "./providerApprovalCall";

const STREAM_CHUNK_CHARACTERS = 65_536;
const LABEL_MAX_CHARACTERS = 256;
const SUMMARY_MAX_CHARACTERS = 1_024;

interface AcpToolState {
  readonly toolCallId: string;
  terminal: boolean;
  title?: string;
  kind?: string;
  /** Set once the call has marked the thread as reading outside content. */
  outsideContentReported?: true;
  /** The source the read was reported under, so its result is handed to the Watcher under it. */
  outsideContentSource?: "web-search" | "web-fetch";
  /** The subagent this call started, once the agent named its session. */
  childAgentId?: string;
}

export interface AcpEventContext {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly correlationId: CorrelationId;
  readonly occurredAt: UtcTimestamp;
  readonly sourceSessionId: string;
  /** Human-readable provider name used in protocol failure messages. */
  readonly displayName: string;
  sequence: number;
  terminal: boolean;
  readonly tools: Map<string, AcpToolState>;
  readonly requestIds: Map<string | number, string>;
  readonly makeRequestId: () => string;
  /** The profile's `childRunMetaKey`: where a call names the subagent it started. */
  readonly childRunMetaKey?: string;
}

export type AcpMappedNotification =
  | { readonly kind: "event"; readonly event: ProviderRuntimeEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "protocol-failure"; readonly failure: ProviderFailure };

export type AcpMappedPermission =
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly providerRequestId: string | number;
      /** The ACP tool kind the agent declared, or `tool` when it named none. */
      readonly toolKind: string;
      readonly allowOptionId: string;
      readonly rejectOptionId: string;
      readonly event: ProviderRuntimeEvent;
      /** The pending call, for an automatic reviewer; never on the event. */
      readonly call?: ProviderApprovalCall;
    }
  | {
      readonly kind: "question";
      readonly requestId: string;
      readonly providerRequestId: string | number;
      readonly optionIds: ReadonlyMap<string, string>;
      readonly skipOptionId?: string;
      readonly event: ProviderRuntimeEvent;
    }
  | { readonly kind: "protocol-failure"; readonly failure: ProviderFailure };

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

function protocolFailure(message: string): AcpMappedNotification {
  return { kind: "protocol-failure", failure: { category: "protocol", message } };
}

function mappedEvent(
  context: AcpEventContext,
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
  return event;
}

function event(
  context: AcpEventContext,
  value: RuntimeEventWithoutEnvelope,
): AcpMappedNotification {
  const mapped = mappedEvent(context, value);
  context.sequence += 1;
  return { kind: "event", event: mapped };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalized(value: unknown, maximum: number): string | undefined {
  const raw = string(value)?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const characters = Array.from(raw);
  return characters.length <= maximum ? raw : `${characters.slice(0, maximum - 1).join("")}…`;
}

function streamed(
  context: AcpEventContext,
  kind: "text-delta" | "reasoning-delta",
  value: unknown,
): ReadonlyArray<AcpMappedNotification> {
  const text = string(value);
  if (text === undefined || text.length === 0) return [{ kind: "ignored" }];
  const characters = Array.from(text);
  const results: AcpMappedNotification[] = [];
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

function taskId(summary: string): string {
  return `task-${createHash("sha256").update(summary).digest("hex").slice(0, 16)}`;
}

// A failed ACP tool call carries its reason as a text content item, not in the
// title; a provider that sends none still renders the honest generic sentence.
// `rawOutput` is deliberately not a fallback: it is an opaque provider payload
// that can hold stdout, file contents, or credentials, and this text is
// journaled and exported, where raw provider payloads must never appear.
function toolFailureReason(update: Readonly<Record<string, unknown>>): string | undefined {
  const items = Array.isArray(update.content) ? update.content : [];
  for (const item of items) {
    const entry = record(item);
    if (entry?.type !== "content") continue;
    const text = normalized(record(entry.content)?.text, SUMMARY_MAX_CHARACTERS);
    if (text !== undefined) return text;
  }
  return undefined;
}

function mapTool(
  context: AcpEventContext,
  update: Readonly<Record<string, unknown>>,
): ReadonlyArray<AcpMappedNotification> {
  const providerId = normalized(update.toolCallId, LABEL_MAX_CHARACTERS);
  if (providerId === undefined)
    return [protocolFailure(`${context.displayName} tool update was missing an ID.`)];
  const state = context.tools.get(providerId);
  if (update.sessionUpdate === "tool_call") {
    if (state !== undefined)
      return [protocolFailure(`${context.displayName} repeated a tool start.`)];
    const title = normalized(update.title, LABEL_MAX_CHARACTERS) ?? "Tool";
    const toolKind = normalized(update.kind, LABEL_MAX_CHARACTERS);
    const created = {
      toolCallId: `tool-${context.tools.size + 1}`,
      terminal: false,
      title,
      ...(toolKind === undefined ? {} : { kind: toolKind }),
    };
    context.tools.set(providerId, created);
    return [
      event(context, { kind: "tool-start", toolCallId: created.toolCallId, toolName: title }),
      ...outsideContentRead(context, created, update),
      ...childRun(context, created, update),
    ];
  }
  if (state === undefined)
    return [protocolFailure(`${context.displayName} updated a tool that was not started.`)];
  if (state.terminal)
    return [protocolFailure(`${context.displayName} repeated a terminal tool update.`)];
  const title = normalized(update.title, SUMMARY_MAX_CHARACTERS);
  const toolKind = normalized(update.kind, LABEL_MAX_CHARACTERS);
  if (title !== undefined) state.title = title;
  if (toolKind !== undefined) state.kind = toolKind;
  // An agent may name the kind only once the call is under way.
  const read = [
    ...outsideContentRead(context, state, update),
    ...outsideContentResult(context, state, update),
  ];
  const status = string(update.status);
  if (status === "completed") {
    state.terminal = true;
    return [
      ...read,
      event(context, {
        kind: "tool-success",
        toolCallId: state.toolCallId,
        summary: "Tool completed.",
      }),
      ...childRun(context, state, update, "completed"),
    ];
  }
  if (status === "failed") {
    state.terminal = true;
    return [
      ...read,
      event(context, {
        kind: "tool-failure",
        toolCallId: state.toolCallId,
        message: toolFailureReason(update) ?? "Tool failed.",
      }),
      ...childRun(context, state, update, "failed"),
    ];
  }
  return [
    ...read,
    event(context, {
      kind: "tool-progress",
      toolCallId: state.toolCallId,
      message: normalized(update.title, SUMMARY_MAX_CHARACTERS) ?? "Tool is running.",
    }),
    ...childRun(context, state, update),
  ];
}

/**
 * A call that started one of the agent's own subagents, shown as a child run
 * once the agent names the child's session under the profile's
 * `childRunMetaKey`: running when first named, then finished or failed with
 * the call. The task is the first line of what the agent sent the child;
 * nothing the child said is read.
 */
function childRun(
  context: AcpEventContext,
  state: AcpToolState,
  update: Readonly<Record<string, unknown>>,
  ended?: "completed" | "failed",
): ReadonlyArray<AcpMappedNotification> {
  if (context.childRunMetaKey === undefined) return [];
  const meta = record(update._meta);
  const reported = string(meta?.[context.childRunMetaKey])?.trim();
  const named =
    reported !== undefined && reported.length > 0 && reported.length <= 255 ? reported : undefined;
  const firstSeen = state.childAgentId === undefined && named !== undefined;
  if (firstSeen) state.childAgentId = named;
  const childAgentId = state.childAgentId;
  if (childAgentId === undefined || (!firstSeen && ended === undefined)) return [];
  const task = normalized(string(meta?.task)?.split("\n")[0], 200);
  const status = ended ?? "running";
  return [
    event(context, {
      kind: "child-agent-activity",
      childAgentId,
      ...(task === undefined ? {} : { task }),
      status,
      summary:
        status === "running"
          ? `${context.displayName} is running a subagent.`
          : status === "completed"
            ? "The subagent finished."
            : "The subagent stopped before it finished.",
    }),
  ];
}

/**
 * ACP's `fetch` kind is a tool "retrieving external data", which the agent
 * runs itself and hands to the model, so the thread is marked the first time
 * a call is seen with it. Its `search` kind covers local file searches too, so
 * only a search that names a query and no place to look is taken for a web
 * search; one that names a path, pattern, or glob is a file search.
 */
function outsideContentRead(
  context: AcpEventContext,
  state: AcpToolState,
  update: Readonly<Record<string, unknown>>,
): ReadonlyArray<AcpMappedNotification> {
  if (state.outsideContentReported === true) return [];
  const input = record(update.rawInput);
  const query = string(input?.query);
  const source =
    state.kind === "fetch"
      ? ("web-fetch" as const)
      : state.kind === "search" &&
          query !== undefined &&
          input !== undefined &&
          !Object.keys(input).some((key) => FILE_SEARCH_INPUT_KEYS.has(key))
        ? ("web-search" as const)
        : undefined;
  if (source === undefined) return [];
  state.outsideContentReported = true;
  state.outsideContentSource = source;
  const target = outsideContentTarget(
    source === "web-fetch" ? (string(input?.url) ?? state.title) : query,
  );
  return [
    event(context, {
      kind: "outside-content-read",
      toolCallId: state.toolCallId,
      // A late title is bounded for a summary, not a label, and an agent may
      // name the address it fetches in it.
      toolName: outsideContentToolName(state.title),
      source,
      ...(target === undefined ? {} : { target }),
    }),
  ];
}

/**
 * The text an outside-content call returned, when the agent put it in the
 * call's content items. Only the Watcher reads it: `rawOutput` stays unread
 * for the reason `toolFailureReason` gives, and nothing here is journaled.
 */
function outsideContentResult(
  context: AcpEventContext,
  state: AcpToolState,
  update: Readonly<Record<string, unknown>>,
): ReadonlyArray<AcpMappedNotification> {
  if (state.outsideContentSource === undefined || !Array.isArray(update.content)) return [];
  let text = "";
  for (const item of update.content) {
    const entry = record(item);
    if (entry?.type !== "content") continue;
    const part = string(record(entry.content)?.text);
    if (part !== undefined) text += `${text === "" ? "" : "\n"}${part}`;
  }
  if (text.trim() === "") return [];
  return [
    event(context, {
      kind: "outside-content-result",
      toolCallId: state.toolCallId,
      toolName: outsideContentToolName(state.title),
      source: state.outsideContentSource,
      text: text.slice(0, OUTSIDE_CONTENT_RESULT_MAX_CHARACTERS),
    }),
  ];
}

// Inputs a file search names where to look with. A search carrying any of
// them is never taken for a web search.
const FILE_SEARCH_INPUT_KEYS: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "pattern",
  "patterns",
  "glob",
  "include",
  "exclude",
  "file",
  "files",
  "file_path",
  "filePath",
  "dir",
  "directory",
  "cwd",
  "root",
]);

export function mapAcpNotification(
  context: AcpEventContext,
  notification: AcpServerNotification,
): ReadonlyArray<AcpMappedNotification> {
  if (notification.params.sessionId !== context.sourceSessionId) {
    return [protocolFailure(`${context.displayName} update did not match the active session.`)];
  }
  if (context.terminal)
    return [protocolFailure(`${context.displayName} sent an update after terminal state.`)];
  const update = notification.params.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return streamed(context, "text-delta", record(update.content)?.text);
    case "agent_thought_chunk":
      return streamed(context, "reasoning-delta", record(update.content)?.text);
    case "tool_call":
    case "tool_call_update":
      return mapTool(context, update);
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : undefined;
      if (entries === undefined)
        return [protocolFailure(`${context.displayName} plan update was invalid.`)];
      const results: AcpMappedNotification[] = [];
      const taskIds: string[] = [];
      for (const candidate of entries) {
        const item = record(candidate);
        const summary = normalized(item?.content, SUMMARY_MAX_CHARACTERS);
        if (summary === undefined)
          return [protocolFailure(`${context.displayName} plan entry was invalid.`)];
        const status = item?.status;
        const normalizedStatus =
          status === "in_progress"
            ? "in-progress"
            : status === "completed"
              ? "completed"
              : status === "failed"
                ? "failed"
                : status === "pending"
                  ? "pending"
                  : undefined;
        if (normalizedStatus === undefined) {
          return [protocolFailure(`${context.displayName} plan status was invalid.`)];
        }
        const id = taskId(summary);
        taskIds.push(id);
        results.push(
          event(context, {
            kind: "task-progress",
            taskId: id,
            status: normalizedStatus,
            summary,
          }),
        );
      }
      // Each plan update is the complete list, so an entry it omits is gone.
      results.push(event(context, { kind: "task-list", taskIds }));
      return results;
    }
    case "config_option_update":
    case "available_commands_update":
      return [{ kind: "ignored" }];
    default:
      return [{ kind: "ignored" }];
  }
}

export function mapAcpPermissionRequest(
  context: AcpEventContext,
  request: AcpServerRequest,
): AcpMappedPermission {
  if (request.params.sessionId !== context.sourceSessionId) {
    return {
      kind: "protocol-failure",
      failure: {
        category: "protocol",
        message: `${context.displayName} request did not match the active session.`,
      },
    };
  }
  if (context.requestIds.has(request.id)) {
    return {
      kind: "protocol-failure",
      failure: {
        category: "protocol",
        message: `${context.displayName} repeated a permission request ID.`,
      },
    };
  }
  const tool = context.tools.get(request.params.toolCall.toolCallId);
  if (
    tool === undefined &&
    normalized(request.params.toolCall.title, SUMMARY_MAX_CHARACTERS) === undefined
  ) {
    return {
      kind: "protocol-failure",
      failure: {
        category: "protocol",
        message: `${context.displayName} permission request did not identify a known tool.`,
      },
    };
  }
  const title =
    normalized(request.params.toolCall.title, SUMMARY_MAX_CHARACTERS) ??
    tool?.title ??
    "Tool requires permission";
  const toolKind = request.params.toolCall.kind ?? tool?.kind ?? "tool";
  const requestId = context.makeRequestId();
  context.requestIds.set(request.id, requestId);
  const questionOptions = request.params.options.filter((option) =>
    /^q0_opt_\d+$/.test(option.optionId),
  );
  if (questionOptions.length > 0) {
    const options = questionOptions.map((option) => ({ label: option.name }));
    const optionIds = new Map(questionOptions.map((option) => [option.name, option.optionId]));
    const skipOptionId = request.params.options.find(
      (option) => option.optionId === "q0_skip",
    )?.optionId;
    return {
      kind: "question",
      requestId,
      providerRequestId: request.id,
      optionIds,
      ...(skipOptionId === undefined ? {} : { skipOptionId }),
      event: mappedEvent(context, {
        kind: "user-input-request",
        requestId,
        prompt: title,
        options,
      }),
    };
  }
  const allow = request.params.options.find((option) => option.kind === "allow_once");
  const reject = request.params.options.find((option) => option.kind.startsWith("reject"));
  if (allow === undefined || reject === undefined) {
    return {
      kind: "protocol-failure",
      failure: {
        category: "protocol",
        message: `${context.displayName} permission options were invalid.`,
      },
    };
  }
  return {
    kind: "approval",
    requestId,
    providerRequestId: request.id,
    toolKind,
    allowOptionId: allow.optionId,
    rejectOptionId: reject.optionId,
    event: mappedEvent(context, {
      kind: "approval-request",
      requestId,
      action: toolKind,
      description: title,
    }),
    ...withCall(
      providerApprovalCall({
        tool: toolKind,
        arguments: {
          ...(typeof request.params.toolCall.rawInput === "object" &&
          request.params.toolCall.rawInput !== null
            ? request.params.toolCall.rawInput
            : request.params.toolCall.rawInput === undefined
              ? {}
              : { input: request.params.toolCall.rawInput }),
          ...(request.params.toolCall.locations == null
            ? {}
            : { locations: request.params.toolCall.locations }),
        },
      }),
    ),
  };
}

function withCall(call: ProviderApprovalCall | undefined): {
  readonly call?: ProviderApprovalCall;
} {
  return call === undefined ? {} : { call };
}
