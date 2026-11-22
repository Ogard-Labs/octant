// An agent's helper request that names a target member. It reaches the same
// delegating service the loopback administration routes use, so the parent
// thread's rules, the peer grant on the target, the approvals there, the result
// framed as outside content, and cancellation are one set of rules. The agent
// supplies a task, a member and that member's own id for the Project; it never
// supplies a posture. This host's Project id only identifies the parent's Project
// here: Projects have their own ids on each host, so it is never sent on.

import { decodeDelegationStartCommand, type Project } from "@octant/contracts";
import type {
  AgentRunDelegationResult,
  RemoteDelegationPort,
} from "../agentRun/agentRunDelegation";
import type { DelegatingSpokeService } from "./delegatingSpokeService";

export interface AgentRemoteDelegationOptions {
  readonly delegation: Pick<DelegatingSpokeService, "delegate" | "listTargets">;
  readonly readProject: (projectId: string) => Pick<Project, "type"> | undefined;
  readonly isWorkEnabled: () => boolean;
}

const WORK_ONLY_MESSAGE =
  "Only a Work thread in a Work Project, or a Code thread in a Code Project, can start a helper on another member.";

function refusal(reason: string, message?: string): AgentRunDelegationResult {
  return { status: "refused", reason, ...(message === undefined ? {} : { message }) };
}

export function createAgentRemoteDelegation(
  options: AgentRemoteDelegationOptions,
): RemoteDelegationPort {
  return {
    listTargets: () => options.delegation.listTargets(),
    start: async (input) => {
      // A Work thread in a Work Project sends Work; a Code thread in a Code
      // Project sends Code, which the member takes only into a Project its
      // person marked for it.
      const mode = input.mode === "work" || input.mode === "code" ? input.mode : undefined;
      if (
        mode === undefined ||
        input.projectId === undefined ||
        options.readProject(input.projectId)?.type !== mode
      ) {
        return refusal("remote-delegation-work-only", WORK_ONLY_MESSAGE);
      }
      if (mode === "work" && !options.isWorkEnabled()) {
        return refusal("work-disabled", "Work is turned off on this host.");
      }
      let command: ReturnType<typeof decodeDelegationStartCommand>;
      try {
        // Always approval-gated: the parent's ceiling and the member's grant
        // clamp it further, and a request above either is refused, never run
        // narrower.
        command = decodeDelegationStartCommand({
          parent: { mode, threadId: input.parentThreadId },
          targetMemberId: input.targetMemberId,
          projectId: input.targetProjectId,
          task: input.task,
          authority: { mode, posture: "approval-gated" },
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
          // A member that paused new work keeps the sender's grant; the
          // agent hears that, matched to the one known word, never the text.
          if (outcome.reason === "not-accepting") {
            return refusal(
              "target-not-accepting",
              "The member is not accepting new delegated work right now; its grant is unchanged.",
            );
          }
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
