import type { PickerGroup } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { pendingThreadHandoffNotice, threadHandoffDisclosure } from "./conversationHandoff";

const native = "10000000-0000-4000-8000-000000000001";
const hosted = "10000000-0000-4000-8000-000000000002";
const group = (id: string, driverKind: string, displayName: string) =>
  ({ instance: { id, driverKind, displayName }, sections: [] }) as never as PickerGroup;
const groups = [group(native, "claude", "Claude"), group(hosted, "openai-compatible", "Gateway")];
const model = (providerInstanceId: string) => ({ providerInstanceId, modelId: "m" });

describe("pendingThreadHandoffNotice", () => {
  it("tells the person a new session starts when a provider that keeps its own takes over", () => {
    expect(
      pendingThreadHandoffNotice({
        groups,
        selected: model(native),
        latest: model(hosted),
      }),
    ).toBe(
      "Your next message starts a new session on Claude — m. Recent messages go as text; hidden reasoning and the Gateway — m session do not carry over.",
    );
  });

  it("says nothing when the thread stays on its provider or the new one holds no session", () => {
    expect(
      pendingThreadHandoffNotice({ groups, selected: model(native), latest: model(native) }),
    ).toBeUndefined();
    expect(
      pendingThreadHandoffNotice({ groups, selected: model(hosted), latest: model(native) }),
    ).toBeUndefined();
    expect(
      pendingThreadHandoffNotice({ groups, selected: model(native), latest: undefined }),
    ).toBeUndefined();
  });

  it("says a branch that has not run yet starts its session from the original's messages", () => {
    expect(
      pendingThreadHandoffNotice({
        groups,
        selected: model(native),
        latest: model(native),
        branchWithoutSession: true,
      }),
    ).toContain("The branched conversation goes as text");
    expect(
      pendingThreadHandoffNotice({
        groups,
        selected: model(hosted),
        latest: model(hosted),
        branchWithoutSession: true,
      }),
    ).toBeUndefined();
  });
});

describe("threadHandoffDisclosure", () => {
  const omissions = {
    earlierMessages: 0,
    unfinishedReplies: 0,
    missingBodies: 1,
    oversizedBodies: 1,
    emptyBodies: 0,
    attachments: 2,
    truncatedMessages: 1,
    truncatedCharacters: 40,
    sourceTruncatedMessages: 0,
  };
  const label = (selection: { readonly providerInstanceId: string }) =>
    selection.providerInstanceId === native ? "Claude" : "Gateway";

  it("names every omission the host counted for a branch as for a switch", () => {
    const text = threadHandoffDisclosure(
      {
        reason: "branch",
        messages: 1,
        omissions,
        externalContentIngested: false,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
      label,
    );

    expect(text).toContain("Branched with 1 recent message of the original conversation");
    expect(text).toContain(
      "Left out: 1 message no longer stored, 1 message too large to read, 2 attachments.",
    );
    expect(text).toContain("1 message was shortened by 40 characters.");
  });

  it("reads a provider switch the way Code reads it", () => {
    expect(
      threadHandoffDisclosure(
        {
          reason: "provider-switch",
          previousProviderInstanceId: native as never,
          previousModelId: "m" as never,
          messages: 2,
          omissions: {
            ...omissions,
            missingBodies: 0,
            oversizedBodies: 0,
            attachments: 0,
            truncatedMessages: 0,
            truncatedCharacters: 0,
          },
          externalContentIngested: false,
          nativeSessionTransferred: false,
          hiddenReasoningTransferred: false,
        },
        label,
      ),
    ).toBe(
      "Handed over 2 recent messages from Claude as text. Hidden reasoning, tool activity and the previous session did not transfer.",
    );
  });
});
