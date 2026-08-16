import type {
  ChatThreadId,
  ThreadFollowUp,
  ThreadWorkCommand,
  ThreadWorkItem,
} from "@octant/contracts/chat";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";

export type ThreadWorkPolicyRejectionCode =
  | "stale-version"
  | "thread-mismatch"
  | "duplicate-item"
  | "item-not-found"
  | "invalid-title"
  | "invalid-status-transition"
  | "invalid-reorder"
  | "follow-up-already-closed"
  | "invalid-acknowledgement";

export class ThreadWorkPolicyRejected extends Error {
  override readonly name = "ThreadWorkPolicyRejected";

  constructor(
    readonly code: ThreadWorkPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ThreadWorkPolicyRejectionCode, message: string): never {
  throw new ThreadWorkPolicyRejected(code, message);
}

export interface ThreadWorkList {
  readonly threadId: ChatThreadId;
  readonly version: AggregateVersion;
  readonly items: ReadonlyArray<ThreadWorkItem>;
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    reject("invalid-title", "Work item title cannot be empty");
  }
  return normalized;
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

function sortItems(items: ReadonlyArray<ThreadWorkItem>): ThreadWorkItem[] {
  return [...items].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function findItem(list: ThreadWorkList, itemId: ThreadWorkItem["id"]): ThreadWorkItem {
  const item = list.items.find((i) => i.id === itemId);
  if (item === undefined) {
    reject("item-not-found", `Work item ${itemId} not found`);
  }
  return item;
}

function assertExpectedVersion(list: ThreadWorkList, expectedVersion: AggregateVersion): void {
  if (list.version !== expectedVersion) {
    reject("stale-version", `Expected version ${expectedVersion}, got ${list.version}`);
  }
}

function assertThreadMatch(list: ThreadWorkList, threadId: ChatThreadId): void {
  if (list.threadId !== threadId) {
    reject("thread-mismatch", "Command threadId does not match work list");
  }
}

const terminalStatuses: ReadonlyArray<ThreadWorkItem["status"]> = ["completed", "cancelled"];

function isTerminal(status: ThreadWorkItem["status"]): boolean {
  return terminalStatuses.includes(status);
}

function applyStatusTransition(
  item: ThreadWorkItem,
  newStatus: ThreadWorkItem["status"],
  newVersion: AggregateVersion,
  updatedAt: UtcTimestamp,
): ThreadWorkItem {
  if (item.status === newStatus) {
    if (isTerminal(newStatus)) {
      reject("invalid-status-transition", `Item is already ${newStatus}`);
    }
    return { ...item, version: newVersion, updatedAt };
  }

  if (isTerminal(item.status) && isTerminal(newStatus)) {
    reject("invalid-status-transition", `Cannot transition from ${item.status} to ${newStatus}`);
  }

  if (newStatus === "completed" || newStatus === "cancelled") {
    return { ...item, status: newStatus, version: newVersion, updatedAt };
  }

  if (newStatus === "pending") {
    if (!isTerminal(item.status)) {
      reject("invalid-status-transition", `Cannot reopen an item that is ${item.status}`);
    }
    return { ...item, status: "pending", version: newVersion, updatedAt };
  }

  if (newStatus === "in-progress") {
    if (item.status !== "pending" && item.status !== "blocked") {
      reject("invalid-status-transition", `Cannot start an item that is ${item.status}`);
    }
    return { ...item, status: "in-progress", version: newVersion, updatedAt };
  }

  if (newStatus === "blocked") {
    if (item.status !== "pending" && item.status !== "in-progress") {
      reject("invalid-status-transition", `Cannot block an item that is ${item.status}`);
    }
    return { ...item, status: "blocked", version: newVersion, updatedAt };
  }

  return reject("invalid-status-transition", `Unsupported status ${newStatus}`);
}

function addWorkItem(
  list: ThreadWorkList,
  command: Extract<ThreadWorkCommand, { kind: "add-chat-work-item" }>,
  now: UtcTimestamp,
): ThreadWorkList {
  assertExpectedVersion(list, command.expectedVersion);

  if (list.items.some((item) => item.id === command.itemId)) {
    reject("duplicate-item", `Work item ${command.itemId} already exists`);
  }

  const newVersion = nextVersion(list.version);
  const newItem: ThreadWorkItem = {
    id: command.itemId,
    threadId: list.threadId,
    title: normalizeTitle(command.title),
    detail: command.detail,
    status: command.status,
    position: command.position,
    origin: command.origin,
    version: newVersion,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...list,
    version: newVersion,
    items: sortItems([...list.items, newItem]),
  };
}

function editWorkItem(
  list: ThreadWorkList,
  command: Extract<ThreadWorkCommand, { kind: "edit-chat-work-item" }>,
  now: UtcTimestamp,
): ThreadWorkList {
  assertExpectedVersion(list, command.expectedVersion);
  const existing = findItem(list, command.itemId);
  const newVersion = nextVersion(list.version);

  const title = command.title !== undefined ? normalizeTitle(command.title) : existing.title;
  const detail = command.detail !== undefined ? command.detail : existing.detail;
  const position = command.position !== undefined ? command.position : existing.position;

  const updated: ThreadWorkItem = {
    ...existing,
    title,
    detail,
    position,
    version: newVersion,
    updatedAt: now,
  };

  const nextItems = list.items.map((item) => (item.id === command.itemId ? updated : item));

  return {
    ...list,
    version: newVersion,
    items: sortItems(nextItems),
  };
}

function completeWorkItem(
  list: ThreadWorkList,
  command: Extract<ThreadWorkCommand, { kind: "complete-chat-work-item" }>,
  now: UtcTimestamp,
): ThreadWorkList {
  assertExpectedVersion(list, command.expectedVersion);
  const existing = findItem(list, command.itemId);
  const newVersion = nextVersion(list.version);
  const updated = applyStatusTransition(existing, "completed", newVersion, now);
  return {
    ...list,
    version: newVersion,
    items: list.items.map((item) => (item.id === command.itemId ? updated : item)),
  };
}

function cancelWorkItem(
  list: ThreadWorkList,
  command: Extract<ThreadWorkCommand, { kind: "cancel-chat-work-item" }>,
  now: UtcTimestamp,
): ThreadWorkList {
  assertExpectedVersion(list, command.expectedVersion);
  const existing = findItem(list, command.itemId);
  const newVersion = nextVersion(list.version);
  const updated = applyStatusTransition(existing, "cancelled", newVersion, now);
  return {
    ...list,
    version: newVersion,
    items: list.items.map((item) => (item.id === command.itemId ? updated : item)),
  };
}

function reopenWorkItem(
  list: ThreadWorkList,
  command: Extract<ThreadWorkCommand, { kind: "reopen-chat-work-item" }>,
  now: UtcTimestamp,
): ThreadWorkList {
  assertExpectedVersion(list, command.expectedVersion);
  const existing = findItem(list, command.itemId);
  const newVersion = nextVersion(list.version);
  const updated = applyStatusTransition(existing, "pending", newVersion, now);
  return {
    ...list,
    version: newVersion,
    items: list.items.map((item) => (item.id === command.itemId ? updated : item)),
  };
}

function reorderWorkItems(
  list: ThreadWorkList,
  command: Extract<ThreadWorkCommand, { kind: "reorder-chat-work-items" }>,
  now: UtcTimestamp,
): ThreadWorkList {
  assertExpectedVersion(list, command.expectedVersion);

  const currentIds = new Set(list.items.map((item) => item.id));
  const commandIds = new Set(command.itemIds);

  if (commandIds.size !== command.itemIds.length) {
    reject("invalid-reorder", "Reorder list contains duplicate item ids");
  }

  if (commandIds.size !== currentIds.size || [...commandIds].some((id) => !currentIds.has(id))) {
    reject("invalid-reorder", "Reorder list must contain exactly the current work items");
  }

  const indexMap = new Map<ThreadWorkItem["id"], number>();
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    if (item === undefined) continue;
    indexMap.set(item.id, i);
  }

  const newVersion = nextVersion(list.version);
  const reordered: ThreadWorkItem[] = [];
  for (let i = 0; i < command.itemIds.length; i++) {
    const id = command.itemIds[i];
    if (id === undefined) {
      reject("invalid-reorder", "Reorder list contains an undefined item id");
    }
    const originalIndex = indexMap.get(id);
    if (originalIndex === undefined) {
      reject("invalid-reorder", `Unknown work item id ${id}`);
    }
    const original = list.items[originalIndex];
    if (original === undefined) {
      reject("invalid-reorder", `Work item ${id} disappeared`);
    }
    reordered.push({
      ...original,
      position: i,
      version: newVersion,
      updatedAt: now,
    });
  }

  return {
    ...list,
    version: newVersion,
    items: reordered,
  };
}

export function applyThreadWorkCommand(
  list: ThreadWorkList,
  command: ThreadWorkCommand,
  now: UtcTimestamp,
): ThreadWorkList {
  assertThreadMatch(list, command.threadId);

  switch (command.kind) {
    case "add-chat-work-item":
      return addWorkItem(list, command, now);
    case "edit-chat-work-item":
      return editWorkItem(list, command, now);
    case "complete-chat-work-item":
      return completeWorkItem(list, command, now);
    case "cancel-chat-work-item":
      return cancelWorkItem(list, command, now);
    case "reopen-chat-work-item":
      return reopenWorkItem(list, command, now);
    case "reorder-chat-work-items":
      return reorderWorkItems(list, command, now);
    default:
      throw new Error(`Unhandled work command kind: ${(command as { kind: string }).kind}`);
  }
}

export interface FollowUpTrigger {
  readonly sequence: number;
  readonly reason: string;
  readonly origin: "manual" | "automatic";
  readonly triggeredAt: UtcTimestamp;
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length === 0) {
    reject("invalid-title", "Follow-up reason cannot be empty");
  }
  return normalized;
}

