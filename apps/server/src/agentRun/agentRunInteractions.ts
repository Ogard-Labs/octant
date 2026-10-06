import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunId,
  NativeHarnessApproval,
  ProviderRuntimeEvent,
  ProviderInstanceId,
  NativeHarnessSlotCandidate,
} from "@octant/contracts";
import {
  clampAgentRunAuthority,
  effectiveAgentRunExecutionTarget,
} from "@octant/domain/agent-run-policy";
import type { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import type { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";
import type { NativeHarnessToolPorts } from "../harness/nativeHarnessTools";
import { clampAgentRunSessionAuthority } from "./agentRunSessionRuntime";

export interface AgentRunInteractionOptions {
  readonly getById: (id: AgentRunId) => AgentRun | undefined;
  readonly approvals: Pick<NativeHarnessApprovalStore, "ask">;
  readonly questions: Pick<NativeHarnessQuestionStore, "ask">;
  readonly providerName?: (id: ProviderInstanceId) => string | undefined;
  readonly parentLead: (run: AgentRun) => NativeHarnessSlotCandidate | undefined;
  readonly parentAuthority: (run: AgentRun) => AgentRunAuthority | undefined;
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
    readonly signal?: AbortSignal;
  }) => {
    if (!current(input.run, input.signal)) return "cancelled" as const;
    // A provider's opaque prompt cannot widen Plan or the child's admitted
    // authority. Native tool prompts have already passed the tool policy.
    if (
      input.toolName === "provider-action" &&
      clampAgentRunSessionAuthority(input.run).executionPolicy === "plan"
    )
      return "denied" as const;
    const parent = scope(input.run);
    if (parent.lead === undefined) return "cancelled" as const;
    const outcome = await options.approvals.ask({
      ...parent,
      lead: parent.lead,
      toolName: input.toolName,
      summary: input.summary,
      approvalClass: input.approvalClass,
      signal: input.signal,
    });
    return current(input.run, input.signal) ? outcome : ("cancelled" as const);
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
      readonly signal: AbortSignal;
    }): Promise<boolean> =>
      (await approve({
        ...input,
        toolName: "provider-action",
        summary: `${input.event.action}: ${input.event.description}`,
        approvalClass: "child-provider-action",
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
    toolsFor: (run: AgentRun): Pick<NativeHarnessToolPorts, "approvals" | "askUser"> => ({
      approvals: (input) => approve({ ...input, run }),
      askUser: async (input) => {
        const outcome = await ask({ ...input, run });
        return outcome;
      },
    }),
  };
}
