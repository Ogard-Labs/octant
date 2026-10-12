import { describe, expect, it } from "vitest";
import { MAX_AGENT_MESSAGE_BODY_BYTES } from "@octant/contracts";
import {
  AGENT_MESSAGE_UNREACHABLE,
  MAX_AGENT_MESSAGE_BYTES_PER_TURN,
  MAX_AGENT_MESSAGE_DEPTH,
  MAX_AGENT_MESSAGE_RECIPIENTS,
  MAX_OPEN_AGENT_MESSAGES_PER_SENDER,
  agentMessageDeliveryEffects,
  agentMessagesCarriedByTurn,
  decideAgentMessageDelivery,
  decideAgentMessageDeliveryAtRecheck,
  type AgentMessageSenderFacts,
} from "./agentMessagePolicy";

const sender: AgentMessageSenderFacts = {
  scope: { threadId: "thread-sender", projectId: "project-a" },
  openModes: new Set(["chat", "work", "code"]),
  messagingAdmitted: true,
  depth: 1,
  openInFlight: 0,
};

const recipient = {
  scope: { threadId: "thread-recipient", projectId: "project-a" },
  mode: "code" as const,
  terminal: false,
};

describe("agent message policy", () => {
  it("admits a bounded message to a recipient the principal can already open", () => {
    expect(
      decideAgentMessageDelivery({
        sender,
        recipient,
        bodyByteLength: 128,
        recipientCount: 1,
      }),
    ).toEqual({ status: "admitted" });
  });

  it("refuses a body past the bound instead of truncating it", () => {
    expect(
      decideAgentMessageDelivery({
        sender,
        recipient,
        bodyByteLength: MAX_AGENT_MESSAGE_BODY_BYTES + 1,
        recipientCount: 1,
      }).status,
    ).toBe("refused");
  });

  it("refuses a message that names more recipients than one petition may carry", () => {
    expect(
      decideAgentMessageDelivery({
        sender,
        recipient,
        bodyByteLength: 128,
        recipientCount: MAX_AGENT_MESSAGE_RECIPIENTS + 1,
      }),
    ).toEqual({
      status: "refused",
      reason: "policy",
      message: expect.any(String),
    });
  });

  it("refuses a message that travels past the bounded hierarchy depth", () => {
    expect(
      decideAgentMessageDelivery({
        sender: { ...sender, depth: MAX_AGENT_MESSAGE_DEPTH + 1 },
        recipient,
        bodyByteLength: 128,
        recipientCount: 1,
      }),
    ).toEqual({
      status: "refused",
      reason: "depth-exceeded",
      message: expect.any(String),
    });
  });

  it("caps the open in-flight messages one sender may hold", () => {
    expect(
      decideAgentMessageDelivery({
        sender: { ...sender, openInFlight: MAX_OPEN_AGENT_MESSAGES_PER_SENDER },
        recipient,
        bodyByteLength: 128,
        recipientCount: 1,
      }),
    ).toEqual({ status: "refused", reason: "policy", message: expect.any(String) });
  });

  it("refuses a recipient whose mode the admitting principal cannot open", () => {
    expect(
      decideAgentMessageDelivery({
        sender: { ...sender, openModes: new Set(["chat"]) },
        recipient,
        bodyByteLength: 128,
        recipientCount: 1,
      }),
    ).toEqual({
      status: "refused",
      reason: "unauthorized",
      message: expect.any(String),
    });
  });

  it("refuses every recipient outside the sender's Project in the same words", () => {
    const unreachable = {
      status: "refused",
      reason: "unauthorized",
      message: AGENT_MESSAGE_UNREACHABLE,
    };
    const decide = (
      candidate: Parameters<typeof decideAgentMessageDelivery>[0]["recipient"],
      from: AgentMessageSenderFacts = sender,
    ) =>
      decideAgentMessageDelivery({
        sender: from,
        recipient: candidate,
        bodyByteLength: 128,
        recipientCount: 1,
      });
    // A thread of another Project, even one that has settled or sits in a mode
    // the principal cannot open, reads exactly like an id the host never knew.
    expect(decide(undefined)).toEqual(unreachable);
    expect(
      decide({ ...recipient, scope: { threadId: "thread-other", projectId: "project-b" } }),
    ).toEqual(unreachable);
    expect(
      decide({
        scope: { threadId: "thread-other", projectId: "project-b" },
        mode: "work",
        terminal: true,
      }),
    ).toEqual(unreachable);
    expect(decide({ ...recipient, scope: sender.scope })).toEqual(unreachable);
    // Two threads that both sit outside any Project share nothing.
    expect(
      decide(
        { ...recipient, scope: { threadId: "thread-recipient", projectId: undefined } },
        { ...sender, scope: { threadId: "thread-sender", projectId: undefined } },
      ),
    ).toEqual(unreachable);
  });

  it("refuses when the sender's live grant does not admit messaging", () => {
    expect(
      decideAgentMessageDelivery({
        sender: { ...sender, messagingAdmitted: false },
        recipient,
        bodyByteLength: 128,
        recipientCount: 1,
      }),
    ).toEqual({ status: "refused", reason: "unauthorized", message: expect.any(String) });
  });

  it("refuses a recipient thread that has already settled", () => {
    expect(
      decideAgentMessageDelivery({
        sender,
        recipient: { ...recipient, terminal: true },
        bodyByteLength: 128,
        recipientCount: 1,
      }),
    ).toEqual({
      status: "refused",
      reason: "recipient-terminal",
      message: expect.any(String),
    });
  });

  it("still refuses at the delivery-time recheck after admission", () => {
    expect(
      decideAgentMessageDeliveryAtRecheck({
        senderMessagingAdmitted: false,
        senderScope: sender.scope,
        recipientScope: recipient.scope,
        recipientMode: "code",
        senderOpenModes: sender.openModes,
        recipientTerminal: false,
      }),
    ).toEqual({ status: "refused", reason: "unauthorized", message: expect.any(String) });
    expect(
      decideAgentMessageDeliveryAtRecheck({
        senderMessagingAdmitted: true,
        senderScope: sender.scope,
        recipientScope: recipient.scope,
        recipientMode: "code",
        senderOpenModes: sender.openModes,
        recipientTerminal: true,
      }),
    ).toEqual({ status: "refused", reason: "recipient-terminal", message: expect.any(String) });
    expect(
      decideAgentMessageDeliveryAtRecheck({
        senderMessagingAdmitted: true,
        senderScope: sender.scope,
        recipientScope: recipient.scope,
        recipientMode: "work",
        senderOpenModes: new Set(["chat"]),
        recipientTerminal: false,
      }),
    ).toEqual({ status: "refused", reason: "unauthorized", message: expect.any(String) });
  });

  it("refuses at the recheck once the two threads no longer share a Project", () => {
    expect(
      decideAgentMessageDeliveryAtRecheck({
        senderMessagingAdmitted: true,
        senderScope: sender.scope,
        recipientScope: { threadId: "thread-recipient", projectId: "project-b" },
        recipientMode: "code",
        senderOpenModes: sender.openModes,
        recipientTerminal: false,
      }),
    ).toEqual({ status: "refused", reason: "unauthorized", message: AGENT_MESSAGE_UNREACHABLE });
  });

  it("carries the oldest waiting messages a turn has room for and leaves the rest", () => {
    const half = { byteLength: MAX_AGENT_MESSAGE_BYTES_PER_TURN / 2 };
    const full = { byteLength: MAX_AGENT_MESSAGE_BYTES_PER_TURN };
    expect(agentMessagesCarriedByTurn([])).toEqual([]);
    expect(agentMessagesCarriedByTurn([half, half, half])).toHaveLength(2);
    // One body at the bound still goes, alone, instead of waiting forever.
    expect(agentMessagesCarriedByTurn([full, half])).toEqual([full]);
    expect(agentMessagesCarriedByTurn([half, full])).toEqual([half]);
  });

  it("delivers a message as data alone, granting the recipient nothing else", () => {
    // The effects type has exactly these fields. A sender cannot widen
    // recipient authority, clear taint, raise an execution policy, install an
    // extension, or approve on anyone's behalf, because messaging carries no
    // field that could.
    expect(agentMessageDeliveryEffects()).toEqual({
      externalContentIngested: true,
      bodyTreatedAsData: true,
    });
    expect(Object.keys(agentMessageDeliveryEffects())).toEqual([
      "externalContentIngested",
      "bodyTreatedAsData",
    ]);
  });
});
