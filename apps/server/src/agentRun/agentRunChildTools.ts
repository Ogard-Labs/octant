import type {
  AgentRun,
  AgentRunAuthority,
  OctantMode,
  ProjectId,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
  WindowId,
} from "@octant/contracts";
import { effectiveAgentRunExecutionTarget } from "@octant/domain/agent-run-policy";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { NativeHarnessChildInteractions } from "../harness/nativeHarnessComposition";

/**
 * One of a thread's Octant tools as its child run is judged for it.
 *
 * A child is never handed its parent's tool set, window, or authority. Each
 * inherited tool is built again from the child's own run: its recorded
 * workspace, its clamped grant, and the model it runs on. What the parent adds
 * is a ceiling, read again on every call: the parent's live grant, the tools
 * its profile allows, and whether its own provider carries Octant's tools.
 */
export interface AgentRunChildToolHost {
  readonly run: AgentRun;
  /** The child's own identity, which every mark, session and process is kept under. */
  readonly runId: string;
  readonly mode: OctantMode;
  /** Where the child's asks are shown; never whom the child acts as. */
  readonly parentThreadId: string;
  readonly projectId: ProjectId | undefined;
  readonly target: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
  readonly authority: AgentRunAuthority;
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The child's own folder: its worktree in Code, the Project's folder in Work, none in Chat. */
  readonly folder: string | undefined;
  /** The window that owns this execution now; nothing once it is revoked or a restart lost it. */
  readonly window: () => WindowId | undefined;
  /** Whether the child still holds every fact its tools were offered under. */
  readonly current: () => boolean;
  /**
   * Whether a person can answer what the child asks: not under a routine's or
   * another host-started turn, and not in Plan, which asks for nothing.
   */
  readonly attended: () => boolean;
  /** Asks on the parent thread for this one act; a person's silence waits, and nothing is remembered. */
  readonly ask: (input: {
    readonly summary: string;
    readonly approvalClass: string;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<"approved" | "denied" | "cancelled">;
}

export interface AgentRunChildToolInput {
  readonly run: AgentRun;
  readonly authority: AgentRunAuthority;
  readonly projectRoot: string;
}

export interface AgentRunChildToolDependencies {
  /** The child's run still holds its recorded grant under its parent's live one. */
  readonly isCurrent: (run: AgentRun) => boolean;
  /** Whether a provider launch at this level proved it carries Octant's tools. */
  readonly carriesTools: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly executionPolicy: ProviderExecutionPolicy;
  }) => boolean;
  /** The parent as it stands now; undefined when it can no longer be read or offers no tools. */
  readonly parent: (run: AgentRun) =>
    | {
        readonly toolConstraints: ReadonlyArray<string>;
        /** The parent's running turn, or the parent with none, is in Plan. */
        readonly inPlan: boolean;
        readonly carriesTools: boolean;
      }
    | undefined;
  readonly window: (run: AgentRun) => WindowId | undefined;
  /** A live window, or a device the host's own person paired. */
  readonly windowCanAnswer: (windowId: WindowId) => boolean;
  readonly approvals: (
    run: AgentRun,
  ) => Pick<NativeHarnessChildInteractions, "askTool"> | undefined;
  readonly toolAllowed: (toolConstraints: ReadonlyArray<string>, toolName: string) => boolean;
}

/** Answers nothing until a call: a session is composed once to be checked and again to run. */
export type ResolveAgentRunChildToolHost = (
  input: AgentRunChildToolInput,
  toolName: string,
) => AgentRunChildToolHost | undefined;

export function createAgentRunChildToolHosts(
  deps: AgentRunChildToolDependencies,
): ResolveAgentRunChildToolHost {
  return ({ run, authority, projectRoot }, toolName) => {
    if (!authority.tools) return undefined;
    const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
    const executionPolicy = authority.executionPolicy;
    const parentOffers = (): boolean => {
      const parent = deps.parent(run);
      return (
        parent !== undefined &&
        parent.carriesTools &&
        deps.toolAllowed(parent.toolConstraints, toolName) &&
        // A parent turn narrowed to Plan leaves a wider child nothing to act under.
        (!parent.inPlan || executionPolicy === "plan")
      );
    };
    if (!parentOffers() || !deps.carriesTools({ ...target, executionPolicy })) return undefined;
    const workspace = run.workspaceReceipt;
    const window = () => deps.window(run);
    const attended = () => {
      if (executionPolicy === "plan") return false;
      const owner = window();
      return owner !== undefined && deps.windowCanAnswer(owner);
    };
    return {
      run,
      runId: String(run.id),
      mode: run.routingReceipt.mode,
      parentThreadId: String(run.parentThreadId),
      projectId:
        workspace.kind === "chat-virtual" ? run.routingReceipt.projectId : workspace.projectId,
      target,
      authority,
      executionPolicy,
      folder: workspace.kind === "chat-virtual" ? undefined : projectRoot,
      window,
      current: () => deps.isCurrent(run) && parentOffers(),
      attended,
      ask: async ({ summary, approvalClass, signal }) => {
        if (!attended()) return "denied";
        const ask = deps.approvals(run)?.askTool;
        return ask === undefined ? "denied" : await ask({ summary, approvalClass, signal });
      },
    };
  };
}

