import {
  decodeProviderModelId,
  MAX_PROVIDER_CHILD_FINAL_SUMMARY,
  type ProviderChildUsage,
  type ProviderModelId,
} from "@octant/contracts";
import {
  boundedChildFinalSummary,
  reportedChildUsage,
} from "@octant/provider-sdk/child-observations";
import type { OpenCodeEvent } from "./openCodeEventMapper";

/** What Octant reports of one delegated OpenCode session. */
export interface OpenCodeChildActivity {
  readonly childAgentId: string;
  readonly parentChildAgentId?: string;
  readonly modelId?: ProviderModelId;
  readonly task?: string;
  readonly status: "starting" | "running" | "completed" | "failed";
  readonly summary: string;
  readonly finalSummary?: string;
  readonly usage?: ProviderChildUsage;
}

/**
 * What a child's own assistant messages reported: the model that answered,
 * each message's token counts, and its latest text, which OpenCode's `task`
 * tool hands back to the parent as the child's result.
 */
interface OpenCodeChildReport {
  modelId?: ProviderModelId;
  readonly tokens: Map<string, { readonly input: number; readonly output: number }>;
  lastText?: string;
}

const MAX_TRACKED_MESSAGES = 256;

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
  readonly #reports = new Map<string, OpenCodeChildReport>();

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
      if (root === undefined) return { kind: "none" };
      // A finished child's place is freed only when the table is full, so a
      // child that OpenCode resumes keeps its owner while it can.
      if (this.#owners.size >= MAX_TRACKED_CHILDREN) {
        const finished = [...this.#owners.keys()].find((child) => {
          const status = this.#statuses.get(child);
          return status === "completed" || status === "failed";
        });
        if (finished === undefined) return { kind: "none" };
        this.#owners.delete(finished);
        this.#statuses.delete(finished);
        this.#reports.delete(finished);
      }
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
    if (type === "message.updated" || type === "message.part.updated") {
      const learnedModel = this.#readReport(event, type, source);
      const status = this.#statuses.get(source);
      // The model is first known from the child's first answer, after it
      // started; it is reported then, under the status the child already has.
      if (learnedModel === undefined || status === undefined) return this.#child(source, undefined);
      return this.#child(
        source,
        {
          ...this.#lineage(source),
          modelId: learnedModel,
          status,
          summary:
            status === "starting"
              ? "OpenCode delegated a task to a subagent."
              : "The subagent is working.",
        },
        undefined,
        true,
      );
    }
    const status = this.#statusFor(event, type, source);
    return this.#child(source, status);
  }

  /**
   * Whether `child` is a subagent session of the session `rootSource` that
   * has not reported finishing. A stop names a child by its session id, and
   * aborting a session that belongs to another root would stop work this
   * session never started.
   */
  runsUnder(child: string, rootSource: string): boolean {
    const owner = this.#owners.get(child);
    if (owner === undefined || owner.root !== rootSource) return false;
    const status = this.#statuses.get(child);
    return status !== "completed" && status !== "failed";
  }

  /** Forgets the children of a session that ended. */
  forget(rootSource: string): void {
    for (const [child, owner] of this.#owners) {
      if (owner.root !== rootSource) continue;
      this.#owners.delete(child);
      this.#statuses.delete(child);
      this.#reports.delete(child);
    }
  }

  #lineage(source: string): {
    readonly childAgentId: string;
    readonly parentChildAgentId?: string;
  } {
    const parent = this.#owners.get(source)?.parent;
    return {
      childAgentId: source,
      ...(parent !== undefined && this.#owners.has(parent) ? { parentChildAgentId: parent } : {}),
    };
  }

  /** Records what a child's assistant message reported; returns a model first learned here. */
  #readReport(event: OpenCodeEvent, type: string, source: string): ProviderModelId | undefined {
    const report: OpenCodeChildReport = this.#reports.get(source) ?? { tokens: new Map() };
    this.#reports.set(source, report);
    if (type === "message.part.updated") {
      const part = (event.properties as { readonly part?: Readonly<Record<string, unknown>> }).part;
      if (
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true &&
        part.ignored !== true &&
        part.text.trim().length > 0
      ) {
        report.lastText = part.text.slice(0, MAX_PROVIDER_CHILD_FINAL_SUMMARY * 2);
      }
      return undefined;
    }
    const info = (event.properties as { readonly info?: Readonly<Record<string, unknown>> }).info;
    if (info?.role !== "assistant" || typeof info.id !== "string") return undefined;
    const tokens = info.tokens as
      | { readonly input?: unknown; readonly output?: unknown }
      | undefined;
    const counted = reportedChildUsage({
      inputTokens: tokens?.input,
      outputTokens: tokens?.output,
    });
    if (
      counted?.inputTokens !== undefined &&
      counted.outputTokens !== undefined &&
      (report.tokens.has(info.id) || report.tokens.size < MAX_TRACKED_MESSAGES)
    ) {
      report.tokens.set(info.id, { input: counted.inputTokens, output: counted.outputTokens });
    }
    if (report.modelId !== undefined) return undefined;
    const provider = typeof info.providerID === "string" ? info.providerID.trim() : "";
    const model = typeof info.modelID === "string" ? info.modelID.trim() : "";
    if (provider.length === 0 || model.length === 0 || provider.length + model.length > 254)
      return undefined;
    // Octant names an OpenCode model as `provider/model`, as the session's own.
    report.modelId = decodeProviderModelId(`${provider}/${model}`);
    return report.modelId;
  }

  /** The child's closing text and summed usage, for the report that it finished. */
  #closing(source: string): Pick<OpenCodeChildActivity, "finalSummary" | "usage"> {
    const report = this.#reports.get(source);
    if (report === undefined) return {};
    const finalSummary = boundedChildFinalSummary(report.lastText);
    let input = 0;
    let output = 0;
    for (const counts of report.tokens.values()) {
      input += counts.input;
      output += counts.output;
    }
    const usage =
      report.tokens.size === 0
        ? undefined
        : reportedChildUsage({ inputTokens: input, outputTokens: output });
    return {
      ...(finalSummary === undefined ? {} : { finalSummary }),
      ...(usage === undefined ? {} : { usage }),
    };
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
    return {
      ...this.#lineage(source),
      ...(status === "completed" ? this.#closing(source) : {}),
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
    learnedModel = false,
  ): OpenCodeChildRoute {
    const owner = this.#owners.get(childSource);
    if (owner === undefined) return { kind: "none" };
    // A status is reported once; a finished child stays finished.
    const previous = this.#statuses.get(childSource);
    // A finished child OpenCode resumes through `task_id` keeps its session,
    // so it reports again when it runs.
    const fresh = activity !== undefined && (learnedModel || activity.status !== previous);
    if (fresh) this.#statuses.set(childSource, activity.status);

    return {
      kind: "child",
      rootSource: owner.root,
      childSource,
      ...(fresh ? { activity } : {}),
      ...(forward === undefined ? {} : { forward }),
    };
  }
}
