import type {
  OctantMode,
  ProjectId,
  RetentionScope,
  RetentionWindow,
  ThreadRetentionDeletedScope,
  ThreadRetentionRetainedScope,
  ThreadRetentionThreadId,
} from "@octant/contracts";
import {
  authorizePrincipalAction,
  type PrincipalActionDecision,
  type PrincipalKind,
} from "./remoteAccessPolicy";

/**
 * Pure policy for thread retention windows and confirmed purge.
 *
 * Setting a window never deletes. A purge requires an explicit confirmation
 * and a local principal. The narrower scope wins when a thread, its Project,
 * and the host each have a window. Storage, journal, and Effect stay out of
 * this module so the refusals stay deterministic.
 */

export const THREAD_RETENTION_ACTION_NAMES = {
  read: "host.store.retention",
  set: "host.store.retention",
  purge: "host.store.purge",
} as const;

export type ThreadRetentionOperation = "read" | "set" | "purge";

export function authorizeThreadRetentionAction(input: {
  readonly principalKind: PrincipalKind;
  readonly operation: ThreadRetentionOperation;
}): PrincipalActionDecision {
  return authorizePrincipalAction({
    principalKind: input.principalKind,
    action: THREAD_RETENTION_ACTION_NAMES[input.operation],
  });
}

export interface RetentionWindowBinding {
  readonly scope: RetentionScope;
  readonly window: RetentionWindow;
}

export interface ThreadRetentionSubject {
  readonly mode: OctantMode;
  readonly threadId: ThreadRetentionThreadId;
  readonly projectId?: ProjectId;
  readonly updatedAt: string;
}

export function resolveEffectiveRetentionWindow(input: {
  readonly subject: ThreadRetentionSubject;
  readonly windows: ReadonlyArray<RetentionWindowBinding>;
}): RetentionWindow {
  const threadWindow = input.windows.find(
    (entry) =>
      entry.scope.kind === "thread" &&
      entry.scope.mode === input.subject.mode &&
      String(entry.scope.threadId) === String(input.subject.threadId),
  );
  if (threadWindow !== undefined) return threadWindow.window;

  const projectId = input.subject.projectId;
  if (projectId !== undefined) {
    const projectWindow = input.windows.find(
      (entry) =>
        entry.scope.kind === "project" && String(entry.scope.projectId) === String(projectId),
    );
    if (projectWindow !== undefined) return projectWindow.window;
  }

  const hostWindow = input.windows.find((entry) => entry.scope.kind === "host");
  return hostWindow?.window ?? { kind: "forever" };
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export function isThreadPastRetention(input: {
  readonly subject: ThreadRetentionSubject;
  readonly window: RetentionWindow;
  readonly now: string;
}): boolean {
  if (input.window.kind === "forever") return false;
  const updated = Date.parse(input.subject.updatedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(updated) || !Number.isFinite(now)) return false;
  return now - updated >= input.window.days * MS_PER_DAY;
}

export type ThreadRetentionDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "confirmation-required"
        | "unauthorized"
        | "unknown-thread"
        | "unknown-project"
        | "invalid";
      readonly guidance: string;
    };

const UNAUTHORIZED_GUIDANCE = "Thread retention can only be changed on this host.";
const CONFIRMATION_GUIDANCE = "A purge requires an explicit confirmation.";

export function decideSetRetentionWindow(input: {
  readonly principalKind: PrincipalKind;
  readonly scope: RetentionScope;
  readonly threadExists?: boolean;
  readonly projectExists?: boolean;
}): ThreadRetentionDecision {
  const authority = authorizeThreadRetentionAction({
    principalKind: input.principalKind,
    operation: "set",
  });
  if (authority.kind === "deny") {
    return { kind: "refused", reason: "unauthorized", guidance: UNAUTHORIZED_GUIDANCE };
  }
  if (input.scope.kind === "thread" && input.threadExists === false) {
    return {
      kind: "refused",
      reason: "unknown-thread",
      guidance: "That thread is not on this host.",
    };
  }
  if (input.scope.kind === "project" && input.projectExists === false) {
    return {
      kind: "refused",
      reason: "unknown-project",
      guidance: "That Project is not on this host.",
    };
  }
  return { kind: "allow" };
}

export function decidePurgeThreads(input: {
  readonly principalKind: PrincipalKind;
  readonly confirm: boolean;
  readonly scope: RetentionScope;
  readonly threadExists?: boolean;
  readonly threadAlreadyPurged?: boolean;
  readonly projectExists?: boolean;
}): ThreadRetentionDecision {
  const authority = authorizeThreadRetentionAction({
    principalKind: input.principalKind,
    operation: "purge",
  });
  if (authority.kind === "deny") {
    return { kind: "refused", reason: "unauthorized", guidance: UNAUTHORIZED_GUIDANCE };
  }
  if (input.confirm !== true) {
    return { kind: "refused", reason: "confirmation-required", guidance: CONFIRMATION_GUIDANCE };
  }
  if (input.scope.kind === "thread" && input.threadAlreadyPurged === true) {
    return { kind: "allow" };
  }
  if (input.scope.kind === "thread" && input.threadExists === false) {
    return {
      kind: "refused",
      reason: "unknown-thread",
      guidance: "That thread is not on this host.",
    };
  }
  if (input.scope.kind === "project" && input.projectExists === false) {
    return {
      kind: "refused",
      reason: "unknown-project",
      guidance: "That Project is not on this host.",
    };
  }
  return { kind: "allow" };
}

export const THREAD_PURGE_RETAINED_SCOPES: ReadonlyArray<ThreadRetentionRetainedScope> = [
  "host-identity",
  "store-schema",
  "other-threads",
  "projects",
  "usage-records",
  "credentials",
  "external-repositories",
  "sqlite-free-pages",
];

export const THREAD_PURGE_DELETED_SCOPES: ReadonlyArray<ThreadRetentionDeletedScope> = [
  "thread-journal",
  "thread-projections",
  "thread-content",
  "thread-attachments",
];

export function selectThreadsForPurge(input: {
  readonly scope: RetentionScope;
  readonly subjects: ReadonlyArray<ThreadRetentionSubject>;
  readonly windows: ReadonlyArray<RetentionWindowBinding>;
  readonly now: string;
}): ReadonlyArray<ThreadRetentionSubject> {
  const scope = input.scope;
  if (scope.kind === "thread") {
    const mode = scope.mode;
    const threadId = scope.threadId;
    return input.subjects.filter(
      (subject) => subject.mode === mode && String(subject.threadId) === String(threadId),
    );
  }

  const inScope = (() => {
    if (scope.kind !== "project") return input.subjects;
    const projectId = scope.projectId;
    return input.subjects.filter(
      (subject) =>
        subject.projectId !== undefined && String(subject.projectId) === String(projectId),
    );
  })();

  return inScope.filter((subject) =>
    isThreadPastRetention({
      subject,
      window: resolveEffectiveRetentionWindow({ subject, windows: input.windows }),
      now: input.now,
    }),
  );
}
