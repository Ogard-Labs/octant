import { describe, expect, it } from "vitest";
import { draftThreadModePresentation, NewThreadDraft, ThreadCreationContext } from "./threadDraft";
import { Schema } from "effect";

describe("ThreadCreationContext", () => {
  it("decodes a minimal context with only mode", () => {
    const result = Schema.decodeUnknownSync(ThreadCreationContext)({ mode: "chat" });
    expect(result.mode).toBe("chat");
    expect(result.projectId).toBeUndefined();
  });

  it("decodes a full context with project and provider", () => {
    const result = Schema.decodeUnknownSync(ThreadCreationContext)({
      mode: "code",
      projectId: "20000000-0000-4000-8000-000000000001",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      modelId: "gpt-4o",
      executionPolicy: "approval-gated",
    });
    expect(result.mode).toBe("code");
    expect(result.projectId).toBe("20000000-0000-4000-8000-000000000001");
    expect(result.executionPolicy).toBe("approval-gated");
  });

  it("rejects excess properties", () => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadCreationContext)({
        mode: "chat",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("NewThreadDraft", () => {
  it("decodes a minimal draft with only mode", () => {
    const result = Schema.decodeUnknownSync(NewThreadDraft)({ mode: "work" });
    expect(result.mode).toBe("work");
    expect(result.promptText).toBeUndefined();
  });

  it("decodes a draft with prompt text", () => {
    const result = Schema.decodeUnknownSync(NewThreadDraft)({
      mode: "code",
      promptText: "Fix the login bug",
    });
    expect(result.promptText).toBe("Fix the login bug");
  });

  it("rejects prompt text exceeding the maximum length", () => {
    expect(() =>
      Schema.decodeUnknownSync(NewThreadDraft)({
        mode: "chat",
        promptText: "x".repeat(100_001),
      }),
    ).toThrow();
  });
});

describe("draftThreadModePresentation", () => {
  it("returns chat-specific welcome copy", () => {
    const presentation = draftThreadModePresentation("chat");
    expect(presentation.mode).toBe("chat");
    expect(presentation.eyebrow).toBe("Octant Chat");
    expect(presentation.heading).toBe("What are you working on?");
    expect(presentation.intentCards.length).toBeGreaterThanOrEqual(2);
    expect(presentation.composerPlaceholder).toBeTruthy();
  });

  it("returns work-specific welcome copy", () => {
    const presentation = draftThreadModePresentation("work");
    expect(presentation.mode).toBe("work");
    expect(presentation.eyebrow).toBe("Octant Work");
    expect(presentation.intentCards.length).toBeGreaterThanOrEqual(2);
  });

  it("returns code-specific welcome copy", () => {
    const presentation = draftThreadModePresentation("code");
    expect(presentation.mode).toBe("code");
    expect(presentation.eyebrow).toBe("Octant Code");
    expect(presentation.heading).toBe("What should we build?");
    expect(presentation.intentCards.length).toBeGreaterThanOrEqual(2);
  });

  it("provides unique intent card IDs per mode", () => {
    for (const mode of ["chat", "work", "code"] as const) {
      const presentation = draftThreadModePresentation(mode);
      const ids = presentation.intentCards.map((card) => card.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
