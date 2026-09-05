import {
  decodeNativeHarnessContextRemaining,
  type AgentRun,
  type AgentRunAuthority,
  type ChatThread,
  type CodeThread,
  type ContextSubjectRef,
  type NativeHarnessContextRemaining,
  type NativeHarnessSlotCandidate,
  type OctantMode,
  type ProjectId,
  type ProviderInstanceId,
  type ToolActionAuthority,
  type WorkThread,
} from "@octant/contracts";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type { ContextHarnessService } from "../context/contextHarnessService";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { PlanService } from "../plan/planService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import type { NativeHarnessAuthority } from "./nativeHarnessAuthority";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import type { NativeHarnessQuestionStore } from "./nativeHarnessQuestions";
import { createNativeHarnessTodoPort } from "./nativeHarnessTodo";
import {
  createNativeHarnessTools,
  type NativeHarnessDelegatePort,
  type NativeHarnessShellPort,
  type NativeHarnessToolPorts,
} from "./nativeHarnessTools";

export interface NativeHarnessCompositionOptions {
  readonly authority: NativeHarnessAuthority;
  /** Whether a provider instance is one the harness drives; others get no harness tools. */
  readonly isHarnessProvider: (providerInstanceId: ProviderInstanceId) => boolean;
  readonly plans?: Pick<PlanService, "read" | "execute">;
  /** Code only: the sandboxed shell. */
  readonly shell?: NativeHarnessShellPort;
  readonly webSearch?: NativeHarnessToolPorts["webSearch"];
  readonly webFetch?: NativeHarnessToolPorts["webFetch"];
  readonly contextHarness?: Pick<ContextHarnessService, "inspect">;
  /** Delegation for a lead thread; absent on a host that cannot admit children. */
  readonly delegate?: (scope: {
    readonly parentThreadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }) => NativeHarnessDelegatePort;
  readonly hostId: ToolActionAuthority["hostId"];
  readonly readThreadTaint: (threadId: string) => boolean;
  /** Questions to the person; absent on a host with no surface to answer them. */
  readonly questions?: Pick<NativeHarnessQuestionStore, "ask">;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export interface NativeHarnessComposition {
  readonly forChat: (input: {
    readonly thread: ChatThread;
    readonly windowId: string;
  }) => AppManagedToolSet | undefined;
  readonly forWork: (input: {
    readonly thread: WorkThread;
    readonly projectRoot: string;
    readonly windowId: string;
  }) => AppManagedToolSet | undefined;
  readonly forCode: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly windowId: string;
  }) => AppManagedToolSet | undefined;
  /** A managed child's tools, from its own clamped authority; it never delegates further. */
  readonly forAgentRun: (input: {
    readonly run: AgentRun;
    readonly authority: AgentRunAuthority;
    readonly projectRoot: string;
  }) => AppManagedToolSet | undefined;
}

/**
 * Composes the harness tool set for one thread in one mode. The mode decides
 * the root and the ports; the catalog decides which tools exist in that mode;
 * the authority service decides each call. Every result is tainted before it
 * reaches the next model turn, like any other app-managed tool.
 */
