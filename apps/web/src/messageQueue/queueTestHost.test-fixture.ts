import { vi } from "vitest";
import {
  decodeThreadMessageQueueResult,
  decodeThreadMessageQueueSnapshot,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueScope,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";

export function queueTestHost() {
  const snapshots = new Map<string, ThreadMessageQueueSnapshot>();
  const seen = new Set<string>();
  const key = (scope: ThreadMessageQueueScope) => `${scope.mode}:${scope.threadId}`;
  const snapshot = (scope: ThreadMessageQueueScope) =>
    snapshots.get(key(scope)) ??
    decodeThreadMessageQueueSnapshot({ scope, version: 0, paused: false, items: [] });
  const apply = (command: ThreadMessageQueueCommand) => {
    const previous = snapshot(command.scope);
    if (command.kind === "enqueue" && seen.has(command.messageId))
      return decodeThreadMessageQueueResult({
        status: "duplicate",
        requestId: command.requestId,
        snapshot: previous,
      });
    if (command.expectedVersion !== previous.version)
      return decodeThreadMessageQueueResult({
        status: "conflict",
        requestId: command.requestId,
        snapshot: previous,
      });
    const items =
      command.kind === "enqueue"
        ? [
            ...previous.items,
            {
              messageId: command.messageId,
              status: "queued",
              revision: 0,
              createdAt: "2026-10-03T10:00:00.000Z",
              payload: command.payload,
            },
          ]
        : command.kind === "remove"
          ? previous.items.filter((item) => item.messageId !== command.messageId)
          : command.kind === "edit"
            ? previous.items.map((item) =>
                item.messageId === command.messageId && item.payload !== undefined
                  ? {
                      ...item,
                      revision: item.revision + 1,
                      payload: { ...item.payload, prompt: command.prompt },
                    }
                  : item,
              )
            : command.kind === "reorder"
              ? command.messageIds.flatMap((id) =>
                  previous.items.filter((item) => item.messageId === id),
                )
              : previous.items;
    const next = decodeThreadMessageQueueSnapshot({
      ...previous,
      items,
      version: previous.version + 1,
      paused: command.kind === "pause" ? true : command.kind === "resume" ? false : previous.paused,
    });
    snapshots.set(key(command.scope), next);
    if (command.kind === "enqueue") seen.add(command.messageId);
    return decodeThreadMessageQueueResult({
      status: "applied",
      requestId: command.requestId,
      snapshot: next,
    });
  };
  return {
    snapshot,
    publish: (value: ThreadMessageQueueSnapshot) => snapshots.set(key(value.scope), value),
    apply,
    read: vi.fn(async (scope: ThreadMessageQueueScope) => snapshot(scope)),
    execute: vi.fn(async (command: ThreadMessageQueueCommand) => apply(command)),
  };
}
