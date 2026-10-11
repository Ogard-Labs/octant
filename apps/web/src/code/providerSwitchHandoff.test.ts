import { describe, expect, it } from "vitest";
import type { CodeConversationTurnHandoff } from "@octant/contracts";
import { conversationHandoffDisclosure } from "./providerSwitchHandoff";

const none = {
  earlierMessages: 0,
  unfinishedReplies: 0,
  missingBodies: 0,
  oversizedBodies: 0,
  emptyBodies: 0,
  attachments: 0,
  truncatedMessages: 0,
  truncatedCharacters: 0,
  sourceTruncatedMessages: 0,
};

type SwitchHandoff = Extract<CodeConversationTurnHandoff, { readonly reason: "provider-switch" }>;

const label = () => "Local — One";

function handoff(overrides: Partial<SwitchHandoff> = {}): SwitchHandoff {
  return {
    reason: "provider-switch",
    previousProviderInstanceId: "80000000-0000-4000-8000-0000000000a1" as never,
    previousModelId: "model-one" as never,
    messages: 2,
    omissions: none,
    externalContentIngested: false,
    ...overrides,
  };
}

describe("provider switch handoff disclosure", () => {
  it("names how much was cut and which messages were already cut short when recorded", () => {
    const text = conversationHandoffDisclosure(
      handoff({
        omissions: {
          ...none,
          truncatedMessages: 1,
          truncatedCharacters: 1_200,
          sourceTruncatedMessages: 2,
        },
      }),
      label,
    );
    expect(text).toContain("1 message was shortened by 1200 characters.");
    expect(text).toContain("2 messages were already cut short when recorded.");
  });

  it("describes outside content as the thread's, not as part of the excerpts", () => {
    const text = conversationHandoffDisclosure(handoff({ externalContentIngested: true }), label);
    expect(text).toContain("This thread has taken in outside content.");
    expect(text).not.toContain("Some of it came from outside content");
  });
});

describe("fork handoff disclosure", () => {
  const forkedFrom = {
    threadId: "80000000-0000-4000-8000-0000000000b1" as never,
    throughOperationId: "80000000-0000-4000-8000-0000000000b2",
  };

  it("says a text fork carried excerpts up to the fork point and what stayed behind", () => {
    const text = conversationHandoffDisclosure(
      {
        reason: "fork",
        forkedFrom,
        messages: 3,
        omissions: { ...none, missingBodies: 1 },
        externalContentIngested: true,
      },
      label,
    );
    expect(text).toContain("Forked with 3 recent messages of the source conversation as text");
    expect(text).toContain("Left out: 1 message no longer stored.");
    expect(text).toContain("The source thread has taken in outside content.");
    expect(text).toContain("the source's session and its later replies did not transfer");
  });

  it("says a fork that continued the source's session kept its tool activity", () => {
    const text = conversationHandoffDisclosure(
      { reason: "fork-native-session", forkedFrom },
      label,
    );
    expect(text).toContain("continuing the source's own session");
    expect(text).toContain("tool activity");
    expect(text).toContain("later replies did not transfer");
  });
});