export function createNativeHarnessComposition(
  options: NativeHarnessCompositionOptions,
): NativeHarnessComposition {
  const contextRemaining =
    options.contextHarness === undefined
      ? undefined
      : (subject: ContextSubjectRef) => (): NativeHarnessContextRemaining | undefined => {
          try {
            const snapshot = options.contextHarness!.inspect(subject);
            const plan = snapshot.next.plan;
            const used = Math.min(plan.plannedInputTokens, plan.safeInputBudget);
            return decodeNativeHarnessContextRemaining({
              safeInputBudgetTokens: plan.safeInputBudget,
              usedTokens: used,
              remainingTokens: plan.safeInputBudget - used,
              confidence: snapshot.modelLimits.confidence,
              source: "capacity-planner",
              measuredAt: snapshot.snapshotAt,
            });
          } catch {
            return undefined;
          }
        };
  const shared = (threadId: string): NativeHarnessToolPorts => ({
    ...(options.webFetch === undefined ? {} : { webFetch: options.webFetch }),
    ...(options.plans === undefined
      ? {}
      : {
          todo: createNativeHarnessTodoPort({ plans: options.plans, threadId, uuid: options.uuid }),
        }),
  });
  const compose = (input: {
    readonly threadId: string;
    readonly mode: "chat" | "work" | "code";
    readonly ports: NativeHarnessToolPorts;
  }): AppManagedToolSet =>
    taintAppManagedToolResults({
      tools: createNativeHarnessTools({
        threadId: input.threadId,
        mode: input.mode,
        authority: options.authority.service,
        resolveAuthority: () => options.authority.resolve(input.threadId, input.mode),
        ports: input.ports,
        uuid: options.uuid,
      }),
      threadId: input.threadId,
      recordExternalContentIngestion: options.recordExternalContentIngestion,
      uuid: options.uuid,
    });
  const leadOf = (thread: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: string;
  }): NativeHarnessSlotCandidate => ({
    hostId: options.hostId as never,
    providerInstanceId: thread.providerInstanceId,
    modelId: thread.modelId as never,
  });
  const askUserFor = (scope: {
    readonly parentThreadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }): Pick<NativeHarnessToolPorts, "askUser"> =>
    options.questions === undefined
      ? {}
      : {
          askUser: (input) =>
            options.questions!.ask({
              threadId: scope.parentThreadId,
              mode: scope.mode,
              projectId: scope.projectId,
              lead: scope.lead,
              prompt: input.prompt,
              options: input.options,
              signal: input.signal,
            }),
        };
  const delegateFor = (scope: {
    readonly parentThreadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }): Pick<NativeHarnessToolPorts, "delegate"> =>
    options.delegate === undefined ? {} : { delegate: options.delegate(scope) };
  return {
    forChat: ({ thread, windowId }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      return compose({
        threadId,
        mode: "chat",
        ports: {
          ...shared(threadId),
          ...delegateFor({
            parentThreadId: threadId,
            windowId,
            mode: "chat",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
          ...askUserFor({
            parentThreadId: threadId,
            mode: "chat",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
          // Research is the user's grant for a Chat thread to reach the web.
          ...(thread.researchEnabled && options.webSearch !== undefined
            ? { webSearch: options.webSearch }
            : {}),
          ...(contextRemaining === undefined
            ? {}
            : {
                contextRemaining: contextRemaining({
                  aggregateType: "chat-thread" as never,
                  aggregateId: threadId as never,
                }),
              }),
        },
      });
    },
    forWork: ({ thread, projectRoot, windowId }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      return compose({
        threadId,
        mode: "work",
        ports: {
          ...shared(threadId),
          ...delegateFor({
            parentThreadId: threadId,
            windowId,
            mode: "work",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
          ...askUserFor({
            parentThreadId: threadId,
            mode: "work",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
          filesystem: new NativeHarnessFileSystem({ root: projectRoot }),
          ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
        },
      });
    },
    forCode: ({ thread, checkoutRoot, windowId }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      return compose({
        threadId,
        mode: "code",
        ports: {
          ...shared(threadId),
          ...delegateFor({
            parentThreadId: threadId,
            windowId,
            mode: "code",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
          ...askUserFor({
            parentThreadId: threadId,
            mode: "code",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
          filesystem: new NativeHarnessFileSystem({ root: checkoutRoot }),
          ...(options.shell === undefined ? {} : { shell: options.shell }),
          ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
        },
      });
    },
    forAgentRun: ({ run, authority, projectRoot }) => {
      const target = run.routingReceipt.selectedFallback ?? {
        providerInstanceId: run.routingReceipt.selectedProviderInstanceId,
      };
      if (!options.isHarnessProvider(target.providerInstanceId)) return undefined;
      const mode = run.routingReceipt.mode;
      const runId = String(run.id);
      const projectId =
        run.workspaceReceipt.kind === "chat-virtual" ? undefined : run.workspaceReceipt.projectId;
      if (projectId === undefined) return undefined;
      // A child's authority is the run's own clamped grant, not a thread's
      // posture: the run record is what admission decided, so it is what
      // every tool call is judged against.
      const granted: ToolActionAuthority = {
        hostId: options.hostId,
        mode,
        projectId,
        providerInstanceId: target.providerInstanceId,
        extension: { kind: "core" },
      } as ToolActionAuthority;
      const service = new ToolCallAuthorityService({
        resolveGrantedAuthority: () => granted,
        resolveLiveFacts: () => ({
          providerAppManagedTools: "supported",
          host: { computerUseEnabled: false },
          executionPolicy: authority.executionPolicy,
          approvalSatisfied: authority.executionPolicy === "full-access",
          externalContentIngested: options.readThreadTaint(runId),
        }),
      });
      const tools = createNativeHarnessTools({
        threadId: runId,
        mode,
        authority: service,
        resolveAuthority: () => granted,
        ports: {
          ...(authority.filesystem && mode !== "chat"
            ? { filesystem: new NativeHarnessFileSystem({ root: projectRoot }) }
            : {}),
          ...(authority.shell && mode === "code" && options.shell !== undefined
            ? { shell: options.shell }
            : {}),
          ...(authority.network && options.webFetch !== undefined
            ? { webFetch: options.webFetch }
            : {}),
          ...(authority.network && options.webSearch !== undefined
            ? { webSearch: options.webSearch }
            : {}),
        },
        uuid: options.uuid,
      });
      return taintAppManagedToolResults({
        tools,
        threadId: runId,
        recordExternalContentIngestion: options.recordExternalContentIngestion,
        uuid: options.uuid,
      });
    },
  };
}