export function evaluateFollowUpTrigger(
  threadId: ChatThreadId,
  current: ThreadFollowUp | undefined,
  trigger: FollowUpTrigger,
): ThreadFollowUp {
  const reason = normalizeReason(trigger.reason);

  if (current === undefined) {
    return {
      threadId,
      state: "open",
      origin: trigger.origin,
      reason,
      triggerSequence: trigger.sequence,
      acknowledgedThroughSequence: 0,
      createdAt: trigger.triggeredAt,
    } as ThreadFollowUp;
  }

  if (current.state === "completed" && trigger.sequence > current.acknowledgedThroughSequence) {
    return {
      ...current,
      state: "open",
      origin: trigger.origin,
      reason,
      triggerSequence: trigger.sequence,
      completedAt: undefined,
    } as ThreadFollowUp;
  }

  if (current.state === "open" && trigger.sequence > current.triggerSequence) {
    return {
      ...current,
      origin: trigger.origin,
      reason,
      triggerSequence: trigger.sequence,
    };
  }

  return current;
}

export interface CompleteFollowUpInput {
  readonly expectedVersion: AggregateVersion;
  readonly acknowledgedThroughSequence: number;
  readonly completedAt: UtcTimestamp;
}

export function completeFollowUp(
  currentVersion: AggregateVersion,
  followUp: ThreadFollowUp,
  input: CompleteFollowUpInput,
): ThreadFollowUp {
  if (currentVersion !== input.expectedVersion) {
    reject("stale-version", `Expected version ${input.expectedVersion}, got ${currentVersion}`);
  }

  if (followUp.state !== "open") {
    reject("follow-up-already-closed", "Follow-up is already completed");
  }

  if (
    input.acknowledgedThroughSequence !== followUp.triggerSequence ||
    input.acknowledgedThroughSequence <= followUp.acknowledgedThroughSequence
  ) {
    reject(
      "invalid-acknowledgement",
      "Acknowledged sequence must match the current trigger and exceed the previous acknowledgement",
    );
  }

  return {
    ...followUp,
    state: "completed",
    acknowledgedThroughSequence: input.acknowledgedThroughSequence,
    completedAt: input.completedAt,
  } as ThreadFollowUp;
}
