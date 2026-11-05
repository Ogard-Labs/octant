import {
  SIBLING_THREADS_TOOL_NAME,
  decodeAgentMessageStatusSummary,
  decodeProjectId,
  decodeSiblingThreadId,
  type ProviderExecutionPolicy,
  type WindowId,
} from "@octant/contracts";
import { AGENT_MESSAGE_UNREACHABLE } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { createThreadsTools, type SiblingThreadSource } from "../siblingThreads/siblingThreadTools";
import type { AgentMessageService } from "./agentMessageService";
import { MAX_JOURNALED_REFUSALS_PER_TURN } from "./agentMessageTools";

const windowId = "f0000000-0000-4000-8000-0000000000ff" as WindowId;
const projectId = decodeProjectId("a0000000-0000-4000-8000-000000000001");
const otherProjectId = "b0000000-0000-4000-8000-000000000001";
const senderThreadId = "c0000000-0000-4000-8000-00000000000a";
const recipientThreadId = "c0000000-0000-4000-8000-00000000000b";
const recipient = `${recipientThreadId}@${String(projectId)}`;
const send = (overrides: Record<string, unknown> = {}) => ({
  name: SIBLING_THREADS_TOOL_NAME,
  inputJson: JSON.stringify({
    operation: "send",
    recipients: [recipient],
    message: "Handoff.",
    ...overrides,
  }),
});

/** The sender as the host holds it: an open Code thread of the Project. */
const source: SiblingThreadSource = {
  thread: (threadId) =>
    String(threadId) === senderThreadId
      ? {
          threadId: decodeSiblingThreadId(senderThreadId),
          projectId,
          mode: "code",
          closed: false,
          title: "Sender",
          state: "working",
          stateChangedAt: "2026-11-02T10:00:00.000Z",
        }
      : undefined,
  projectThreads: () => [],
  readTranscript: async () => undefined,
};

