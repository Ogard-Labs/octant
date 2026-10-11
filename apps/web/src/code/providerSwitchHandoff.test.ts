import { describe, expect, it } from "vitest";
import type { CodeConversationTurnHandoff } from "@octant/contracts";
import { providerSwitchHandoffDisclosure } from "./providerSwitchHandoff";

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

function handoff(
  overrides: Partial<CodeConversationTurnHandoff> = {},
): CodeConversationTurnHandoff {
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
    const text = providerSwitchHandoffDisclosure(
      handoff({
        omissions: {
          ...none,
          truncatedMessages: 1,
          truncatedCharacters: 1_200,
          sourceTruncatedMessages: 2,
        },
      }),
      "Local — One",
    );
    expect(text).toContain("1 message was shortened by 1200 characters.");
    expect(text).toContain("2 messages were already cut short when recorded.");
  });

  it("describes outside content as the thread's, not as part of the excerpts", () => {
    const text = providerSwitchHandoffDisclosure(
      handoff({ externalContentIngested: true }),
      "Local — One",
    );
    expect(text).toContain("This thread has taken in outside content.");
    expect(text).not.toContain("Some of it came from outside content");
  });
});