/**
 * A tool set that answers only while the child holds what it was offered
 * under, judged at the call rather than when the session was composed.
 */
export function whileChildHolds(
  host: Pick<AgentRunChildToolHost, "current">,
  tools: AppManagedToolSet | undefined,
): AppManagedToolSet | undefined {
  if (tools === undefined) return undefined;
  return {
    ...tools,
    execute: (call) =>
      host.current()
        ? tools.execute(call)
        : Promise.resolve({
            result: {
              error: "child-authority-changed",
              message:
                "This child run no longer holds the authority this tool needs. Continue without it and say so.",
            },
            isError: true,
          }),
  };
}

/** Committed facts that can end what a child run was offered its tools under. */
export const CHILD_AUTHORITY_AGGREGATES: ReadonlySet<string> = new Set([
  "agent-run",
  "chat-thread",
  "code-checkout",
  "code-thread",
  "project",
  "provider-instance",
  "shell-settings",
  "window-workspace",
  "work-thread",
]);

/**
 * What child runs have running: terminals, debug sessions, devices, screens.
 * Each is stopped when its run ends, and as soon as its run no longer holds
 * the grant it was started under, so a parent moved to Plan or archived
 * leaves nothing of its children behind.
 */
export class AgentRunChildResources {
  readonly #held = new Map<
    symbol,
    { readonly current: () => boolean; readonly stop: () => Promise<void> }
  >();

  /** Keeps one started thing until it is stopped; the returned stop is safe to repeat. */
  hold(
    host: Pick<AgentRunChildToolHost, "current">,
    stop: () => Promise<void>,
  ): () => Promise<void> {
    const key = Symbol("agent-run-child-resource");
    let stopping: Promise<void> | undefined;
    const once = () => {
      stopping ??= stop().finally(() => this.#held.delete(key));
      return stopping;
    };
    this.#held.set(key, { current: host.current, stop: once });
    return once;
  }

  /** Stops what its run no longer holds; called when an authority fact changed. */
  async settle(): Promise<void> {
    await Promise.allSettled(
      [...this.#held.values()].flatMap((held) => (held.current() ? [] : [held.stop()])),
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#held.values()].map((held) => held.stop()));
  }
}

/**
 * A tool set whose calls start something that lives between them. What a call
 * needs is acquired at the first call, because a session is composed once to
 * be checked and again to run; it is stopped when the run ends or no longer
 * holds its grant, and acquired again only by a call the child may make.
 */
export function whileChildRuns(input: {
  readonly host: AgentRunChildToolHost;
  readonly resources: AgentRunChildResources;
  readonly tools: AppManagedToolSet | undefined;
  /** Starts holding; the returned stop ends everything the calls started. */
  readonly acquire: () => () => Promise<void>;
}): AppManagedToolSet | undefined {
  const { host, resources, tools } = input;
  if (tools === undefined) return undefined;
  let stop: (() => Promise<void>) | undefined;
  let closed = false;
  const held = whileChildHolds(host, {
    ...tools,
    execute: async (call) => {
      if (closed) return { result: { error: "tool-closed" }, isError: true };
      if (stop === undefined) {
        const end = input.acquire();
        stop = resources.hold(host, async () => {
          stop = undefined;
          await end();
        });
      }
      const result = await tools.execute(call);
      // A call that outlived the run's grant must not leave what it started.
      if (!host.current()) await stop?.();
      return result;
    },
  });
  return held === undefined
    ? undefined
    : {
        ...held,
        close: async () => {
          closed = true;
          await stop?.();
          await tools.close?.();
        },
      };
}
