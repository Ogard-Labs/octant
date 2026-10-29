// An agent's helper request that names a target member. It reaches the same
// delegating service the loopback administration routes use, so the parent
// thread's rules, the peer grant on the target, the approvals there, the result
// framed as outside content, and cancellation are one set of rules. The agent
// supplies a task and a member; it never supplies a posture.

import { decodeDelegationStartCommand, type Project } from "@octant/contracts";
import type {
  AgentRunDelegationResult,
  RemoteDelegationPort,
} from "../agentRun/agentRunDelegation";
import type { DelegatingSpokeService } from "./delegatingSpokeService";

export interface AgentRemoteDelegationOptions {
  readonly delegation: Pick<DelegatingSpokeService, "delegate">;
  readonly readProject: (projectId: string) => Pick<Project, "type"> | undefined;
  readonly isWorkEnabled: () => boolean;
}

const WORK_ONLY_MESSAGE =
  "Only a Work thread in a Work Project can start a helper on another member.";

function refusal(reason: string, message?: string): AgentRunDelegationResult {
  return { status: "refused", reason, ...(message === undefined ? {} : { message }) };
}

export function createAgentRemoteDelegation(
  options: AgentRemoteDelegationOptions,
): RemoteDelegationPort {
  return {
    start: async (input) => {
      if (input.mode !== "work" || input.projectId === undefined) {
        return refusal("remote-delegation-work-only", WORK_ONLY_MESSAGE);
      }
      if (options.readProject(input.projectId)?.type !== "work") {
        return refusal("remote-delegation-work-only", WORK_ONLY_MESSAGE);
      }
      if (!options.isWorkEnabled()) {
        return refusal("work-disabled", "Work is turned off on this host.");
      }
      let command: ReturnType<typeof decodeDelegationStartCommand>;
      try {
        // Work asks first and has no read-only posture, so the request is always
        // approval-gated: the parent's ceiling and the member's grant clamp it
        // further, and a request above either is refused, never run narrower.
        command = decodeDelegationStartCommand({
          parent: { mode: "work", threadId: input.parentThreadId },
          targetMemberId: input.targetMemberId,
          projectId: input.projectId,
          task: input.task,
          authority: { mode: "work", posture: "approval-gated" },
        });
      } catch {
        return refusal("not-in-roster", "No member of this hub has that id.");
      }
      const outcome = await options.delegation.delegate(command, { windowId: input.windowId });
      switch (outcome.status) {
        case "delegated":
          return {
            status: "delegated-remote",
            requestId: String(outcome.requestId),
            targetMemberId: input.targetMemberId,
            state: "accepted",
            authority: { mode: outcome.authority.mode, posture: outcome.authority.posture },
          };
        case "pending-acceptance":
          return {
            status: "delegated-remote",
            requestId: String(outcome.requestId),
            targetMemberId: input.targetMemberId,
            state: "pending-acceptance",
          };
        case "refused-by-target":
          // The member's own words are outside content and stay out of the model's context.
          return refusal(
            "target-refused",
            `The member refused the request (HTTP ${outcome.httpStatus}); its grant does not allow it.`,
          );
        case "refused":
          return refusal(outcome.kind);
      }
    },
  };
}