function fixture(
  options: {
    readonly posture?: ProviderExecutionPolicy;
    readonly toolConstraints?: ReadonlyArray<string>;
    readonly mode?: "work" | "code";
  } = {},
) {
  let posture: ProviderExecutionPolicy = options.posture ?? "approval-gated";
  const sendMessage = vi.fn<AgentMessageService["send"]>(async (request) =>
    request.recipients.map((named) => ({
      status: "sent" as const,
      messageId: "10000000-0000-4000-8000-000000000001" as never,
      recipientThreadId: named.threadId,
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
  const tools = createThreadsTools({
    mode: options.mode ?? "code",
    windowId,
    service: { answer: async () => Promise.reject(new Error("unused")) },
    source,
    callerThreadId: senderThreadId,
    toolConstraints: options.toolConstraints ?? [],
    profileDisplayName: "Reviewer",
    readPosture: () => posture,
    messaging: { send: sendMessage, recordRefusedSend, acknowledge, statusForSender },
  });
  const operations = () => {
    const schema = tools.definitions[0]?.inputSchema as
      | { readonly properties: { readonly operation: { readonly enum: ReadonlyArray<string> } } }
      | undefined;
    return schema?.properties.operation.enum ?? [];
  };
  return {
    tools,
    operations,
    sendMessage,
    recordRefusedSend,
    acknowledge,
    statusForSender,
    setPosture: (next: ProviderExecutionPolicy) => {
      posture = next;
    },
  };
}

describe("messaging through the threads tool", () => {
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
        name: SIBLING_THREADS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "acknowledge", messageIds: ids }),
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
        name: SIBLING_THREADS_TOOL_NAME,
        inputJson: JSON.stringify({
          operation: "receipts",
          messageIds: ["10000000-0000-4000-8000-000000000001"],
        }),
      }),
    ).toMatchObject({ isError: true, result: [{ status: "unavailable" }] });
  });

  it.each(["acknowledge", "receipts"])(
    "binds %s to the actual current thread rather than a model-supplied actor",
    async (operation) => {
      const { tools, acknowledge, statusForSender } = fixture();
      const messageIds = ["10000000-0000-4000-8000-000000000001"];
      await tools.execute({
        name: SIBLING_THREADS_TOOL_NAME,
        inputJson: JSON.stringify({ operation, messageIds }),
      });
      if (operation === "acknowledge")
        expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
          messageId: messageIds[0],
          recipientThreadId: senderThreadId,
        });
      else expect(statusForSender).toHaveBeenCalledExactlyOnceWith({ senderThreadId, messageIds });
      acknowledge.mockClear();
      statusForSender.mockClear();
      expect(
        await tools.execute({
          name: SIBLING_THREADS_TOOL_NAME,
          inputJson: JSON.stringify({ operation, messageIds, recipientThreadId }),
        }),
      ).toMatchObject({ isError: true });
      expect(acknowledge).not.toHaveBeenCalled();
      expect(statusForSender).not.toHaveBeenCalled();
    },
  );

  it.each(["acknowledge", "receipts"])(
    "refuses %s in Plan, on a profile without messaging, and on a cancelled turn",
    async (operation) => {
      const inputJson = JSON.stringify({
        operation,
        messageIds: ["10000000-0000-4000-8000-000000000001"],
      });
      for (const options of [
        { posture: "plan" as const },
        { toolConstraints: [SIBLING_THREADS_TOOL_NAME] },
      ]) {
        const { tools, operations, acknowledge, statusForSender } = fixture(options);
        expect(operations()).not.toContain(operation);
        expect(await tools.execute({ name: SIBLING_THREADS_TOOL_NAME, inputJson })).toMatchObject({
          isError: true,
        });
        expect(acknowledge).not.toHaveBeenCalled();
        expect(statusForSender).not.toHaveBeenCalled();
      }
      const { tools, acknowledge, statusForSender } = fixture();
      const abort = new AbortController();
      abort.abort();
      expect(
        await tools.execute({ name: SIBLING_THREADS_TOOL_NAME, inputJson, signal: abort.signal }),
      ).toMatchObject({ isError: true });
      expect(acknowledge).not.toHaveBeenCalled();
      expect(statusForSender).not.toHaveBeenCalled();
    },
  );

  it("sends for the caller's own thread to a reference in its Project and answers per recipient", async () => {
    const { tools, operations, sendMessage } = fixture();

    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      SIBLING_THREADS_TOOL_NAME,
    ]);
    expect(tools.definitions[0]?.description).toMatch(
      /^See this Project's other open threads and message them\./,
    );
    expect(operations()).toEqual([
      "help",
      "list",
      "read",
      "wait",
      "send",
      "acknowledge",
      "receipts",
    ]);
    const outcome = await tools.execute(send());

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toEqual([expect.objectContaining({ status: "sent", recipient })]);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      body: "Handoff.",
      refusalBudget: expect.anything(),
    });
  });

  it("refuses a reference that names another Project, even for a thread id it could reach", async () => {
    const { tools, sendMessage, recordRefusedSend } = fixture();

    const outcome = await tools.execute(
      send({ recipients: [`${recipientThreadId}@${otherProjectId}`] }),
    );

    expect(outcome.result).toEqual([
      {
        status: "refused",
        recipient: `${recipientThreadId}@${otherProjectId}`,
        reason: "unauthorized",
        message: AGENT_MESSAGE_UNREACHABLE,
      },
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordRefusedSend).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      reason: "unauthorized",
      refusalBudget: expect.anything(),
    });
  });

  it("refuses a send naming more recipients than the bound as a whole, even when most are malformed", async () => {
    const { tools, sendMessage, recordRefusedSend } = fixture();
    const wrongProject = `${recipientThreadId}@${otherProjectId}`;

    const outcome = await tools.execute(
      send({ recipients: [wrongProject, "x", "y@", "@z", "not a reference"] }),
    );

    expect(outcome).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy", message: expect.stringContaining("at most") },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordRefusedSend).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      reason: "policy",
      refusalBudget: expect.anything(),
    });
  });

  it("refuses a whole send that names a malformed reference beside one of another Project, sending to no one", async () => {
    const { tools, sendMessage, recordRefusedSend } = fixture();
    const wrongProject = `${recipientThreadId}@${otherProjectId}`;

    const outcome = await tools.execute(send({ recipients: [recipient, "x", wrongProject] }));

    expect(outcome).toMatchObject({ isError: true, result: { status: "refused" } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordRefusedSend).toHaveBeenCalled();
  });

  it("refuses a whole send that names one reference of another Project beside a good one, sending to no one", async () => {
    const { tools, sendMessage, recordRefusedSend } = fixture();
    const otherThreadId = "c0000000-0000-4000-8000-00000000000c";
    const wrongProject = `${otherThreadId}@${otherProjectId}`;

    const outcome = await tools.execute(send({ recipients: [recipient, wrongProject] }));

    expect(outcome.isError).toBe(true);
    expect(outcome.result).toEqual([
      expect.objectContaining({ status: "refused", recipient, reason: "policy" }),
      {
        status: "refused",
        recipient: wrongProject,
        reason: "unauthorized",
        message: AGENT_MESSAGE_UNREACHABLE,
      },
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordRefusedSend).toHaveBeenCalledWith({
      senderThreadId,
      recipients: [{ threadId: otherThreadId }],
      reason: "unauthorized",
      refusalBudget: expect.anything(),
    });
  });

  it("does not offer send to a turn that starts in Plan, and a send from one is refused and journaled", async () => {
    const { tools, operations, sendMessage, recordRefusedSend } = fixture({ posture: "plan" });

    expect(operations()).toEqual(["help", "list", "read", "wait"]);
    const outcome = await tools.execute(send());

    expect(outcome).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy", message: expect.stringContaining("Plan") },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordRefusedSend).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      reason: "policy",
      refusalBudget: expect.anything(),
    });
  });

  it("refuses to send once the thread dropped to Plan while its turn was running", async () => {
    const { tools, operations, sendMessage, recordRefusedSend, setPosture } = fixture();
    expect(operations()).toContain("send");
    setPosture("plan");

    expect(await tools.execute(send())).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy" },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    // The refusal is journaled so the Agents center can show it.
    expect(recordRefusedSend).toHaveBeenCalledExactlyOnceWith({
      senderThreadId,
      recipients: [{ threadId: recipientThreadId }],
      reason: "policy",
      refusalBudget: expect.anything(),
    });
  });

  it("offers a Work turn no messaging and refuses a send from one without storing anything", async () => {
    const { tools, operations, sendMessage, recordRefusedSend } = fixture({ mode: "work" });

    expect(operations()).toEqual(["help", "list", "read", "wait"]);
    expect(await tools.execute(send())).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy" },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordRefusedSend).not.toHaveBeenCalled();
  });

  it("journals a send that names a recipient but carries no message, and one with an unreadable recipient next to a good one", async () => {
    const { tools, sendMessage, recordRefusedSend } = fixture();

    expect(
      await tools.execute({
        name: SIBLING_THREADS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "send", recipients: [recipient] }),
      }),
    ).toMatchObject({ isError: true, result: { status: "refused", reason: "policy" } });
    expect(await tools.execute(send({ recipients: [recipient, 7] }))).toMatchObject({
      isError: true,
      result: { status: "refused" },
    });

    expect(sendMessage).not.toHaveBeenCalled();
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
      for (const named of request.recipients) {
        if (request.refusalBudget?.admit(String(named.threadId), request.reason) !== false) {
          journaled += 1;
        }
      }
    });

    // The same refused call, over and over, is one refusal.
    for (let attempt = 0; attempt < 30; attempt += 1) await tools.execute(send());
    expect(journaled).toBe(1);

    // Calls naming a new thread each are one more, until the cap.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const threadId = `c0000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`;
      await tools.execute(send({ recipients: [`${threadId}@${String(projectId)}`] }));
    }
    expect(journaled).toBe(MAX_JOURNALED_REFUSALS_PER_TURN);
  });

  it("answers a refused send the same when the refusal cannot be journaled or names nobody", async () => {
    const { tools, recordRefusedSend } = fixture({ posture: "plan" });
    recordRefusedSend.mockRejectedValueOnce(new Error("journal unavailable"));

    expect(await tools.execute(send())).toMatchObject({
      isError: true,
      result: { status: "refused", reason: "policy" },
    });
    expect(
      await tools.execute({ name: SIBLING_THREADS_TOOL_NAME, inputJson: "not json" }),
    ).toMatchObject({ isError: true, result: { status: "refused" } });
    expect(recordRefusedSend).toHaveBeenCalledTimes(1);
  });

  it("offers messaging only to a profile that names it, and never hands it to one that named only the reads", async () => {
    const readsOnly = fixture({ toolConstraints: [SIBLING_THREADS_TOOL_NAME] });

    expect(readsOnly.operations()).toEqual(["help", "list", "read", "wait"]);
    expect(await readsOnly.tools.execute(send())).toMatchObject({
      isError: true,
      result: {
        status: "refused",
        reason: "policy",
        message: expect.stringContaining("Reviewer"),
      },
    });
    expect(readsOnly.sendMessage).not.toHaveBeenCalled();

    const excluded = fixture({ toolConstraints: ["octant_terminal"] });
    expect(excluded.tools.definitions).toEqual([]);

    const named = fixture({ toolConstraints: ["octant_terminal", "octant_threads.send"] });
    expect(named.operations()).toEqual(["help", "send", "acknowledge", "receipts"]);
    expect((await named.tools.execute(send())).isError).toBeUndefined();
  });
});
