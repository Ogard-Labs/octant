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
  const authorized = (run: AgentRun): boolean => {
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
      (live.lifecycleStatus === "starting" || live.lifecycleStatus === "running") &&
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
      source: { runId: run.id, ...target, ...(providerName ? { providerName } : {}) },
    };
  };
  const approve = async (input: {
    readonly run: AgentRun;
    readonly toolName: NativeHarnessApproval["toolName"];
    readonly summary: string;
    readonly approvalClass: string;
    readonly shieldCall?: (boundRoot: string) => ShieldCall;
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
    readonly signal?: AbortSignal;
  }): Promise<NativeHarnessCommandApprovalOutcome | { readonly outcome: "shield-denied" }> => {
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
          return { outcome: decision.verdict === "allow" ? "approved" : "shield-denied" };
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
    readonly options: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
  }) => {
    if (
      !current(input.run, input.signal) ||
      input.prompt.length > 8_192 ||
      input.options.some((option) => option.length > 256) ||
      input.options.length > 8
    )
      return { status: "cancelled" as const };
    const parent = scope(input.run);
    if (parent.lead === undefined) return { status: "cancelled" as const };
    const outcome = await options.questions.ask({
      ...parent,
      lead: parent.lead,
      prompt: input.prompt,
      options: input.options,
      signal: input.signal,
    });
    return current(input.run, input.signal) ? outcome : { status: "cancelled" as const };
  };
  return {
    isCurrent: authorized,
    approve: async (input: {
      readonly run: AgentRun;
      readonly event: Extract<ProviderRuntimeEvent, { readonly kind: "approval-request" }>;
      /** The pending call, from the child's connection, for Shield. */
      readonly call?: ProviderApprovalCall | undefined;
      readonly signal: AbortSignal;
    }): Promise<boolean> =>
      (await approve({
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
      })) === "approved",
    askUser: async (input: {
      readonly run: AgentRun;
      readonly event: Extract<ProviderRuntimeEvent, { readonly kind: "user-input-request" }>;
      readonly signal: AbortSignal;
    }): Promise<string | undefined> => {
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
      });
      return outcome.status === "answered" ? outcome.answer : undefined;
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
    }),
  };
}
