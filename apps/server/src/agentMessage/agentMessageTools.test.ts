import { decodeAgentMessageStatusSummary, type ProviderExecutionPolicy } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessageService } from "./agentMessageService";
import {
  AGENT_MESSAGE_TOOL_NAME,
  MAX_JOURNALED_REFUSALS_PER_TURN,
  createAgentMessageTools,
} from "./agentMessageTools";

const senderThreadId = "code-0000-0000-4000-8000-00000000000a";
const recipientThreadId = "code-0000-0000-4000-8000-00000000000b";
const call = {
  name: AGENT_MESSAGE_TOOL_NAME,
  inputJson: JSON.stringify({ recipients: [{ threadId: recipientThreadId }], message: "Handoff." }),
};

function fixture(
  options: {
    readonly posture?: ProviderExecutionPolicy;
    readonly toolConstraints?: ReadonlyArray<string>;
  } = {},
) {
  let posture: ProviderExecutionPolicy = options.posture ?? "approval-gated";
  const send = vi.fn<AgentMessageService["send"]>(async (request) =>
    request.recipients.map((recipient) => ({
      status: "sent" as const,
      messageId: "10000000-0000-4000-8000-000000000001" as never,
      recipientThreadId: recipient.threadId,
      message: "Admitted.",
    })),
  );
  const recordRefusedSend = vi.fn<AgentMessageService["recordRefusedSend"]>(async () => undefined);
  const acknowledge = vi.fn<AgentMessageService["acknowledge"]>(async () => ({
    status: "refused",
    reason: "unauthorized",
    message: "Unavailable",
  }));
  const statusForSender = vi.fn<AgentMessageService["statusForSender"]>(() => []);
  const tools = createAgentMessageTools({
    service: { send, recordRefusedSend, acknowledge, statusForSender },
    senderThreadId,
    toolConstraints: options.toolConstraints ?? [],
    profileDisplayName: "Reviewer",
    readPosture: () => posture,
  });
  return {
    tools,
    send,
    recordRefusedSend,
    acknowledge,
    statusForSender,
    setPosture: (next: ProviderExecutionPolicy) => {
      posture = next;
    },
  };
}

