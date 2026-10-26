import {
  decodeNativeHarnessContextRemaining,
  type AgentRun,
  type AgentRunAuthority,
  type ChatThread,
  type CodeThread,
  type ContextSubjectRef,
  type NativeHarnessCommandHost,
  type NativeHarnessContextRemaining,
  type NativeHarnessSlotCandidate,
  type OctantMode,
  type ProjectId,
  type ProviderExecutionPolicy,
  type ProviderInstanceId,
  type ProviderResumeCursor,
  type ToolActionAuthority,
  type WorkThread,
} from "@octant/contracts";
import { hasKnownContextWindow } from "@octant/domain/context-policy";
import { nativeHarnessResultTaintsThread } from "@octant/domain/untrusted-content-policy";
import {
  clampChildThreadEgressPolicy,
  materializeHarnessToolNetwork,
  resolveDefaultThreadEgressPolicy,
} from "../process/threadEgressPolicy";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type { ContextHarnessService } from "../context/contextHarnessService";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { GoalService } from "../goal/goalService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import type { NativeHarnessAuthority } from "./nativeHarnessAuthority";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import { createNativeHarnessGoalPort } from "./nativeHarnessGoal";
import { createCodeJournalLookup } from "./nativeHarnessJournalLookup";
import type { NativeHarnessTranscriptStore } from "./nativeHarnessTranscriptStore";
import type {
  NativeHarnessApprovalStore,
  NativeHarnessCommandApprovalOutcome,
} from "./nativeHarnessApprovals";
import type { ToolEgressCallConfirmation } from "./nativeHarnessEgressRules";
import type { NativeHarnessQuestionStore } from "./nativeHarnessQuestions";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
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
  /** Where the lead's task list is kept; absent, the lead has no `todo-write`. */
  readonly tasks?: Pick<NativeHarnessSessionStore, "replaceTasks">;
  /** The thread goal a lead reads and checks; absent on a host without goals. */
  readonly goals?: Pick<GoalService, "read" | "execute">;
  /** Code only: the sandboxed shell. */
  readonly shell?: NativeHarnessShellPort;
  /**
   * Code only: the same sandboxed shell with the network closed at the OS, for
   * a child that holds no network authority. Without it such a child gets no
   * shell, because the ordinary one can reach the network.
   */
  readonly offlineShell?: NativeHarnessShellPort;
  /**
   * Code only: the sandboxed shell on `proxied` network, whose commands reach
   * only the hosts the scope's egress rules name. With it, each command runs
   * on the network its thread's live posture resolves: approval-gated and
   * auto-accept-edits on `proxied`, Full access on `shell`, anything else on
   * `offlineShell`. Without it every networked command runs on `shell`, as it
   * did before the rules existed.
   */
  readonly proxiedShell?: (scope: HarnessEgressScope) => NativeHarnessShellPort;
  /**
   * A Code thread's access posture now, as the window running it holds it and
   * clamped to its running turn's, or nothing for a thread that is not one.
   * Without a window it is the stored posture clamped to the running turn's.
   */
  readonly readCodeExecutionPolicy?: (
    threadId: string,
    windowId?: string,
  ) => ProviderExecutionPolicy | undefined;
  /**
   * The web search a turn may use, resolved each time a turn's tools are
   * composed: its backing endpoint is a live setting, not a startup fact.
   */
  readonly resolveWebSearch?: () => NativeHarnessToolPorts["webSearch"];
  readonly webFetch?: NativeHarnessToolPorts["webFetch"];
  readonly contextHarness?: Pick<ContextHarnessService, "inspect">;
  /**
   * Code only: where a Code thread's harness conversation is journaled, read
   * back by `journal-lookup`. Chat and Work start a fresh harness session each
   * turn, so they have no conversation to read and the tool is not offered.
   */
  readonly codeJournal?: {
    readonly transcripts: Pick<NativeHarnessTranscriptStore, "load">;
    /** The provider session the thread's newest turn ran on, from its own journal. */
    readonly latestSession: (threadId: CodeThread["id"]) =>
      | {
          readonly providerInstanceId: ProviderInstanceId;
          readonly resumeCursor?: ProviderResumeCursor | undefined;
        }
      | undefined;
  };
  /**
   * The advisor behind `second-opinion` for a lead thread; absent on a host
   * that cannot reach one, where the tool is simply not offered.
   */
  readonly secondOpinion?: (scope: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }) => NonNullable<NativeHarnessToolPorts["secondOpinion"]>;
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
  /** Where each lead tool call is noted while its turn runs. */
  readonly activity?: Pick<NativeHarnessSessionStore, "noteToolCall" | "deliverSteering">;
  readonly approvals?: Pick<NativeHarnessApprovalStore, "ask"> &
    Partial<Pick<NativeHarnessApprovalStore, "askCommand">>;
  /**
   * The hosts a marked Code thread's command confirmation lists: its thread
   * and Project rules, and its open proposals. Absent, a marked thread's
   * proxied command reaches no host.
   */
  readonly commandHosts?: (threadId: string) => ReadonlyArray<NativeHarnessCommandHost>;
  readonly childInteractions?: (run: AgentRun) => NativeHarnessChildInteractions;
  readonly isChildAuthorityCurrent: (run: AgentRun) => boolean;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly clock: () => string;
}

