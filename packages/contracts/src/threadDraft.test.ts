import { describe, expect, it } from "vitest";
import { NewThreadDraft, ThreadCreationContext } from "./threadDraft";
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
