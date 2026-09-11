import {
  decodeAgentMessageEndpointId,
  type AgentMessageEndpointId,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { AgentMessageService } from "./agentMessageService";

export const AGENT_MESSAGE_TOOL_NAME = "octant_agent_message";

const MAX_TOOL_MESSAGE_BYTES = 65_536;

const definition: ProviderToolDefinition = {
  name: AGENT_MESSAGE_TOOL_NAME,
  description:
    "Send a bounded message to another real thread or child run on this host. The host admits, journals, and delivers it; the recipient sees it as untrusted data with your thread named as the source. Use it to hand off findings or ask a sibling thread a question — it never grants you the recipient's authority or starts a turn there.",
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
            runId: { type: "string", maxLength: 128 },
          },
          required: ["threadId"],
          additionalProperties: false,
        },
        description: "Threads (or runs) to deliver the message to, by their durable ids.",
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
  readonly recipients: ReadonlyArray<{ readonly threadId: string; readonly runId?: string }>;
  readonly message: string;
}

export function createAgentMessageTools(input: {
  readonly service: AgentMessageService;
  readonly senderThreadId: string;
  readonly senderRunId?: string;
}): AppManagedToolSet {
  const senderThreadId = decodeAgentMessageEndpointId(input.senderThreadId);
  const senderRunId =
    input.senderRunId === undefined ? undefined : decodeAgentMessageEndpointId(input.senderRunId);
  return {
    definitions: [definition],
    execute: async ({ inputJson, signal }) => {
      if (signal?.aborted) {
        return {
          result: { status: "refused", reason: "policy", message: "The turn was cancelled." },
          isError: true,
        };
      }
      let recipients: ReadonlyArray<{ threadId: string; runId?: string }>;
      let message: string;
      try {
        const parsed = JSON.parse(inputJson) as {
          recipients?: ReadonlyArray<{ threadId?: unknown; runId?: unknown }>;
          message?: unknown;
        };
        const decodedRecipients = (parsed.recipients ?? []).map((candidate) => ({
          threadId: decodeAgentMessageEndpointId(String(candidate.threadId)),
          ...(candidate.runId === undefined
            ? {}
            : { runId: decodeAgentMessageEndpointId(String(candidate.runId)) }),
        }));
        if (decodedRecipients.length === 0 || typeof parsed.message !== "string") {
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
        return {
          result: { status: "refused", reason: "policy", message: "The tool input is invalid." },
          isError: true,
        };
      }
      try {
        const outcomes = await input.service.send({
          senderThreadId,
          ...(senderRunId === undefined ? {} : { senderRunId }),
          recipients: recipients.map(
            (recipient): { threadId: AgentMessageEndpointId; runId?: AgentMessageEndpointId } => ({
              threadId: decodeAgentMessageEndpointId(recipient.threadId),
              ...(recipient.runId === undefined
                ? {}
                : { runId: decodeAgentMessageEndpointId(recipient.runId) }),
            }),
          ),
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