describe("the agent message tool", () => {
  it.each(["posture", "cancel", "journal"])(
    "preserves partial receipt facts and rechecks authority after %s changes",
    async (change) => {
      const { tools, acknowledge, setPosture } = fixture();
      const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
      const abort = new AbortController();
      acknowledge.mockImplementationOnce(async () => {
        if (change === "posture") setPosture("plan");
        if (change === "cancel") abort.abort();
        return {
          status: "ok",
          receipt: decodeAgentMessageStatusSummary({
            messageId: ids[0],
            senderThreadId: recipientThreadId,
            recipientThreadId: senderThreadId,
            state: "acknowledged",
            occurredAt: "2026-11-02T10:00:00.000Z",
          }),
        };
      });
      if (change === "journal") acknowledge.mockRejectedValueOnce(new Error("journal unavailable"));
      const result = await tools.execute({
        name: AGENT_MESSAGE_TOOL_NAME,
        inputJson: JSON.stringify({ action: "acknowledge", messageIds: ids }),
        signal: abort.signal,
      });
      expect(result).toMatchObject({
        isError: true,
        result: [
          { status: "ok", receipt: { state: "acknowledged" } },
          { status: change === "journal" ? "unavailable" : "refused" },
        ],
      });
      expect(acknowledge).toHaveBeenCalledTimes(change === "journal" ? 2 : 1);
    },
  );

  it("reports unavailable instead of an invented receipt when the host read fails", async () => {
    const { tools, statusForSender } = fixture();
    statusForSender.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    expect(
      await tools.execute({
        name: AGENT_MESSAGE_TOOL_NAME,
        inputJson: JSON.stringify({
          action: "status",
          messageIds: ["10000000-0000-4000-8000-000000000001"],
        }),
      }),
    ).toMatchObject({ isError: true, result: [{ status: "unavailable" }] });
  });

  it.each(["acknowledge", "status"])(
    "binds %s to the actual current thread rather than a model-supplied actor",
    async (action) => {
      const { tools, acknowledge, statusForSender } = fixture();
      const messageIds = ["10000000-0000-4000-8000-000000000001"];
      await tools.execute({
        name: AGENT_MESSAGE_TOOL_NAME,
        inputJson: JSON.stringify({ action, messageIds }),
      });
      if (action === "acknowledge")
        expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
          messageId: messageIds[0],
          recipientThreadId: senderThreadId,
        });
      else expect(statusForSender).toHaveBeenCalledExactlyOnceWith({ senderThreadId, messageIds });
      acknowledge.mockClear();
      statusForSender.mockClear();
      expect(
        await tools.execute({
          name: AGENT_MESSAGE_TOOL_NAME,
          inputJson: JSON.stringify({ action, messageIds, recipientThreadId }),
        }),
      ).toMatchObject({ isError: true });
      expect(acknowledge).not.toHaveBeenCalled();
      expect(statusForSender).not.toHaveBeenCalled();
    },
  );
  it.each(["acknowledge", "status"])(
    "preserves Plan, profile and cancellation refusal for %s",
    async (action) => {
      const inputJson = JSON.stringify({
        action,
        messageIds: ["10000000-0000-4000-8000-000000000001"],
      });
      for (const options of [{ posture: "plan" as const }, { toolConstraints: ["read"] }]) {
        const { tools, acknowledge, statusForSender } = fixture(options);
        expect(tools.definitions).toEqual([]);
        expect(await tools.execute({ name: AGENT_MESSAGE_TOOL_NAME, inputJson })).toMatchObject({
          isError: true,
        });
        expect(acknowledge).not.toHaveBeenCalled();
        expect(statusForSender).not.toHaveBeenCalled();
      }
      const { tools, acknowledge, statusForSender } = fixture();
      const abort = new AbortController();
      abort.abort();
      expect(
        await tools.execute({ name: AGENT_MESSAGE_TOOL_NAME, inputJson, signal: abort.signal }),
      ).toMatchObject({ isError: true });
      expect(acknowledge).not.toHaveBeenCalled();
      expect(statusForSender).not.toHaveBeenCalled();
    },
  );

  it("petitions the host for the sender's own thread and returns each recipient's outcome", async () => {
    const { tools, send } = fixture();

    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      AGENT_MESSAGE_TOOL_NAME,
    ]);
    const outcome = await tools.execute(call);

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toEqual([
      expect.objectContaining({ status: "sent", recipientThreadId }),
    ]);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Handoff.",
      refusalBudget: expect.anything(),
    });
  });

  it("is not offered to a turn that starts in Plan, and a call from one sends nothing", async () => {
    const { tools, send } = fixture({ posture: "plan" });

    expect(tools.definitions).toEqual([]);
    const outcome = await tools.execute(call);

    expect(outcome).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy", message: expect.stringContaining("Plan") },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to send once the thread dropped to Plan while its turn was running", async () => {
    const { tools, send, recordRefusedSend, setPosture } = fixture();
    expect(tools.definitions).toHaveLength(1);
    setPosture("plan");

    expect(await tools.execute(call)).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy" },
    });
    expect(send).not.toHaveBeenCalled();
    // The refusal is journaled so the Agents center can show it.
    expect(recordRefusedSend).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      reason: "policy",
      refusalBudget: expect.anything(),
    });
  });

  it("journals a call that names a recipient but carries no message, and one with an undecodable recipient next to a good one", async () => {
    const { tools, send, recordRefusedSend } = fixture();

    expect(
      await tools.execute({
        name: AGENT_MESSAGE_TOOL_NAME,
        inputJson: JSON.stringify({ recipients: [{ threadId: recipientThreadId }] }),
      }),
    ).toMatchObject({ isError: true, result: { status: "refused", reason: "policy" } });
    expect(
      await tools.execute({
        name: AGENT_MESSAGE_TOOL_NAME,
        inputJson: JSON.stringify({
          recipients: [{ threadId: recipientThreadId }, { threadId: "" }],
          message: "Handoff.",
        }),
      }),
    ).toMatchObject({ isError: true, result: { status: "refused" } });

    expect(send).not.toHaveBeenCalled();
    expect(recordRefusedSend).toHaveBeenCalledTimes(2);
    expect(recordRefusedSend).toHaveBeenLastCalledWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      reason: "policy",
      refusalBudget: expect.anything(),
    });
  });

  it("lets a turn journal each distinct refusal once and only up to its cap, however long the model loops", async () => {
    const { tools, recordRefusedSend } = fixture({ posture: "plan" });
    // Stand in for the service: it journals a refusal when the turn's budget admits it.
    let journaled = 0;
    recordRefusedSend.mockImplementation(async (request) => {
      for (const recipient of request.recipients) {
        if (request.refusalBudget?.admit(String(recipient.threadId), request.reason) !== false) {
          journaled += 1;
        }
      }
    });

    // The same refused call, over and over, is one refusal.
    for (let attempt = 0; attempt < 30; attempt += 1) await tools.execute(call);
    expect(journaled).toBe(1);

    // Calls naming a new thread each are one more, until the cap.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const threadId = `code-0000-0000-4000-8000-${String(attempt).padStart(12, "0")}`;
      await tools.execute({
        name: AGENT_MESSAGE_TOOL_NAME,
        inputJson: JSON.stringify({ recipients: [{ threadId }], message: "Handoff." }),
      });
    }
    expect(journaled).toBe(MAX_JOURNALED_REFUSALS_PER_TURN);
  });

  it("answers a refused call the same when the refusal cannot be journaled or names nobody", async () => {
    const { tools, recordRefusedSend } = fixture({ posture: "plan" });
    recordRefusedSend.mockRejectedValueOnce(new Error("journal unavailable"));

    expect(await tools.execute(call)).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy" },
    });
    expect(
      await tools.execute({ name: AGENT_MESSAGE_TOOL_NAME, inputJson: "not json" }),
    ).toMatchObject({ isError: true, result: { status: "refused" } });
    expect(recordRefusedSend).toHaveBeenCalledTimes(1);
  });

  it("is withheld from a profile whose tool allowlist leaves it out, and offered to one that names it", async () => {
    const excluded = fixture({ toolConstraints: ["octant_terminal"] });

    expect(excluded.tools.definitions).toEqual([]);
    expect(await excluded.tools.execute(call)).toMatchObject({
      isError: true,
      result: {
        status: "refused",
        reason: "policy",
        message: expect.stringContaining("Reviewer"),
      },
    });
    expect(excluded.send).not.toHaveBeenCalled();

    const named = fixture({ toolConstraints: ["octant_terminal", AGENT_MESSAGE_TOOL_NAME] });
    expect(named.tools.definitions).toHaveLength(1);
    expect((await named.tools.execute(call)).isError).toBeUndefined();
  });
});
