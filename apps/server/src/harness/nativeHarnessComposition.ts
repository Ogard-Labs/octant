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
  type ToolActionAuthority,
  type WorkThread,
} from "@octant/contracts";
import { hasKnownContextWindow } from "@octant/domain/context-policy";
import {
  type ForgeShellChange,
  type ForgeShellHardLine,
  forgeShellChanges,
  forgeShellHardLine,
  forgeShellHardLineMessage,
} from "@octant/domain/forge-shell-change-policy";
import { shieldCallFromHarness } from "@octant/domain/shield-judge-policy";
import { nativeHarnessResultTaintsThread } from "@octant/domain/untrusted-content-policy";
import type { ShieldReviewPort } from "../shield/octantShield";
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
import {
  createThreadJournalLookup,
  type NativeHarnessJournaledSession,
} from "./nativeHarnessJournalLookup";
import type { NativeHarnessTranscriptStore } from "./nativeHarnessTranscriptStore";
import type {
  NativeHarnessApprovalAsk,
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
  type NativeHarnessShellRun,
  type NativeHarnessToolPorts,
} from "./nativeHarnessTools";

/** Where a Full access tag is journaled, and whose earlier reads count toward it. */
interface SecretEgressTagScope {
  readonly threadId: string;
  readonly readerThreadIds: ReadonlyArray<string>;
}

