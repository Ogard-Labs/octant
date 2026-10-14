import type { ProviderExecutionPolicy } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessageService } from "./agentMessageService";
import { AGENT_MESSAGE_TOOL_NAME, createAgentMessageTools } from "./agentMessageTools";

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
  const tools = createAgentMessageTools({
    service: { send, recordRefusedSend },
    senderThreadId,
    toolConstraints: options.toolConstraints ?? [],
    profileDisplayName: "Reviewer",
    readPosture: () => posture,
  });
  return {
    tools,
    send,
    recordRefusedSend,
    setPosture: (next: ProviderExecutionPolicy) => {
      posture = next;
    },
  };
}

describe("the agent message tool", () => {
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
    });
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
