import type { OpenCodeEvent } from "./openCodeEventMapper";

/** What Octant reports of one delegated OpenCode session. */
export interface OpenCodeChildActivity {
  readonly childAgentId: string;
  readonly parentChildAgentId?: string;
  readonly task?: string;
  readonly status: "starting" | "running" | "completed" | "failed";
  readonly summary: string;
}

export type OpenCodeChildRoute =
  | { readonly kind: "none" }
  | {
      readonly kind: "child";
      /** The session Octant started, which owns this delegated session. */
      readonly rootSource: string;
      readonly childSource: string;
      readonly activity?: OpenCodeChildActivity;
      /**
       * An event of the child that the owning session handles as its own: a
       * permission or question request, which must reach the person through
       * the parent's approval path, or a tool call that read outside content.
       * Everything else the child says stays out of the parent's transcript.
       */
      readonly forward?: OpenCodeEvent;
    };

const MAX_TRACKED_CHILDREN = 256;
const MAX_TASK_LENGTH = 200;

/** Events a child raises that the person's parent session must answer or mark. */
const FORWARDED_EVENTS: ReadonlySet<string> = new Set([
  "permission.asked",
  "permission.v2.asked",
  "permission.replied",
  "permission.v2.replied",
  "question.asked",
  "question.v2.asked",
  "question.replied",
  "question.rejected",
  "session.next.tool.called",
]);

function parentOf(event: OpenCodeEvent): string | undefined {
  const properties = event.properties as {
    readonly parentID?: unknown;
    readonly info?: { readonly parentID?: unknown; readonly title?: unknown };
  };
  const parent = properties.info?.parentID ?? properties.parentID;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

function titleOf(event: OpenCodeEvent): string | undefined {
  const title = (event.properties as { readonly info?: { readonly title?: unknown } }).info?.title;
  if (typeof title !== "string") return undefined;
  const first = title.split("\n")[0]?.trim() ?? "";
  return first.length === 0 ? undefined : first.slice(0, MAX_TASK_LENGTH);
}

/**
 * Follows the sessions OpenCode's `task` tool delegates to, as children of the
 * session Octant started. A child is learned from the `session.created` event
 * that names its parent, so a session OpenCode created for another reason is
 * never claimed. Its permission requests are handed back to the owning session
 * so they reach the person through the same approval path, and its web reads
 * mark the thread; nothing else a child says is shown as the parent's own.
 */
export class OpenCodeChildSessions {
  readonly #owners = new Map<string, { root: string; parent: string }>();
  readonly #statuses = new Map<string, OpenCodeChildActivity["status"]>();

  /** `source` is the session the event belongs to, as the driver read it. */
  route(
    event: OpenCodeEvent,
    source: string,
    isRoot: (source: string) => boolean,
  ): OpenCodeChildRoute {
    const type = String(event.type);
    if (type === "session.created") {
      const parent = parentOf(event);
      if (parent === undefined || this.#owners.has(source)) return { kind: "none" };
      const root = isRoot(parent) ? parent : this.#owners.get(parent)?.root;
      if (root === undefined || this.#owners.size >= MAX_TRACKED_CHILDREN) return { kind: "none" };
      this.#owners.set(source, { root, parent });
      const task = titleOf(event);
      return this.#child(source, {
        childAgentId: source,
        ...(this.#owners.has(parent) ? { parentChildAgentId: parent } : {}),
        ...(task === undefined ? {} : { task }),
        status: "starting",
        summary: "OpenCode delegated a task to a subagent.",
      });
    }
    if (!this.#owners.has(source)) return { kind: "none" };
    if (FORWARDED_EVENTS.has(type)) return this.#child(source, undefined, event);
    const status = this.#statusFor(event, type, source);
    return this.#child(source, status);
  }

  /** Forgets the children of a session that ended. */
  forget(rootSource: string): void {
    for (const [child, owner] of this.#owners) {
      if (owner.root !== rootSource) continue;
      this.#owners.delete(child);
      this.#statuses.delete(child);
    }
  }

  #statusFor(
    event: OpenCodeEvent,
    type: string,
    source: string,
  ): OpenCodeChildActivity | undefined {
    const status = (() => {
      if (type === "session.status") {
        const reported = (event.properties as { readonly status?: { readonly type?: unknown } })
          .status?.type;
        if (reported === "busy") return "running" as const;
        if (reported === "idle") return "completed" as const;
        return undefined;
      }
      if (type === "session.idle") return "completed" as const;
      if (type === "session.error") return "failed" as const;
      return undefined;
    })();
    if (status === undefined) return undefined;
    const parent = this.#owners.get(source)?.parent;
    return {
      childAgentId: source,
      ...(parent !== undefined && this.#owners.has(parent) ? { parentChildAgentId: parent } : {}),
      status,
      summary:
        status === "running"
          ? "The subagent is working."
          : status === "completed"
            ? "The subagent finished."
            : "The subagent stopped before it finished.",
    };
  }

  #child(
    childSource: string,
    activity: OpenCodeChildActivity | undefined,
    forward?: OpenCodeEvent,
  ): OpenCodeChildRoute {
    const owner = this.#owners.get(childSource);
    if (owner === undefined) return { kind: "none" };
    // A status is reported once; a finished child stays finished.
    const previous = this.#statuses.get(childSource);
    const fresh =
      activity !== undefined &&
      activity.status !== previous &&
      previous !== "completed" &&
      previous !== "failed";
    if (fresh) this.#statuses.set(childSource, activity.status);
    // A finished child frees its place, so a long turn that delegates many
    // tasks never fills the table and leaves a later child unanswered.
    if (fresh && (activity.status === "completed" || activity.status === "failed")) {
      this.#owners.delete(childSource);
      this.#statuses.delete(childSource);
    }
    return {
      kind: "child",
      rootSource: owner.root,
      childSource,
      ...(fresh ? { activity } : {}),
      ...(forward === undefined ? {} : { forward }),
    };
  }
}
