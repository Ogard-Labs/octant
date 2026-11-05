import {
  decodeAgentMessageEndpointId,
  decodeAgentMessageReceiptRequest,
  type AgentMessageEndpointId,
} from "@octant/contracts";
import {
  AGENT_MESSAGE_UNREACHABLE,
  MAX_AGENT_MESSAGE_RECIPIENTS,
  parseSiblingThreadReference,
} from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { AgentMessageRefusalBudget, AgentMessageService } from "./agentMessageService";

type ToolOutcome = Awaited<ReturnType<AppManagedToolSet["execute"]>>;

/**
 * How many refusals one turn may journal. Every journaled refusal is read back
 * at each start, under a fixed scan bound, so a model that loops on a refused
 * call must not be able to fill it. The refusal is still the answer the sender
 * gets once the budget is spent.
 */
export const MAX_JOURNALED_REFUSALS_PER_TURN = 8;

/** One turn's refusals: each distinct (recipient, reason) once, up to the cap. */
function createRefusalBudget(): AgentMessageRefusalBudget {
  const journaled = new Set<string>();
  return {
    admit: (recipientThreadId, reason) => {
      const key = `${reason}\u0000${recipientThreadId}`;
      if (journaled.has(key) || journaled.size >= MAX_JOURNALED_REFUSALS_PER_TURN) return false;
      journaled.add(key);
      return true;
    },
  };
}

export type AgentMessageOperation = "send" | "acknowledge" | "receipts";

/**
 * The messaging operations of the threads tool (`send`, `acknowledge`, and
 * `receipts`) for one sender turn. The threads tool decides whether the turn
 * may message at all (its mode, profile, and Plan) and asks {@link refuse} to
 * answer and journal a call it refuses; what is left here is what the host does
 * with an admitted call.
 *
 * A recipient is a `<thread id>@<project id>` reference, the form `list`
 * returns. Its Project part must be the sender's current Project; any other
 * reference is unreachable, in the same sentence the delivery service uses for
 * a thread of another Project, so the same text can never be read as a thread
 * somewhere else.
 */
