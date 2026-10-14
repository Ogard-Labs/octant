import {
  decodeAgentMessageEndpointId,
  type AgentMessageEndpointId,
  type ProviderExecutionPolicy,
  type ProviderToolDefinition,
} from "@octant/contracts";
import { decideProfileToolConstraint } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { AgentMessageService } from "./agentMessageService";

export const AGENT_MESSAGE_TOOL_NAME = "octant_agent_message";

const MAX_TOOL_MESSAGE_BYTES = 65_536;

const definition: ProviderToolDefinition = {
  name: AGENT_MESSAGE_TOOL_NAME,
  description:
    "Send a bounded message to another thread of this Project, addressed by its id. The host admits and journals it, and the recipient reads it as untrusted data, with your thread's id as the source, at the start of its next turn. Use it to hand off findings or leave a sibling thread a question — it never grants you the recipient's authority, starts no turn there, and returns no reply.",
  inputSchema: {
    type: "object",
    properties: {
      recipients: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            threadId: { type: "string", maxLength: 128 },
          },
          required: ["threadId"],
          additionalProperties: false,
        },
        description: "Threads of this Project to send the message to, by their durable ids.",
      },
      message: {
        type: "string",
        maxLength: MAX_TOOL_MESSAGE_BYTES,
        description: "The bounded message body the recipients will read as data.",
      },
    },
    required: ["recipients", "message"],
    additionalProperties: false,
  },
};

export interface AgentMessageToolInput {
  readonly recipients: ReadonlyArray<{ readonly threadId: string }>;
  readonly message: string;
}

const PLAN_REFUSAL = "Plan mode is read-only; this thread cannot send an agent message.";

/**
 * The message tool for one sender turn.
 *
 * Sending stores a body, appends journal events, and later taints another
 * thread, so it passes the same checks as any other effect a turn asks for: a
 * profile whose allowlist leaves the tool out, and a turn in Plan, are not
 * offered it. Both are read again on every call, because a tool set outlives
 * the moment it was composed and a thread can drop to Plan while its turn
 * runs. A refused call never reaches the delivery service.
 */
export function createAgentMessageTools(input: {
  readonly service: Pick<AgentMessageService, "send" | "recordRefusedSend">;
  readonly senderThreadId: string;
  readonly senderRunId?: string;
  /** The sender thread's snapshotted profile allowlist; empty permits every tool. */
  readonly toolConstraints: ReadonlyArray<string>;
  readonly profileDisplayName: string;
  /** The turn's access posture now, never wider than the one it started with. */
  readonly readPosture: () => ProviderExecutionPolicy;
}): AppManagedToolSet {
  const senderThreadId = decodeAgentMessageEndpointId(input.senderThreadId);
  const senderRunId =
    input.senderRunId === undefined ? undefined : decodeAgentMessageEndpointId(input.senderRunId);
  const refusal = (): string | undefined => {
    const profile = decideProfileToolConstraint({
      toolId: AGENT_MESSAGE_TOOL_NAME,
      toolConstraints: input.toolConstraints,
      profileDisplayName: input.profileDisplayName,
    });
    if (profile.status === "refused") return profile.reason;
    return input.readPosture() === "plan" ? PLAN_REFUSAL : undefined;
  };
  const journalRefusedCall = async (inputJson: string): Promise<void> => {
    try {
      const parsed = JSON.parse(inputJson) as {
        recipients?: ReadonlyArray<{ threadId?: unknown }>;
      };
      const recipients = (parsed.recipients ?? []).flatMap((candidate) => {
        try {
          return [{ threadId: decodeAgentMessageEndpointId(String(candidate.threadId)) }];
        } catch {
          return [];
        }
      });
      if (recipients.length === 0) return;
      await input.service.recordRefusedSend({ senderThreadId, recipients, reason: "policy" });
    } catch {
      // A call too malformed to name a recipient, or a journal that is not
      // available, leaves the sender's answer as it was.
    }
  };
  return {
    // A tool this turn could only be refused is omitted, not advertised.
    definitions: refusal() === undefined ? [definition] : [],
    execute: async ({ inputJson, signal }) => {
      if (signal?.aborted) {
        return {
          result: { status: "refused", reason: "policy", message: "The turn was cancelled." },
          isError: true,
        };
      }
      const refused = refusal();
      if (refused !== undefined) {
        // The refusal is the sender's to see here and the person's to see in
        // the Agents center, so it is journaled when the call names anyone.
        await journalRefusedCall(inputJson);
        return { result: { status: "refused", reason: "policy", message: refused }, isError: true };
      }
      let recipients: ReadonlyArray<{ threadId: string }>;
      let message: string;
      try {
        const parsed = JSON.parse(inputJson) as {
          recipients?: ReadonlyArray<{ threadId?: unknown }>;
          message?: unknown;
        };
        const decodedRecipients = (parsed.recipients ?? []).map((candidate) => ({
          threadId: decodeAgentMessageEndpointId(String(candidate.threadId)),
        }));
        if (decodedRecipients.length === 0 || typeof parsed.message !== "string") {
          await journalRefusedCall(inputJson);
          return {
            result: {
              status: "refused",
              reason: "policy",
              message: "A recipient and a message are required.",
            },
            isError: true,
          };
        }
        recipients = decodedRecipients;
        message = parsed.message;
      } catch {
        await journalRefusedCall(inputJson);
        return {
          result: { status: "refused", reason: "policy", message: "The tool input is invalid." },
          isError: true,
        };
      }
      try {
        const outcomes = await input.service.send({
          senderThreadId,
          ...(senderRunId === undefined ? {} : { senderRunId }),
          recipients: recipients.map((recipient): { threadId: AgentMessageEndpointId } => ({
            threadId: decodeAgentMessageEndpointId(recipient.threadId),
          })),
          body: message,
        });
        return { result: outcomes };
      } catch (error) {
        return {
          result: {
            status: "failed",
            message:
              error instanceof Error && error.message.length > 0
                ? error.message
                : "The message could not be sent.",
          },
          isError: true,
        };
      }
    },
  };
}