/**
 * How a child asks its parent's person. `approveCommand` asks for a command
 * that runs through the parent's egress rules while they are suspended, and
 * lists the hosts it may reach; the outcome carries the hosts the person
 * ticked.
 */
export type NativeHarnessChildInteractions = Pick<
  NativeHarnessToolPorts,
  "approvals" | "askUser"
> & {
  readonly approveCommand?: (
    input: Parameters<NonNullable<NativeHarnessToolPorts["approvals"]>>[0] & {
      readonly commandHosts: ReadonlyArray<NativeHarnessCommandHost>;
    },
  ) => Promise<NativeHarnessCommandApprovalOutcome>;
};

/** Whose egress rules a proxied command runs under: a child runs under its parent's. */
export interface HarnessEgressScope {
  readonly threadId: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
}

export interface NativeHarnessComposition {
  readonly forChat: (input: {
    readonly thread: ChatThread;
    readonly windowId: string;
    /**
     * The thread is a Side Chat sidecar. It is a side conversation about one
     * source thread, so it gets no task list, goal, question, or delegation:
     * those belong to the lead of a thread the person is steering.
     */
    readonly sideChat?: boolean;
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
    /**
     * The credential values the turn resolved. A lookup redacts them from
     * what it returns; without them the lead is not offered `journal-lookup`.
     */
    readonly secrets?: ReadonlyArray<string>;
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
 * the authority service decides each call. A result that brings in outside
 * content taints the thread before it reaches the next model turn; local
 * reads, searches, edits, and commands do not.
 */
export function createNativeHarnessComposition(
  options: NativeHarnessCompositionOptions,
): NativeHarnessComposition {
  const resultTaintsThread = (
    call: { readonly name: string; readonly inputJson: string },
    result: unknown,
  ) => {
    let args: unknown;
    try {
      args = call.inputJson.trim().length === 0 ? {} : JSON.parse(call.inputJson);
    } catch {
      args = undefined;
    }
    return nativeHarnessResultTaintsThread({ toolName: call.name, arguments: args, result });
  };
  const contextRemaining =
    options.contextHarness === undefined
      ? undefined
      : (subject: ContextSubjectRef) => (): NativeHarnessContextRemaining | undefined => {
          try {
            const snapshot = options.contextHarness!.inspect(subject);
            // The planner's emergency estimate is not the model's window.
            // Telling the lead how little of it is left would make it wrap up
            // work the model has room for, so it gets no figure at all.
            if (!hasKnownContextWindow(snapshot.modelLimits)) return undefined;
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
  /**
   * The advisor sees only the question the lead writes, so a thread that has
   * taken in outside content cannot send it: the page's own words would reach
   * another model with nothing to mark them, the rule delegation follows.
   */
  const secondOpinion = (scope: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }): Pick<NativeHarnessToolPorts, "secondOpinion"> => {
    const advisor = options.secondOpinion?.(scope);
    return advisor === undefined
      ? {}
      : {
          secondOpinion: async (input) =>
            options.readThreadTaint(scope.threadId)
              ? {
                  refused: "second-opinion-tainted",
                  message:
                    "This thread has read outside content, so it cannot send a question to another model.",
                }
              : advisor(input),
        };
  };
  /** The lead's room left, read from its own thread in whichever mode it runs. */
  const contextRemainingFor = (
    aggregateType: "chat-thread" | "work-thread" | "code-thread",
    threadId: string,
  ): Pick<NativeHarnessToolPorts, "contextRemaining"> =>
    contextRemaining === undefined
      ? {}
      : {
          contextRemaining: contextRemaining({
            aggregateType: aggregateType as never,
            aggregateId: threadId as never,
          }),
        };
  const webPorts = (): Pick<NativeHarnessToolPorts, "webFetch" | "webSearch"> => {
    const webSearch = options.resolveWebSearch?.();
    return {
      ...(options.webFetch === undefined ? {} : { webFetch: options.webFetch }),
      ...(webSearch === undefined ? {} : { webSearch }),
    };
  };
  const shared = (threadId: string): NativeHarnessToolPorts => ({
    ...(options.tasks === undefined
      ? {}
      : { todo: createNativeHarnessTodoPort({ sessions: options.tasks, threadId }) }),
    ...(options.goals === undefined
      ? {}
      : {
          goal: createNativeHarnessGoalPort({ goals: options.goals, threadId, uuid: options.uuid }),
        }),
  });
  const compose = (input: {
    readonly threadId: string;
    readonly mode: "chat" | "work" | "code";
    readonly ports: NativeHarnessToolPorts;
    readonly executionPolicy?: ProviderExecutionPolicy;
    readonly turnExecutionPolicy?: () => ProviderExecutionPolicy | undefined;
  }): AppManagedToolSet =>
    taintAppManagedToolResults({
      tools: createNativeHarnessTools({
        threadId: input.threadId,
        mode: input.mode,
        ...(input.executionPolicy === undefined ? {} : { executionPolicy: input.executionPolicy }),
        ...(input.turnExecutionPolicy === undefined
          ? {}
          : { resolveTurnExecutionPolicy: input.turnExecutionPolicy }),
        authority: options.authority.service,
        resolveAuthority: () => options.authority.resolve(input.threadId, input.mode),
        ports: input.ports,
        uuid: options.uuid,
        ...(options.activity === undefined
          ? {}
          : { observe: (call) => options.activity?.noteToolCall(input.threadId, call) }),
      }),
      threadId: input.threadId,
      recordExternalContentIngestion: options.recordExternalContentIngestion,
      uuid: options.uuid,
      resultTaintsThread,
    });
  const leadOf = (thread: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: string;
  }): NativeHarnessSlotCandidate => ({
    hostId: options.hostId as never,
    providerInstanceId: thread.providerInstanceId,
    modelId: thread.modelId as never,
  });
  /**
   * Hosts a person confirmed for one command, held from the answer until the
   * shell starts that command's launch, which takes them out, or until the
   * call ends without running one (a check that stopped first). They are
   * keyed by the call's own id, which no other call has.
   */
  const confirmedCommandHosts = new Map<string, ToolEgressCallConfirmation>();
  const approvalStore = options.approvals;
  const askUserFor = (scope: {
    readonly parentThreadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
    /** The window a Code turn runs in, whose grant its commands' network follows. */
    readonly windowId?: string;
  }): Pick<NativeHarnessToolPorts, "askUser" | "approvals" | "steering" | "callEnded"> => ({
    callEnded: (callId) => {
      confirmedCommandHosts.delete(callId);
    },
    ...(options.questions === undefined
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
        }),
    ...(approvalStore === undefined
      ? {}
      : {
          approvals: async (input) => {
            const ask = {
              threadId: scope.parentThreadId,
              mode: scope.mode,
              projectId: scope.projectId,
              lead: scope.lead,
              toolName: input.toolName,
              summary: input.summary,
              approvalClass: input.approvalClass,
              singleUse: input.freshConfirmation,
              signal: input.signal,
            };
            // A marked thread's command that will run through the egress
            // rules lists the hosts it may reach, so the person picks them
            // for this one command.
            const askCommand = approvalStore.askCommand;
            if (
              !input.freshConfirmation ||
              scope.mode !== "code" ||
              (input.toolName !== "bash" && input.toolName !== "goal-check") ||
              askCommand === undefined ||
              options.commandHosts === undefined ||
              options.proxiedShell === undefined ||
              materializeHarnessToolNetwork(codeEgress(scope.parentThreadId, scope.windowId)) !==
                "proxied"
            ) {
              return approvalStore.ask(ask);
            }
            const answered = await askCommand.call(approvalStore, {
              ...ask,
              commandHosts: options.commandHosts(scope.parentThreadId),
            });
            if (answered.outcome === "approved" && answered.confirmed !== undefined) {
              confirmedCommandHosts.set(input.callId, answered.confirmed);
            }
            return answered.outcome;
          },
        }),
    ...(options.activity === undefined
      ? {}
      : { steering: () => options.activity!.deliverSteering(scope.parentThreadId) }),
  });
  const unavailableShell: NativeHarnessShellPort = {
    run: async () => ({ status: "unavailable", output: "", truncated: false }),
  };
  /**
   * The shell a command runs on, chosen when it runs from the egress the
   * posture resolves then, so a posture changed mid-turn applies to the next
   * command. A posture that cannot be read runs offline; `proxied` never
   * falls back to open network.
   */
  const postureShell = (
    proxied: NativeHarnessShellPort,
    resolveEgress: () => ReturnType<typeof resolveDefaultThreadEgressPolicy>,
  ): NativeHarnessShellPort => ({
    run: (input) => {
      const network = materializeHarnessToolNetwork(resolveEgress());
      // Taken whatever network the command runs on, so a confirmation is
      // used by its own command or by none.
      const confirmed =
        input.callId === undefined ? undefined : confirmedCommandHosts.get(input.callId);
      if (input.callId !== undefined) confirmedCommandHosts.delete(input.callId);
      if (network === "proxied") {
        return proxied.run(
          confirmed === undefined ? input : { ...input, confirmedHosts: confirmed },
        );
      }
      const shell = network === "allow" ? options.shell : options.offlineShell;
      return (shell ?? unavailableShell).run(input);
    },
  });
  const codeEgress = (threadId: string, windowId?: string) => {
    const executionPolicy = options.readCodeExecutionPolicy?.(threadId, windowId);
    return executionPolicy === undefined
      ? "none"
      : resolveDefaultThreadEgressPolicy({ mode: "code", executionPolicy });
  };
  const codeShell = (
    scope: HarnessEgressScope,
    windowId: string,
  ): NativeHarnessShellPort | undefined =>
    options.proxiedShell === undefined
      ? options.shell
      : postureShell(options.proxiedShell(scope), () => codeEgress(scope.threadId, windowId));
  const delegateFor = (scope: {
    readonly parentThreadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }): Pick<NativeHarnessToolPorts, "delegate"> =>
    options.delegate === undefined ? {} : { delegate: options.delegate(scope) };
  return {
    forChat: ({ thread, windowId, sideChat = false }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      const { askUser, ...approvalPorts } = askUserFor({
        parentThreadId: threadId,
        mode: "chat",
        projectId: thread.projectId,
        lead: leadOf(thread),
      });
      return compose({
        threadId,
        mode: "chat",
        ports: {
          ...(sideChat ? {} : shared(threadId)),
          ...(sideChat
            ? {}
            : delegateFor({
                parentThreadId: threadId,
                windowId,
                mode: "chat",
                projectId: thread.projectId,
                lead: leadOf(thread),
              })),
          ...approvalPorts,
          ...(sideChat || askUser === undefined ? {} : { askUser }),
          // Research is the user's grant for a Chat thread to reach the web,
          // whether by fetching a page or by searching.
          ...(thread.researchEnabled ? webPorts() : {}),
          ...contextRemainingFor("chat-thread", threadId),
          ...secondOpinion({
            threadId,
            mode: "chat",
            projectId: thread.projectId,
            lead: leadOf(thread),
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
          ...webPorts(),
          ...contextRemainingFor("work-thread", threadId),
          ...secondOpinion({
            threadId,
            mode: "work",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
        },
      });
    },
    forCode: ({ thread, checkoutRoot, windowId, secrets }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      const codeJournal = options.codeJournal;
      const journalLookup =
        codeJournal === undefined || secrets === undefined
          ? undefined
          : createCodeJournalLookup({
              transcripts: codeJournal.transcripts,
              latestSession: () => codeJournal.latestSession(thread.id),
              providerInstanceId: thread.providerInstanceId,
              secrets,
            });
      const shell = codeShell({ threadId, projectId: String(thread.projectId) }, windowId);
      // Plan is the floor: a thread stored as Plan, or a turn narrowed to it,
      // is offered only the tools Plan allows.
      const planned =
        thread.executionPolicy === "plan" ||
        options.readCodeExecutionPolicy?.(threadId, windowId) === "plan";
      return compose({
        threadId,
        mode: "code",
        ...(planned ? { executionPolicy: "plan" as const } : {}),
        // Read on every call, not once here: a turn can be narrowed after its
        // tools were composed, and the stored posture alone would not know.
        turnExecutionPolicy: () => options.readCodeExecutionPolicy?.(threadId, windowId),
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
            windowId,
          }),
          filesystem: new NativeHarnessFileSystem({ root: checkoutRoot }),
          ...(shell === undefined ? {} : { shell }),
          ...webPorts(),
          ...contextRemainingFor("code-thread", threadId),
          ...(journalLookup === undefined ? {} : { journalLookup }),
          ...secondOpinion({
            threadId,
            mode: "code",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
        },
      });
    },
    forAgentRun: ({ run, authority, projectRoot }) => {
      const target = run.routingReceipt.selectedFallback ?? {
        providerInstanceId: run.routingReceipt.selectedProviderInstanceId,
      };
      const mode = run.routingReceipt.mode;
      const runId = String(run.id);
      const projectId =
        run.workspaceReceipt.kind === "chat-virtual" ? undefined : run.workspaceReceipt.projectId;
      // A child's authority is the run's own clamped grant, not a thread's
      // posture: the run record is what admission decided, so it is what
      // every tool call is judged against.
      const granted: ToolActionAuthority = {
        hostId: options.hostId,
        mode,
        ...(projectId === undefined ? {} : { projectId }),
        providerInstanceId: target.providerInstanceId,
        extension: { kind: "core" },
      } as ToolActionAuthority;
      const service = new ToolCallAuthorityService({
        resolveGrantedAuthority: () => (options.isChildAuthorityCurrent(run) ? granted : undefined),
        resolveLiveFacts: () => ({
          providerAppManagedTools: "supported",
          host: { computerUseEnabled: false },
          executionPolicy: authority.executionPolicy,
          approvalSatisfied: authority.executionPolicy === "full-access",
          externalContentIngested: options.readThreadTaint(runId),
        }),
      });
      // A child without network authority must not reach it through a command
      // either, so its shell is the one whose sandbox closes the network. A
      // child with it is never wider than its parent's posture now, and on
      // `proxied` it runs under its parent's rules.
      const parentThreadId = String(run.parentThreadId);
      const childEgress = () =>
        clampChildThreadEgressPolicy({
          parent: codeEgress(parentThreadId),
          childNetworkAuthority: true,
          requested: resolveDefaultThreadEgressPolicy({
            mode: "code",
            executionPolicy: authority.executionPolicy,
          }),
        });
      const commandsProxied =
        authority.network && options.proxiedShell !== undefined && projectId !== undefined;
      const shell = !authority.network
        ? options.offlineShell
        : options.proxiedShell === undefined
          ? options.shell
          : projectId === undefined
            ? unavailableShell
            : postureShell(
                options.proxiedShell({
                  threadId: runId,
                  projectId: String(projectId),
                  parentThreadId,
                }),
                childEgress,
              );
      const { approveCommand, ...interactions } = options.childInteractions?.(run) ?? {};
      const askApproval = interactions.approvals;
      const approvals: NativeHarnessToolPorts["approvals"] =
        askApproval === undefined
          ? undefined
          : async (input) => {
              // A command that will run through its parent's rules while they
              // are suspended (the parent or the child is marked) lists the
              // parent's hosts, so the person picks them for this one command.
              // The list is the parent's; the child adds nothing to it.
              if (
                approveCommand === undefined ||
                options.commandHosts === undefined ||
                !commandsProxied ||
                mode !== "code" ||
                (input.toolName !== "bash" && input.toolName !== "goal-check") ||
                !(input.freshConfirmation || options.readThreadTaint(parentThreadId)) ||
                materializeHarnessToolNetwork(childEgress()) !== "proxied"
              ) {
                return askApproval(input);
              }
              const answered = await approveCommand({
                ...input,
                commandHosts: options.commandHosts(parentThreadId),
              });
              if (answered.outcome === "approved" && answered.confirmed !== undefined) {
                confirmedCommandHosts.set(input.callId, answered.confirmed);
              }
              return answered.outcome;
            };
      const tools = createNativeHarnessTools({
        threadId: runId,
        mode,
        executionPolicy: authority.executionPolicy,
        authority: service,
        resolveAuthority: () => granted,
        ports: {
          ...interactions,
          ...(approvals === undefined ? {} : { approvals }),
          callEnded: (callId) => {
            confirmedCommandHosts.delete(callId);
          },
          ...(authority.filesystem && mode !== "chat"
            ? { filesystem: new NativeHarnessFileSystem({ root: projectRoot }) }
            : {}),
          ...(authority.shell && mode === "code" && shell !== undefined ? { shell } : {}),
          ...(authority.network ? webPorts() : {}),
        },
        uuid: options.uuid,
      });
      return taintAppManagedToolResults({
        tools,
        threadId: runId,
        recordExternalContentIngestion: options.recordExternalContentIngestion,
        uuid: options.uuid,
        resultTaintsThread,
      });
    },
  };
}