export function createAgentMessageOperations(input: {
  readonly service: Pick<
    AgentMessageService,
    "send" | "recordRefusedSend" | "acknowledge" | "statusForSender"
  >;
  readonly senderThreadId: string;
  /** The sender's Project as the host holds it now. */
  readonly senderProjectId: () => string | undefined;
}) {
  const refusalBudget = createRefusalBudget();
  const senderThreadId = decodeAgentMessageEndpointId(input.senderThreadId);

  /** The thread ids a call names, for the journal; a call naming nobody journals nothing. */
  const namedRecipients = (raw: unknown): ReadonlyArray<{ threadId: AgentMessageEndpointId }> => {
    const recipients = recipientList(raw);
    return recipients.flatMap((candidate) => {
      const named =
        typeof candidate === "string" ? parseSiblingThreadReference(candidate) : undefined;
      return named === undefined
        ? []
        : [{ threadId: decodeAgentMessageEndpointId(named.threadId) }];
    });
  };

  const journalRefusedCall = async (raw: unknown, reason: "policy" | "unauthorized") => {
    try {
      const recipients = namedRecipients(raw);
      if (recipients.length === 0) return;
      await input.service.recordRefusedSend({ senderThreadId, recipients, reason, refusalBudget });
    } catch {
      // A journal that is not available leaves the sender's answer as it was.
    }
  };

  return {
    /**
     * Answers a messaging call the threads tool refused, journaling it when it
     * is a send that names a recipient: the refusal is the sender's to see
     * here and the person's to see in the Agents center.
     */
    refuse: async (operation: AgentMessageOperation, raw: unknown, message: string) => {
      if (operation === "send") await journalRefusedCall(raw, "policy");
      return policyRefusal(message);
    },

    send: async (raw: Record<string, unknown>): Promise<ToolOutcome> => {
      const recipients = recipientList(raw);
      const message = raw.message;
      const extra = Object.keys(raw).some(
        (key) => key !== "operation" && key !== "recipients" && key !== "message",
      );
      if (
        extra ||
        recipients.length === 0 ||
        typeof message !== "string" ||
        recipients.some((recipient) => typeof recipient !== "string")
      ) {
        await journalRefusedCall(raw, "policy");
        return policyRefusal("A recipient reference and a message are required.");
      }
      const projectId = input.senderProjectId();
      const resolved = recipients.map((reference) => {
        const named = parseSiblingThreadReference(String(reference));
        return {
          reference: String(reference),
          threadId: named === undefined ? undefined : decodeAgentMessageEndpointId(named.threadId),
          inProject:
            named !== undefined && projectId !== undefined && named.projectId === projectId,
        };
      });
      const addressed = resolved.flatMap((recipient) =>
        recipient.threadId === undefined ? [] : [{ ...recipient, threadId: recipient.threadId }],
      );
      // A send naming more recipients than the bound is refused as a whole by
      // the service, which journals its first ones; it must see them all.
      const overBound = recipients.length > MAX_AGENT_MESSAGE_RECIPIENTS;
      const admitted = overBound ? addressed : addressed.filter((recipient) => recipient.inProject);
      const outsideProject = overBound ? [] : addressed.filter((recipient) => !recipient.inProject);
      if (outsideProject.length > 0) {
        try {
          await input.service.recordRefusedSend({
            senderThreadId,
            recipients: outsideProject.map((recipient) => ({ threadId: recipient.threadId })),
            reason: "unauthorized",
            refusalBudget,
          });
        } catch {
          // As above: the sender's answer does not depend on the journal.
        }
      }
      const referenceOf = new Map(
        addressed.map((recipient) => [String(recipient.threadId), recipient.reference]),
      );
      const outcomes: Array<Record<string, unknown>> = resolved
        .filter((recipient) => !overBound && !recipient.inProject)
        .map((recipient) => ({
          status: "refused",
          recipient: recipient.reference,
          reason: "unauthorized",
          message: AGENT_MESSAGE_UNREACHABLE,
        }));
      if (admitted.length > 0) {
        try {
          const sent = await input.service.send({
            senderThreadId,
            recipients: admitted.map((recipient) => ({ threadId: recipient.threadId })),
            body: message,
            refusalBudget,
          });
          for (const outcome of sent) {
            const { recipientThreadId, ...rest } = outcome;
            outcomes.push({
              ...rest,
              recipient: referenceOf.get(String(recipientThreadId)) ?? String(recipientThreadId),
            });
          }
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
      }
      // Each recipient's outcome is the answer, sent or refused, as the
      // service gives it; the call itself did not fail.
      return { result: outcomes };
    },

    receipts: (raw: Record<string, unknown>): ToolOutcome => {
      const messageIds = receiptIds(raw, "status");
      if (messageIds === undefined) return policyRefusal("The receipt request is invalid.");
      try {
        const receipts = input.service.statusForSender({
          senderThreadId: String(senderThreadId),
          messageIds,
        });
        return {
          result: receipts,
          ...(receipts.some((receipt) => receipt.status !== "ok") ? { isError: true } : {}),
        };
      } catch {
        return {
          result: [{ status: "unavailable", message: "The host could not read message receipts." }],
          isError: true,
        };
      }
    },

    /**
     * Reports receipt of messages delivered to this thread, one at a time.
     * `stillAdmitted` is asked before each one, because a turn can drop to
     * Plan or be cancelled while an earlier acknowledgement is journaled.
     */
    acknowledge: async (
      raw: Record<string, unknown>,
      stillAdmitted: () => boolean,
    ): Promise<ToolOutcome> => {
      const messageIds = receiptIds(raw, "acknowledge");
      if (messageIds === undefined) return policyRefusal("The receipt request is invalid.");
      const receipts = [];
      for (const messageId of messageIds) {
        if (!stillAdmitted()) {
          receipts.push({
            status: "refused" as const,
            reason: "policy" as const,
            message: "The turn can no longer acknowledge messages.",
          });
          continue;
        }
        try {
          receipts.push(
            await input.service.acknowledge({
              messageId: String(messageId),
              recipientThreadId: String(senderThreadId),
            }),
          );
        } catch {
          receipts.push({
            status: "unavailable" as const,
            message: "The acknowledgement could not be confirmed.",
          });
        }
      }
      return {
        result: receipts,
        ...(receipts.some((receipt) => receipt.status !== "ok") ? { isError: true } : {}),
      };
    },
  };
}

function recipientList(raw: unknown): ReadonlyArray<unknown> {
  if (typeof raw !== "object" || raw === null || !("recipients" in raw)) return [];
  return Array.isArray(raw.recipients) ? raw.recipients : [];
}

/** The ids of a receipt request, decoded with the contract's own bounds. */
function receiptIds(raw: Record<string, unknown>, action: "acknowledge" | "status") {
  if (Object.keys(raw).some((key) => key !== "operation" && key !== "messageIds")) return undefined;
  try {
    return decodeAgentMessageReceiptRequest({ action, messageIds: raw.messageIds }).messageIds;
  } catch {
    return undefined;
  }
}

function policyRefusal(message: string): ToolOutcome {
  return { result: { status: "refused", reason: "policy", message }, isError: true };
}
