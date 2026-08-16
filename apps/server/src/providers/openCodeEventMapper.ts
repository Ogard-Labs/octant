import type {
  CorrelationId,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSessionId,
  UtcTimestamp,
} from "@octant/contracts";
import type { Event } from "@opencode-ai/sdk/v2/types";

export interface OpenCodeEventContext {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly correlationId: CorrelationId;
  readonly occurredAt: UtcTimestamp;
  readonly sequenceStart: number;
}

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

function normalizeText(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function nonEmptyText(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function mappedEvent(
  context: OpenCodeEventContext,
  event: RuntimeEventWithoutEnvelope,
  offset = 0,
): ProviderRuntimeEvent {
  return {
    ...event,
    instanceId: context.instanceId,
    sessionId: context.sessionId,
    sequence: context.sequenceStart + offset,
    correlationId: context.correlationId,
    occurredAt: context.occurredAt,
  } as ProviderRuntimeEvent;
}

function completed(context: OpenCodeEventContext, providerSessionId: string): ProviderRuntimeEvent {
  const value = normalizeText(providerSessionId);
  return mappedEvent(
    context,
    value === undefined
      ? { kind: "completed" }
      : { kind: "completed", resumeCursor: { driverKind: "opencode", value } },
  );
}

function mapProviderError(
  context: OpenCodeEventContext,
  error: Extract<Event, { type: "session.error" }>["properties"]["error"],
): ProviderRuntimeEvent {
  if (error?.name === "MessageAbortedError") {
    return mappedEvent(context, {
      kind: "interrupted",
      message: "Provider execution was interrupted.",
    });
  }
  if (
    error?.name === "ProviderAuthError" ||
    (error?.name === "APIError" && error.data.statusCode === 401)
  ) {
    return mappedEvent(context, {
      kind: "failed",
      failure: {
        category: "unauthenticated",
        message: "Provider authentication is required.",
      },
    });
  }
  if (error === undefined) {
    return mappedEvent(context, {
      kind: "failed",
      failure: { category: "protocol", message: "Provider returned an invalid error event." },
    });
  }
  return mappedEvent(context, {
    kind: "failed",
    failure: { category: "provider-failed", message: "Provider execution failed." },
  });
}

function mapQuestion(
  context: OpenCodeEventContext,
  requestId: string,
  questions: ReadonlyArray<{
    readonly question: string;
    readonly options: ReadonlyArray<{ readonly label: string }>;
    readonly multiple?: boolean;
  }>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const question = questions[0];
  if (questions.length !== 1 || question?.multiple === true) {
    return [
      mappedEvent(context, {
        kind: "failed",
        failure: {
          category: "unsupported",
          message:
            "This provider question format is not supported. Ask one single-select question at a time.",
        },
      }),
    ];
  }
  const normalizedRequestId = normalizeText(requestId);
  const prompt = question === undefined ? undefined : normalizeText(question.question);
  if (question === undefined || normalizedRequestId === undefined || prompt === undefined)
    return [];

  return [
    mappedEvent(context, {
      kind: "user-input-request",
      requestId: normalizedRequestId,
      prompt,
      options: question.options.flatMap(({ label }) => {
        const normalized = normalizeText(label);
        return normalized === undefined ? [] : [normalized];
      }),
    }),
  ];
}

function assertNever(value: never): never {
  void value;
  throw new Error("Unsupported provider event.");
}

export function mapOpenCodeEvent(
  context: OpenCodeEventContext,
  event: Event,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.type) {
    case "session.next.text.delta": {
      const text = nonEmptyText(event.properties.delta);
      return text === undefined ? [] : [mappedEvent(context, { kind: "text-delta", text })];
    }
    case "session.next.reasoning.delta": {
      const text = nonEmptyText(event.properties.delta);
      return text === undefined ? [] : [mappedEvent(context, { kind: "reasoning-delta", text })];
    }
    case "session.next.tool.called": {
      const toolCallId = normalizeText(event.properties.callID);
      const toolName = normalizeText(event.properties.tool);
      return toolCallId === undefined || toolName === undefined
        ? []
        : [mappedEvent(context, { kind: "tool-start", toolCallId, toolName })];
    }
    case "session.next.tool.progress": {
      const toolCallId = normalizeText(event.properties.callID);
      return toolCallId === undefined
        ? []
        : [
            mappedEvent(context, {
              kind: "tool-progress",
              toolCallId,
              message: "Tool is running.",
            }),
          ];
    }
    case "session.next.tool.success": {
      const toolCallId = normalizeText(event.properties.callID);
      return toolCallId === undefined
        ? []
        : [
            mappedEvent(context, {
              kind: "tool-success",
              toolCallId,
              summary: "Tool completed.",
            }),
          ];
    }
    case "session.next.tool.failed": {
      const toolCallId = normalizeText(event.properties.callID);
      return toolCallId === undefined
        ? []
        : [
            mappedEvent(context, {
              kind: "tool-failure",
              toolCallId,
              message: "Tool failed.",
            }),
          ];
    }
    case "session.next.step.ended":
      return [
        mappedEvent(context, {
          kind: "usage",
          inputTokens: Math.max(0, Math.trunc(event.properties.tokens.input)),
          outputTokens: Math.max(0, Math.trunc(event.properties.tokens.output)),
        }),
      ];
    case "session.next.step.failed":
      return [
        mappedEvent(context, {
          kind: "failed",
          failure: { category: "provider-failed", message: "Provider execution failed." },
        }),
      ];
    case "file.edited": {
      const path = normalizeText(event.properties.file);
      return path === undefined
        ? []
        : [mappedEvent(context, { kind: "file-change", path, change: "modified" })];
    }
    case "session.diff": {
      const diff = event.properties.diff
        .flatMap(({ file, patch }) => {
          const normalizedFile = file === undefined ? undefined : normalizeText(file);
          const normalizedPatch = patch === undefined ? undefined : nonEmptyText(patch);
          const value = [normalizedFile, normalizedPatch].filter(
            (part): part is string => part !== undefined,
          );
          return value.length === 0 ? [] : [value.join("\n")];
        })
        .join("\n\n");
      return diff.length === 0 ? [] : [mappedEvent(context, { kind: "diff", diff })];
    }
    case "todo.updated": {
      const events: ProviderRuntimeEvent[] = [];
      event.properties.todos.forEach((todo, index) => {
        const summary = normalizeText(todo.content);
        if (summary === undefined) return;
        const status =
          todo.status === "in_progress"
            ? "in-progress"
            : todo.status === "completed"
              ? "completed"
              : todo.status === "cancelled"
                ? "failed"
                : "pending";
        events.push(
          mappedEvent(
            context,
            {
              kind: "task-progress",
              taskId: `task-${index + 1}`,
              status,
              summary,
            },
            events.length,
          ),
        );
      });
      return events;
    }
    case "permission.asked": {
      const requestId = normalizeText(event.properties.id);
      const action = normalizeText(event.properties.permission);
      return requestId === undefined || action === undefined
        ? []
        : [
            mappedEvent(context, {
              kind: "approval-request",
              requestId,
              action,
              description: "Approval is required for this action.",
            }),
          ];
    }
    case "permission.v2.asked": {
      const requestId = normalizeText(event.properties.id);
      const action = normalizeText(event.properties.action);
      return requestId === undefined || action === undefined
        ? []
        : [
            mappedEvent(context, {
              kind: "approval-request",
              requestId,
              action,
              description: "Approval is required for this action.",
            }),
          ];
    }
    case "question.asked":
    case "question.v2.asked":
      return mapQuestion(context, event.properties.id, event.properties.questions);
    case "session.status":
      switch (event.properties.status.type) {
        case "idle":
          return [completed(context, event.properties.sessionID)];
        case "retry":
          return [mappedEvent(context, { kind: "waiting", message: "Provider is retrying." })];
        case "busy":
          return [];
        default:
          return assertNever(event.properties.status);
      }
    case "session.idle":
      return [completed(context, event.properties.sessionID)];
    case "session.error":
      return [mapProviderError(context, event.properties.error)];

    case "models-dev.refreshed":
    case "integration.updated":
    case "integration.connection.updated":
    case "catalog.updated":
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "message.updated":
    case "message.removed":
    case "message.part.updated":
    case "message.part.removed":
    case "session.next.agent.switched":
    case "session.next.model.switched":
    case "session.next.moved":
    case "session.next.prompted":
    case "session.next.prompt.admitted":
    case "session.next.context.updated":
    case "session.next.synthetic":
    case "session.next.shell.started":
    case "session.next.shell.ended":
    case "session.next.step.started":
    case "session.next.text.started":
    case "session.next.text.ended":
    case "session.next.reasoning.started":
    case "session.next.reasoning.ended":
    case "session.next.tool.input.started":
    case "session.next.tool.input.delta":
    case "session.next.tool.input.ended":
    case "session.next.retried":
    case "session.next.compaction.started":
    case "session.next.compaction.delta":
    case "session.next.compaction.ended":
    case "session.next.revert.staged":
    case "session.next.revert.cleared":
    case "session.next.revert.committed":
    case "message.part.delta":
    case "installation.updated":
    case "installation.update-available":
    case "reference.updated":
    case "permission.v2.replied":
    case "plugin.added":
    case "project.directories.updated":
    case "file.watcher.updated":
    case "pty.created":
    case "pty.updated":
    case "pty.exited":
    case "pty.deleted":
    case "question.v2.replied":
    case "question.v2.rejected":
    case "lsp.updated":
    case "permission.replied":
    case "tui.prompt.append":
    case "tui.command.execute":
    case "tui.toast.show":
    case "tui.session.select":
    case "mcp.tools.changed":
    case "mcp.browser.open.failed":
    case "command.executed":
    case "project.updated":
    case "question.replied":
    case "question.rejected":
    case "session.compacted":
    case "vcs.branch.updated":
    case "workspace.ready":
    case "workspace.failed":
    case "workspace.status":
    case "worktree.ready":
    case "worktree.failed":
    case "server.connected":
    case "global.disposed":
    case "server.instance.disposed":
      return [];
    default:
      return assertNever(event);
  }
}