export interface NativeHarnessCompositionOptions {
  readonly authority: NativeHarnessAuthority;
  /** Whether a provider instance is one the harness drives; others get no harness tools. */
  readonly isHarnessProvider: (providerInstanceId: ProviderInstanceId) => boolean;
  /** Where the lead's task list is kept; absent, the lead has no `todo-write`. */
  readonly tasks?: Pick<NativeHarnessSessionStore, "replaceTasks">;
  /** The thread goal a lead reads and checks; absent on a host without goals. */
  readonly goals?: Pick<GoalService, "read" | "execute">;
  /** Work and Code: the sandboxed shell. */
  readonly shell?: NativeHarnessShellPort;
  /**
   * Work and Code: the same sandboxed shell with the network closed at the OS, for
   * a child that holds no network authority. Without it such a child gets no
   * shell, because the ordinary one can reach the network.
   */
  readonly offlineShell?: NativeHarnessShellPort;
  /**
   * Work and Code: the sandboxed shell on `proxied` network, whose commands reach
   * only the hosts the scope's egress rules name. With it, each command runs
   * on the network its thread's live posture resolves: approval-gated and
   * auto-accept-edits on `proxied`, Full access on `shell`, anything else on
   * `offlineShell`. Without it every networked command runs on `shell`, as it
   * did before the rules existed.
   */
  readonly proxiedShell?: (scope: HarnessEgressScope) => NativeHarnessShellPort;
  /**
   * Work and Code: the shell a Full access command runs on, outside Octant's OS
   * sandbox with the network open, as Full access runs in the providers' own
   * apps. Chosen per command with `proxiedShell`, so a posture lowered
   * mid-turn puts the next command back in the sandbox. Without it Full
   * access runs on `shell`.
   */
  readonly fullAccessShell?: NativeHarnessShellPort;
  /**
   * Journals a command that reached a server over `ssh`, with its host and
   * how it ended, at every level. `unavailable` means the record could not
   * be kept, and the command's output is withheld as an unmarked result is.
   */
  readonly recordRemoteCommand?: (input: {
    readonly threadId: string;
    readonly command: string;
    readonly status: NativeHarnessShellRun["status"];
    readonly exitCode?: number | undefined;
  }) => "recorded" | "not-remote" | "unavailable";
  /**
   * Pushes and pull-request changes a command makes. Every one the shell
   * runs is journaled under the thread; at Full access, where nothing else
   * reviews a command, one that crosses a hard line (a merge or a plain
   * force-push the person did not ask for, a push to another thread's
   * branch) is refused before it runs and journaled as refused. `record`
   * answering `unavailable` withholds the output, as an unmarked result is.
   */
  readonly forgeChanges?: {
    /** The thread's own delivery branch and the branches other threads of its repository work on. */
    readonly branches: (threadId: string) => {
      readonly ownBranch?: string | undefined;
      readonly otherThreadBranches: ReadonlyArray<string>;
    };
    readonly record: (input: {
      readonly threadId: string;
      readonly changes: ReadonlyArray<ForgeShellChange>;
      readonly outcome: "refused" | "ran";
      readonly hardLine?: ForgeShellHardLine | undefined;
      readonly command: string;
      readonly exitCode?: number | undefined;
    }) => "recorded" | "no-change" | "unavailable";
  };
  /**
   * The secret guard's list in force: whether a path the agent wrote is one it
   * protects. With it the Watcher flags a call that names a protected path,
   * at every level, as a journaled label that never blocks.
   */
  readonly protectedSecretPath?: (path: string) => boolean;
  /**
   * Tags a Full access command Shield does not judge when it sends something
   * off the computer after reaching for a secret. `unavailable` means the tag
   * could not be kept, and the command's output is withheld as an unmarked
   * result is; the command itself is never stopped.
   */
  readonly tagSecretEgress?: (input: {
    /** Where the tag is journaled: the thread the person reviews. */
    readonly threadId: string;
    /** Whose earlier reads count: the thread, and a child run that ran the command. */
    readonly readerThreadIds: ReadonlyArray<string>;
    readonly command: string;
    readonly workingDirectory: string;
  }) => "recorded" | "not-tagged" | "unavailable";
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
   * A Work thread's posture now: its running turn's level, or nothing when no
   * turn runs. A Work thread's commands run on the network it resolves, as a
   * Code thread's do; without a turn they run offline.
   */
  readonly readWorkExecutionPolicy?: (threadId: string) => ProviderExecutionPolicy | undefined;
  /**
   * The web search a turn may use, resolved each time a turn's tools are
   * composed: its backing endpoint is a live setting, not a startup fact.
   */
  readonly resolveWebSearch?: () => NativeHarnessToolPorts["webSearch"];
  readonly webFetch?: NativeHarnessToolPorts["webFetch"];
  readonly contextHarness?: Pick<ContextHarnessService, "inspect">;
  /**
   * Where a thread's harness conversation is journaled, read back by
   * `journal-lookup`. Each mode continues one harness session across turns,
   * so each resolves the session its running turn uses from the thread's own
   * journal: a Chat thread's attempts, a Work thread's turns, a Code thread's
   * `provider-session-ready`.
   */
  readonly journal?: {
    readonly transcripts: Pick<NativeHarnessTranscriptStore, "load">;
    readonly latestChatSession: (
      threadId: ChatThread["id"],
    ) => NativeHarnessJournaledSession | undefined;
    readonly latestWorkSession: (
      threadId: WorkThread["id"],
    ) => NativeHarnessJournaledSession | undefined;
    readonly latestCodeSession: (
      threadId: CodeThread["id"],
    ) => NativeHarnessJournaledSession | undefined;
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
    Partial<Pick<NativeHarnessApprovalStore, "askCommand" | "recordReviewed" | "remembers">>;
  /**
   * Octant Shield, which answers a Work or Code thread's prompts at Auto when it is
   * the thread's reviewer. Absent, or answering nothing for a thread, the
   * person is asked as before.
   */
  readonly shield?: ShieldReviewPort;
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
    /** The Project's extra folders, which the file tools treat as the root. */
    readonly extraFolders?: ReadonlyArray<string>;
    readonly windowId: string;
  }) => AppManagedToolSet | undefined;
  readonly forCode: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    /** The Project's extra folders, which the file tools treat as the checkout. */
    readonly extraFolders?: ReadonlyArray<string>;
    readonly windowId: string;
    /**
     * The credential values the turn resolved. A lookup redacts them from
     * what it returns; without them the lead is not offered `journal-lookup`.
     */
    readonly secrets?: ReadonlyArray<string>;
  }) => AppManagedToolSet | undefined;
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
      ...(options.protectedSecretPath === undefined
        ? {}
        : { protectedSecretPath: options.protectedSecretPath }),
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
    /**
     * A Work thread's Project folder or a Code thread's checkout, the root
     * Octant Shield judges its calls against.
     */
    readonly boundRoot?: string;
    /** The Project's extra folders, which Shield judges as it judges the root. */
    readonly extraRoots?: ReadonlyArray<string> | undefined;
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
            let ask: NativeHarnessApprovalAsk = {
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
            // At Auto with Shield reviewing, Shield answers before anyone is
            // asked. A class the person already allowed for the session goes
            // through on their word, so Shield never overrules the person.
            const shieldReviews =
              scope.mode !== "chat" &&
              scope.boundRoot !== undefined &&
              options.shield !== undefined &&
              approvalStore.remembers?.(
                scope.parentThreadId,
                input.approvalClass,
                input.freshConfirmation,
              ) !== true;
            if (shieldReviews && scope.boundRoot !== undefined && options.shield !== undefined) {
              const decision = await options.shield.review({
                threadId: scope.parentThreadId,
                call: shieldCallFromHarness({
                  toolName: input.toolName,
                  arguments: input.arguments,
                  approvalClass: input.approvalClass,
                  workingDirectory: scope.boundRoot,
                  freshConfirmation: input.freshConfirmation,
                  command: input.command,
                }),
                boundRoot: scope.boundRoot,
                ...(scope.extraRoots === undefined ? {} : { extraRoots: scope.extraRoots }),
                signal: input.signal,
              });
              if (decision !== undefined) {
                options.shield.recordOnTranscript?.({
                  threadId: scope.parentThreadId,
                  summary: input.summary,
                  decision,
                  requestId: input.callId,
                  toolName: input.toolName,
                });
                if (decision.verdict === "allow" || decision.verdict === "deny") {
                  approvalStore.recordReviewed?.(ask, { ...decision, verdict: decision.verdict });
                  return decision.verdict === "allow" ? "approved" : "shield-denied";
                }
                ask = { ...ask, shield: decision };
              }
            }
            // A marked thread's command that will run through the egress
            // rules lists the hosts it may reach, so the person picks them
            // for this one command.
            const askCommand = approvalStore.askCommand;
            if (
              !input.freshConfirmation ||
              scope.mode === "chat" ||
              (input.toolName !== "bash" && input.toolName !== "goal-check") ||
              askCommand === undefined ||
              options.commandHosts === undefined ||
              options.proxiedShell === undefined ||
              materializeHarnessToolNetwork(
                scope.mode === "code"
                  ? codeEgress(scope.parentThreadId, scope.windowId)
                  : workEgress(scope.parentThreadId),
              ) !== "proxied"
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
    tagScope: SecretEgressTagScope,
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
      // Open network is resolved only at Full access, so it is also the
      // command that runs outside the sandbox.
      const shell =
        network === "allow"
          ? taggingSecretEgress(tagScope, options.fullAccessShell ?? options.shell)
          : options.offlineShell;
      return (shell ?? unavailableShell).run(input);
    },
  });
  /**
   * The Full access shell with each command that sends something off the
   * computer after reaching for a secret tagged under the thread. Nothing
   * else judges a command there, so the tag is the record; it never stops one.
   */
  const taggingSecretEgress = (
    scope: SecretEgressTagScope,
    shell: NativeHarnessShellPort | undefined,
  ): NativeHarnessShellPort | undefined => {
    const tag = options.tagSecretEgress;
    if (shell === undefined || tag === undefined) return shell;
    return {
      run: async (input) => {
        const run = await shell.run(input);
        let tagged: ReturnType<typeof tag>;
        try {
          tagged = tag({
            threadId: scope.threadId,
            readerThreadIds: scope.readerThreadIds,
            command: input.command,
            workingDirectory: input.cwd,
          });
        } catch {
          tagged = "unavailable";
        }
        return tagged === "unavailable"
          ? { status: "unavailable", output: "", truncated: false }
          : run;
      },
    };
  };
  /** The shell with every `ssh` command it ran journaled under the thread. */
  const recordingRemoteCommands = (
    threadId: string,
    shell: NativeHarnessShellPort | undefined,
  ): NativeHarnessShellPort | undefined => {
    const record = options.recordRemoteCommand;
    if (shell === undefined || record === undefined) return shell;
    return {
      run: async (input) => {
        const run = await shell.run(input);
        let recorded: ReturnType<typeof record>;
        try {
          recorded = record({
            threadId,
            command: input.command,
            status: run.status,
            ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
          });
        } catch {
          recorded = "unavailable";
        }
        return recorded === "unavailable"
          ? { status: "unavailable", output: "", truncated: false }
          : run;
      },
    };
  };
  /**
   * The shell with each push and pull-request change journaled, and at Full
   * access the ones that cross a hard line refused before they run.
   */
  const guardingForgeChanges = (
    threadId: string,
    shell: NativeHarnessShellPort | undefined,
    atFullAccess: () => boolean,
  ): NativeHarnessShellPort | undefined => {
    const forge = options.forgeChanges;
    if (shell === undefined || forge === undefined) return shell;
    const withheld = { status: "unavailable", output: "", truncated: false } as const;
    return {
      run: async (input) => {
        const changes = forgeShellChanges(input.command);
        if (changes.length === 0) return shell.run(input);
        let hardLine: ForgeShellHardLine | undefined;
        try {
          hardLine = atFullAccess()
            ? forgeShellHardLine(changes, forge.branches(threadId))
            : undefined;
        } catch {
          // Branches that cannot be read leave the push and merge lines,
          // which need none, and lose only the other-thread line.
          hardLine = forgeShellHardLine(changes, { otherThreadBranches: [] });
        }
        if (hardLine !== undefined) {
          try {
            forge.record({
              threadId,
              changes,
              outcome: "refused",
              hardLine,
              command: input.command,
            });
          } catch {
            // The refusal stands whether or not its record could be kept.
          }
          return {
            ...withheld,
            refusal: {
              reason: `forge-${hardLine}`,
              message: forgeShellHardLineMessage(hardLine),
            },
          };
        }
        const recordRan = (exitCode: number | undefined): ReturnType<typeof forge.record> => {
          try {
            return forge.record({
              threadId,
              changes,
              outcome: "ran",
              command: input.command,
              ...(exitCode === undefined ? {} : { exitCode }),
            });
          } catch {
            return "unavailable";
          }
        };
        let run: NativeHarnessShellRun;
        try {
          run = await shell.run(input);
        } catch (error) {
          // The command may have pushed before the shell failed.
          recordRan(undefined);
          throw error;
        }
        // A shell that never started the command made no change to record.
        if (run.status === "unavailable") return run;
        return recordRan(run.exitCode) === "unavailable" ? withheld : run;
      },
    };
  };
  /**
   * Without the egress rules every command runs on `shell`; the ones a Full
   * access posture runs are still tagged, since Shield judges none of them.
   */
  const taggingAtFullAccess = (
    threadId: string,
    shell: NativeHarnessShellPort | undefined,
    resolveEgress: () => ReturnType<typeof resolveDefaultThreadEgressPolicy>,
  ): NativeHarnessShellPort | undefined => {
    const tagged = taggingSecretEgress({ threadId, readerThreadIds: [threadId] }, shell);
    if (shell === undefined || tagged === undefined || tagged === shell) return shell;
    return {
      run: (input) =>
        materializeHarnessToolNetwork(resolveEgress()) === "allow"
          ? tagged.run(input)
          : shell.run(input),
    };
  };
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
    guardingForgeChanges(
      scope.threadId,
      recordingRemoteCommands(
        scope.threadId,
        options.proxiedShell === undefined
          ? taggingAtFullAccess(scope.threadId, options.shell, () =>
              codeEgress(scope.threadId, windowId),
            )
          : postureShell(
              { threadId: scope.threadId, readerThreadIds: [scope.threadId] },
              options.proxiedShell(scope),
              () => codeEgress(scope.threadId, windowId),
            ),
      ),
      () => options.readCodeExecutionPolicy?.(scope.threadId, windowId) === "full-access",
    );
  const workEgress = (threadId: string) => {
    const executionPolicy = options.readWorkExecutionPolicy?.(threadId);
    return executionPolicy === undefined
      ? "none"
      : resolveDefaultThreadEgressPolicy({ mode: "work", executionPolicy });
  };
  // Work and Code share the shell at the thread's level, so a Work thread's
  // commands run on the shell a Code thread at that level gets.
  const workShell = (scope: HarnessEgressScope): NativeHarnessShellPort | undefined =>
    guardingForgeChanges(
      scope.threadId,
      recordingRemoteCommands(
        scope.threadId,
        options.proxiedShell === undefined
          ? taggingAtFullAccess(scope.threadId, options.shell, () => workEgress(scope.threadId))
          : postureShell(
              { threadId: scope.threadId, readerThreadIds: [scope.threadId] },
              options.proxiedShell(scope),
              () => workEgress(scope.threadId),
            ),
      ),
      () => options.readWorkExecutionPolicy?.(scope.threadId) === "full-access",
    );
  const delegateFor = (scope: {
    readonly parentThreadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  }): Pick<NativeHarnessToolPorts, "delegate"> =>
    options.delegate === undefined ? {} : { delegate: options.delegate(scope) };
  /**
   * `journal-lookup` for a lead, reading the session `latestSession` names
   * when a call runs. Chat and Work turns resolve no credential values, so
   * nothing of theirs needs redacting; a Code turn passes the values it
   * resolved, and without them its lead is not offered the tool.
   */
  const journalLookupFor = (input: {
    readonly mode: OctantMode;
    readonly providerInstanceId: ProviderInstanceId;
    readonly latestSession: () => NativeHarnessJournaledSession | undefined;
    readonly secrets: ReadonlyArray<string>;
  }): Pick<NativeHarnessToolPorts, "journalLookup"> =>
    options.journal === undefined
      ? {}
      : {
          journalLookup: createThreadJournalLookup({
            ...input,
            transcripts: options.journal.transcripts,
          }),
        };
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
          // A Side Chat is not a lead, so it is not handed its journal either.
          ...(sideChat
            ? {}
            : journalLookupFor({
                mode: "chat",
                providerInstanceId: thread.providerInstanceId,
                latestSession: () => options.journal?.latestChatSession(thread.id),
                secrets: [],
              })),
          ...secondOpinion({
            threadId,
            mode: "chat",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
        },
      });
    },
    forWork: ({ thread, projectRoot, extraFolders, windowId }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      const shell = workShell({ threadId, projectId: String(thread.projectId) });
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
            boundRoot: projectRoot,
          }),
          filesystem: new NativeHarnessFileSystem({
            root: projectRoot,
            ...(extraFolders === undefined ? {} : { extraRoots: extraFolders }),
          }),
          ...(shell === undefined ? {} : { shell }),
          ...webPorts(),
          ...contextRemainingFor("work-thread", threadId),
          ...journalLookupFor({
            mode: "work",
            providerInstanceId: thread.providerInstanceId,
            latestSession: () => options.journal?.latestWorkSession(thread.id),
            secrets: [],
          }),
          ...secondOpinion({
            threadId,
            mode: "work",
            projectId: thread.projectId,
            lead: leadOf(thread),
          }),
        },
      });
    },
    forCode: ({ thread, checkoutRoot, extraFolders, windowId, secrets }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
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
            boundRoot: checkoutRoot,
            ...(extraFolders === undefined ? {} : { extraRoots: extraFolders }),
          }),
          filesystem: new NativeHarnessFileSystem({
            root: checkoutRoot,
            ...(extraFolders === undefined ? {} : { extraRoots: extraFolders }),
          }),
          ...(shell === undefined ? {} : { shell }),
          ...webPorts(),
          ...contextRemainingFor("code-thread", threadId),
          ...(secrets === undefined
            ? {}
            : journalLookupFor({
                mode: "code",
                providerInstanceId: thread.providerInstanceId,
                latestSession: () => options.journal?.latestCodeSession(thread.id),
                secrets,
              })),
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
      // A child's remote commands, forge changes, and Shield's tags are
      // recorded under the parent thread the person reviews.
      const shell = guardingForgeChanges(
        parentThreadId,
        recordingRemoteCommands(
          parentThreadId,
          !authority.network
            ? options.offlineShell
            : options.proxiedShell === undefined
              ? options.shell
              : projectId === undefined
                ? unavailableShell
                : postureShell(
                    // A child's own reads count beside its parent's.
                    { threadId: parentThreadId, readerThreadIds: [parentThreadId, runId] },
                    options.proxiedShell({
                      threadId: runId,
                      projectId: String(projectId),
                      parentThreadId,
                    }),
                    childEgress,
                  ),
        ),
        () => authority.executionPolicy === "full-access",
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
        ...(options.protectedSecretPath === undefined
          ? {}
          : { protectedSecretPath: options.protectedSecretPath }),
      });
    },
  };
}
