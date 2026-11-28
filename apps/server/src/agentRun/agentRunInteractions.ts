import { decodeAgentRunId, MAX_QUESTION_OPTIONS, type Questionnaire } from "@octant/contracts";
import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunId,
  NativeHarnessApproval,
  NativeHarnessCommandHost,
  ProviderApprovalCall,
  ProviderRuntimeEvent,
  ProviderInstanceId,
  NativeHarnessSlotCandidate,
  ShieldWatcherLabel,
} from "@octant/contracts";
import {
  clampAgentRunAuthority,
  effectiveAgentRunExecutionTarget,
} from "@octant/domain/agent-run-policy";
import {
  shieldCallFromHarness,
  shieldCallFromProviderRequest,
  type ShieldCall,
} from "@octant/domain/shield-judge-policy";
import type {
  NativeHarnessApprovalAsk,
  NativeHarnessApprovalStore,
  NativeHarnessCommandApprovalOutcome,
} from "../harness/nativeHarnessApprovals";
import type { NativeHarnessChildInteractions } from "../harness/nativeHarnessComposition";
import type { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";
import type { ShieldReviewPort } from "../shield/octantShield";
import { clampAgentRunSessionAuthority } from "./agentRunSessionRuntime";

export interface AgentRunInteractionOptions {
  readonly getById: (id: AgentRunId) => AgentRun | undefined;
  readonly approvals: Pick<NativeHarnessApprovalStore, "ask"> &
    Partial<Pick<NativeHarnessApprovalStore, "askCommand" | "recordReviewed">>;
  readonly questions: Pick<NativeHarnessQuestionStore, "ask">;
  /**
   * Octant Shield, read when a child asks: a subagent inherits its parent's
   * reviewer, so a Code parent at Auto with Shield reviewing has Shield answer
   * the child's prompts too, judged against the child's own worktree.
   */
  readonly shield?: () => ShieldReviewPort | undefined;
  /** Whether the child run has itself taken in outside content. */
  readonly childTainted?: (run: AgentRun) => boolean;
  /** What the Watcher found in what a child read, which counts beside its parent's. */
  readonly childWatcherLabels?: (run: AgentRun) => ReadonlyArray<ShieldWatcherLabel>;
  readonly requestOwner?: (run: AgentRun) => string | undefined;
  readonly providerName?: (id: ProviderInstanceId) => string | undefined;
  readonly parentLead: (run: AgentRun) => NativeHarnessSlotCandidate | undefined;
  readonly parentAuthority: (run: AgentRun) => AgentRunAuthority | undefined;
}

/** A harness tool call as Shield judges it, from the child's own worktree. */
function harnessShieldCall(input: {
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly approvalClass: string;
  readonly freshConfirmation: boolean;
  readonly command?: string | undefined;
}): (boundRoot: string) => ShieldCall {
  return (boundRoot) =>
    shieldCallFromHarness({
      toolName: input.toolName,
      arguments: input.arguments,
      approvalClass: input.approvalClass,
      workingDirectory: boundRoot,
      freshConfirmation: input.freshConfirmation,
      command: input.command,
    });
}

/** Both provider prompts and Octant tools ask the same person on the parent thread. */
export function createAgentRunInteractions(options: AgentRunInteractionOptions) {
  const authorized = (run: AgentRun, forSessionReview = false): boolean => {
    const parentAuthority = options.parentAuthority(run);
    if (parentAuthority === undefined) return false;
    try {
      clampAgentRunAuthority({ parentAuthority, requestedAuthority: run.authority });
    } catch {
      return false;
    }
    const live = options.getById(run.id);
    return (
      live !== undefined &&
      (live.lifecycleStatus === "starting" ||
        live.lifecycleStatus === "running" ||
        (forSessionReview &&
          (live.lifecycleStatus === "queued" || live.lifecycleStatus === "waiting"))) &&
      String(live.requestId) === String(run.requestId) &&
      String(live.parentThreadId) === String(run.parentThreadId) &&
      live.routingReceipt.effectiveAuthorityDigest ===
        run.routingReceipt.effectiveAuthorityDigest &&
      JSON.stringify(live.authority) === JSON.stringify(run.authority) &&
      options.parentLead(run) !== undefined &&
      JSON.stringify(effectiveAgentRunExecutionTarget(live.routingReceipt)) ===
        JSON.stringify(effectiveAgentRunExecutionTarget(run.routingReceipt))
    );
  };
  const current = (run: AgentRun, signal: AbortSignal | undefined): boolean =>
    signal !== undefined && !signal.aborted && authorized(run);
  const scope = (run: AgentRun) => {
    const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
    const providerName = options.providerName?.(target.providerInstanceId)?.slice(0, 128).trim();
    return {
      threadId: String(run.parentThreadId),
      mode: run.routingReceipt.mode,
      ...(run.workspaceReceipt.kind === "chat-virtual"
        ? {}
        : { projectId: run.workspaceReceipt.projectId }),
      lead: options.parentLead(run),
      source: {
        runId: run.id,
        ...target,
        ...(providerName ? { providerName } : {}),
        ...(run.workspaceReceipt.kind === "chat-virtual"
          ? {}
          : {
              targetFolder:
                run.workspaceReceipt.kind === "work-root"
                  ? run.workspaceReceipt.canonicalRoot
                  : run.workspaceReceipt.worktreeRoot,
            }),
      },
    };
  };
  const approve = async (input: {
    readonly run: AgentRun;
    readonly toolName: NativeHarnessApproval["toolName"];
    readonly summary: string;
    readonly approvalClass: string;
    readonly shieldCall?: (boundRoot: string) => ShieldCall;
    readonly singleUse?: true;
    readonly signal?: AbortSignal;
  }) => (await approveListing(input)).outcome;
  const childRoot = (run: AgentRun): string | undefined =>
    run.workspaceReceipt.kind === "code-worktree" ? run.workspaceReceipt.worktreeRoot : undefined;
  /**
   * Asks on the parent thread. With `commandHosts`, the ask is single-use and
   * lists them, and an approval carries the hosts the person ticked; a child
   * whose authority lapsed while it waited gets neither.
   */
  const approveListing = async (input: {
    readonly run: AgentRun;
    readonly toolName: NativeHarnessApproval["toolName"];
    readonly summary: string;
    readonly approvalClass: string;
    readonly commandHosts?: ReadonlyArray<NativeHarnessCommandHost>;
    readonly shieldCall?: (boundRoot: string) => ShieldCall;
    /** Asked for this one act: no remembered answer settles it and none is kept. */
    readonly singleUse?: true;
    readonly signal?: AbortSignal;
  }): Promise<
    | (NativeHarnessCommandApprovalOutcome & { readonly byReviewer?: true })
    | { readonly outcome: "shield-denied" }
  > => {
    if (!current(input.run, input.signal)) return { outcome: "cancelled" };
    // A provider's opaque prompt cannot widen Plan or the child's admitted
    // authority. Native tool prompts have already passed the tool policy.
    if (
      input.toolName === "provider-action" &&
      clampAgentRunSessionAuthority(input.run).executionPolicy === "plan"
    )
      return { outcome: "denied" };
    const parent = scope(input.run);
    if (parent.lead === undefined) return { outcome: "cancelled" };
    let ask: NativeHarnessApprovalAsk = {
      ...parent,
      lead: parent.lead,
      toolName: input.toolName,
      summary: input.summary,
      approvalClass: input.approvalClass,
      ...(input.singleUse === undefined ? {} : { singleUse: true }),
      signal: input.signal,
    };
    const shield = options.shield?.();
    const boundRoot = childRoot(input.run);
    if (shield !== undefined && boundRoot !== undefined && input.shieldCall !== undefined) {
      const decision = await shield.review({
        threadId: parent.threadId,
        call: input.shieldCall(boundRoot),
        boundRoot,
        // A child whose own taint cannot be read is treated as marked.
        alsoTainted: options.childTainted?.(input.run) ?? true,
        alsoWatcherLabels: options.childWatcherLabels?.(input.run) ?? [],
        signal: input.signal,
      });
      if (!current(input.run, input.signal)) return { outcome: "cancelled" };
      if (decision !== undefined) {
        shield.recordOnTranscript?.({
          threadId: parent.threadId,
          summary: input.summary,
          decision,
        });
        if (decision.verdict === "allow" || decision.verdict === "deny") {
          options.approvals.recordReviewed?.(ask, { ...decision, verdict: decision.verdict });
          return decision.verdict === "allow"
            ? { outcome: "approved", byReviewer: true }
            : { outcome: "shield-denied" };
        }
        ask = { ...ask, shield: decision };
      }
    }
    const askCommand = options.approvals.askCommand;
    const answered =
      input.commandHosts === undefined || askCommand === undefined
        ? { outcome: await options.approvals.ask(ask) }
        : await askCommand.call(options.approvals, { ...ask, commandHosts: input.commandHosts });
    return current(input.run, input.signal) ? answered : { outcome: "cancelled" };
  };
  const ask = async (input: {
    readonly run: AgentRun;
    readonly prompt: string;
    readonly questionnaire?: Questionnaire;
    readonly options: ReadonlyArray<string>;
    readonly secret?: true;
    readonly signal?: AbortSignal;
  }) => {
    if (
      !current(input.run, input.signal) ||
      input.prompt.length > 8_192 ||
      input.options.some((option) => option.length > 256) ||
      input.options.length > MAX_QUESTION_OPTIONS
    )
      return { status: "cancelled" as const };
    const parent = scope(input.run);
    if (parent.lead === undefined) return { status: "cancelled" as const };
    const outcome = await options.questions.ask({
      ...parent,
      lead: parent.lead,
      prompt: input.prompt,
      ...(input.questionnaire === undefined ? {} : { questionnaire: input.questionnaire }),
      options: input.options,
      ...(input.secret === true ? { secret: true } : {}),
      signal: input.signal,
    });
    return current(input.run, input.signal) ? outcome : { status: "cancelled" as const };
  };
  return {
    isCurrent: (run: AgentRun) => authorized(run),
    canReviewSession: (run: AgentRun) => authorized(run, true),
    approve: async (input: {
      readonly run: AgentRun;
      readonly event: Extract<ProviderRuntimeEvent, { readonly kind: "approval-request" }>;
      /** The pending call, from the child's connection, for Shield. */
      readonly call?: ProviderApprovalCall | undefined;
      readonly signal: AbortSignal;
    }): Promise<boolean | "approved-by-reviewer"> => {
      const answered = await approveListing({
        ...input,
        toolName: "provider-action",
        summary: `${input.event.action}: ${input.event.description}`,
        approvalClass: "child-provider-action",
        shieldCall: (boundRoot) =>
          shieldCallFromProviderRequest({
            tool: input.call?.tool ?? input.event.action,
            input: input.call?.input,
            workingDirectory: input.call?.workingDirectory,
            description: input.event.description,
            boundRoot,
          }),
      });
      if (answered.outcome !== "approved") return false;
      return "byReviewer" in answered && answered.byReviewer === true
        ? "approved-by-reviewer"
        : true;
    },
    askUser: async (input: {
      readonly run: AgentRun;
      readonly event: Extract<ProviderRuntimeEvent, { readonly kind: "user-input-request" }>;
      readonly signal: AbortSignal;
    }): Promise<string | undefined> => {
      // A provider child's whole question set reaches the person as the
      // same one questionnaire its parent's would, answered once; its one
      // answer goes back to the child's provider as the set's reply.
      const questionnaire = input.event.secret === true ? undefined : input.event.questionnaire;
      if (questionnaire !== undefined) {
        const outcome = await ask({
          ...input,
          prompt: input.event.prompt,
          questionnaire,
          options: [],
        });
        return outcome.status === "answered" ? outcome.answer : undefined;
      }
      const choices = input.event.options;
      const prompt = [
        input.event.prompt,
        ...(input.event.questionIndex === undefined
          ? []
          : [`Question ${input.event.questionIndex} of ${input.event.questionCount}.`]),
        ...choices
          .filter((option) => option.description !== undefined)
          .map((option) => `${option.label}: ${option.description}`),
      ].join("\n\n");
      const outcome = await ask({
        ...input,
        prompt,
        options: choices.map((option) => option.label),
        // Its answer comes back here in memory; the parent's journal keeps
        // only that it was given.
        ...(input.event.secret === true ? { secret: true } : {}),
      });
      return outcome.status === "answered" ? outcome.answer : undefined;
    },
    mayAnswerFromDevice: (input: {
      readonly runId: string;
      readonly parentThreadId: string;
      readonly deviceId: string;
    }): boolean => {
      const run = options.getById(decodeAgentRunId(input.runId));
      return (
        run !== undefined &&
        String(run.parentThreadId) === input.parentThreadId &&
        options.requestOwner?.(run) === input.deviceId &&
        authorized(run)
      );
    },
    toolsFor: (run: AgentRun): NativeHarnessChildInteractions => ({
      approvals: (input) => approve({ ...input, run, shieldCall: harnessShieldCall(input) }),
      approveCommand: async (input) => {
        const answered = await approveListing({
          ...input,
          run,
          shieldCall: harnessShieldCall(input),
        });
        return answered.outcome === "shield-denied" ? { outcome: "denied" } : answered;
      },
      askUser: async (input) => {
        const outcome = await ask({ ...input, run });
        return outcome;
      },
      // An Octant tool the child inherited asks the person for each act, on
      // the same card and under the same checks as the child's other asks.
      askTool: async ({ summary, approvalClass, signal }) => {
        const outcome = await approve({
          run,
          toolName: "provider-action",
          summary,
          approvalClass,
          singleUse: true,
          signal: signal ?? new AbortController().signal,
        });
        return outcome === "approved" || outcome === "cancelled" ? outcome : "denied";
      },
    }),
  };
}
