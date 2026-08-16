import { describe, expect, it } from "vitest";
import {
  decodeNavigatorAssistantCommand,
  decodeNavigatorAssistantCommandResult,
  decodeNavigatorAssistantFailure,
  decodeNavigatorAssistantSettings,
  decodeNavigatorAssistantSnapshot,
} from "./navigatorAssistant";

const modelRef = {
  providerInstanceId: "00000000-0000-4000-8000-00000000b001",
  modelId: "vision-model",
} as const;

const TIMESTAMP = "2026-08-15T09:00:00.000Z";

describe("NavigatorAssistantSettings", () => {
  it("decodes the empty section with both roles absent", () => {
    const settings = decodeNavigatorAssistantSettings({});
    expect(settings.defaultProvider).toBeUndefined();
    expect(settings.visionReviewer).toBeUndefined();
  });

  it("decodes configured roles and rejects partial or excess shapes", () => {
    expect(
      decodeNavigatorAssistantSettings({ defaultProvider: modelRef, visionReviewer: modelRef }),
    ).toEqual({ defaultProvider: modelRef, visionReviewer: modelRef });
    expect(() =>
      decodeNavigatorAssistantSettings({ defaultProvider: { modelId: "vision-model" } }),
    ).toThrow();
    expect(() => decodeNavigatorAssistantSettings({ fallbackProvider: modelRef })).toThrow();
  });
});

describe("NavigatorAssistantSnapshot", () => {
  it("decodes an honest unconfigured snapshot with its settings target", () => {
    const snapshot = decodeNavigatorAssistantSnapshot({
      status: "unconfigured",
      settingsTarget: { section: "navigator-assistant", setting: "default-model" },
      threadId: null,
      transcript: [],
      defaultProvider: null,
      imageInput: "unknown",
      visionReviewer: null,
    });
    expect(snapshot.status).toBe("unconfigured");
    expect(snapshot.settingsTarget.section).toBe("navigator-assistant");
    // An unconfigured Navigator has no conversation, which is a different
    // fact from a configured one whose conversation is still empty.
    expect(snapshot.transcript).toEqual([]);
  });

  it("decodes the bound conversation every Navigator surface reads", () => {
    const snapshot = decodeNavigatorAssistantSnapshot({
      status: "ready",
      settingsTarget: { section: "navigator-assistant", setting: "default-model" },
      threadId: "00000000-0000-4000-8000-00000000b002",
      transcript: [
        { role: "user", text: "Where do I set the default model?", createdAt: TIMESTAMP },
        { role: "assistant", text: "Settings › Navigator.", createdAt: TIMESTAMP },
      ],
      defaultProvider: modelRef,
      imageInput: "supported",
      visionReviewer: null,
    });
    expect(snapshot.transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("rejects a snapshot claiming readiness states outside the contract", () => {
    expect(() =>
      decodeNavigatorAssistantSnapshot({
        status: "maybe",
        settingsTarget: { section: "navigator-assistant" },
        threadId: null,
        transcript: [],
        defaultProvider: null,
        imageInput: "unknown",
        visionReviewer: null,
      }),
    ).toThrow();
    expect(() =>
      decodeNavigatorAssistantSnapshot({
        status: "ready",
        settingsTarget: { section: "navigator-assistant" },
        threadId: null,
        transcript: [],
        defaultProvider: modelRef,
        imageInput: "assumed-supported",
        visionReviewer: null,
      }),
    ).toThrow();
  });
});

describe("NavigatorAssistantCommand", () => {
  it("decodes a bounded send-message command and rejects everything else", () => {
    expect(decodeNavigatorAssistantCommand({ kind: "send-message", prompt: "hello" })).toEqual({
      kind: "send-message",
      prompt: "hello",
    });
    expect(() => decodeNavigatorAssistantCommand({ kind: "send-message", prompt: "  " })).toThrow();
    expect(() =>
      decodeNavigatorAssistantCommand({
        kind: "send-message",
        prompt: "x".repeat(100_001),
      }),
    ).toThrow();
    expect(() =>
      decodeNavigatorAssistantCommand({ kind: "mutate-settings", prompt: "hello" }),
    ).toThrow();
  });
});

describe("NavigatorAssistantCommandResult and failures", () => {
  it("decodes a message-sent result carrying the refreshed snapshot", () => {
    const result = decodeNavigatorAssistantCommandResult({
      kind: "message-sent",
      snapshot: {
        status: "ready",
        settingsTarget: { section: "navigator-assistant" },
        threadId: "00000000-0000-4000-8000-00000000b002",
        transcript: [],
        defaultProvider: modelRef,
        imageInput: "supported",
        visionReviewer: null,
      },
    });
    expect(result.snapshot.status).toBe("ready");
  });

  it("decodes an unconfigured failure with the settings deep link", () => {
    const failure = decodeNavigatorAssistantFailure({
      category: "unconfigured",
      message: "Navigator has no default model. Choose one in Settings.",
      settingsTarget: { section: "navigator-assistant", setting: "default-model" },
    });
    expect(failure.category).toBe("unconfigured");
    expect(failure.settingsTarget?.setting).toBe("default-model");
    expect(() =>
      decodeNavigatorAssistantFailure({ category: "mystery", message: "nope" }),
    ).toThrow();
  });
});
