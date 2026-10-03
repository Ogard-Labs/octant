import type {
  AgentRun,
  AgentRunId,
  AgentRunResultDeliveryMark,
  OctantMode,
} from "@octant/contracts";

/** Legacy marks name one member; a batch explicitly includes that primary member. */
export function agentResultDeliveryRunIds(
  mark: Pick<AgentRunResultDeliveryMark, "runId" | "runIds">,
): ReadonlyArray<AgentRunId> {
  return mark.runIds ?? [mark.runId];
}

export interface AgentResultDeliveryMember {
  readonly runId: AgentRunId;
  readonly generation: number;
}

export function agentRunResultGeneration(run: {
  readonly id: AgentRunId;
  readonly generation?: number;
}): number {
  return run.generation ?? 1;
}

export function agentResultDeliveryMembers(
  mark: Pick<AgentRunResultDeliveryMark, "runId" | "runIds" | "runGenerations">,
): ReadonlyArray<AgentResultDeliveryMember> {
  return (
    mark.runGenerations ??
    agentResultDeliveryRunIds(mark).map((runId) => ({ runId, generation: 1 }))
  );
}

/** Only the intersection is covered when replay combines an old group with new results. */
export function coveredAgentResultDeliveryMembers(
  requested: Pick<AgentRunResultDeliveryMark, "runId" | "runIds" | "runGenerations">,
  marks: ReadonlyArray<AgentRunResultDeliveryMark>,
): ReadonlyArray<AgentResultDeliveryMember> {
  const delivered = new Set(
    marks
      .flatMap(agentResultDeliveryMembers)
      .map((member) => `${member.runId}:${member.generation}`),
  );
  return agentResultDeliveryMembers(requested).filter((member) =>
    delivered.has(`${member.runId}:${member.generation}`),
  );
}

export function validateAgentResultDelivery(input: {
  readonly delivery: Pick<AgentRunResultDeliveryMark, "runId" | "runIds" | "runGenerations">;
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly getById: (id: AgentRunId) => AgentRun | undefined;
}):
  | { readonly kind: "valid"; readonly runs: ReadonlyArray<AgentRun> }
  | { readonly kind: "invalid"; readonly detail: string } {
  const runs: AgentRun[] = [];
  for (const member of agentResultDeliveryMembers(input.delivery)) {
    const id = member.runId;
    const run = input.getById(id);
    if (
      run === undefined ||
      String(run.id) !== String(id) ||
      String(run.parentThreadId) !== input.threadId ||
      run.workspaceReceipt.mode !== input.mode ||
      run.routingReceipt.mode !== input.mode
    ) {
      return {
        kind: "invalid",
        detail: `A named subagent run does not belong to this ${input.mode} thread.`,
      };
    }
    if (agentRunResultGeneration(run) !== member.generation)
      return { kind: "invalid", detail: "A named subagent result generation is stale." };
    if (
      run.lifecycleStatus !== "completed" &&
      run.lifecycleStatus !== "failed" &&
      run.lifecycleStatus !== "cancelled"
    ) {
      return { kind: "invalid", detail: "A named subagent run has not finished." };
    }
    runs.push(run);
  }
  return { kind: "valid", runs };
}
