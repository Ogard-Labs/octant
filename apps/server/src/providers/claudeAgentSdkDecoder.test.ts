import { describe, expect, it } from "vitest";
import type { ClaudeOpenQueryInput } from "./claudeAgentSdkPort";
import {
  decodeMessage,
  failure,
  isSanitizedFailure,
  sanitizeFailure,
} from "./claudeAgentSdkDecoder";

const openInput: ClaudeOpenQueryInput = {
  binaryPath: "/opt/homebrew/bin/claude",
  projectRoot: "/repo",
  authEnvironment: { PATH: "/usr/bin" },
  model: "claude-sonnet",
  executionPolicy: "approval-gated",
  tools: ["Read"],
  canUseTool: async () => ({ behavior: "deny" as const, message: "Approval required." }),
  preToolUse: async () => ({ behavior: "allow" as const }),
};

describe("Claude failure sanitizer", () => {
  it("names a known cause in fixed words and never quotes the raw error", () => {
    const missing = sanitizeFailure(
      new Error("spawn /Users/someone/.local/bin/claude ENOENT"),
      "message stream",
    );
    expect(missing).toEqual({
      category: "provider-failed",
      message: "Claude message stream failed: the Claude runtime binary was not found.",
    });
    expect(
      sanitizeFailure(new Error("Claude Code process exited with code 1"), "initialization"),
    ).toEqual({
      category: "provider-failed",
      message: "Claude initialization failed: the Claude runtime exited with code 1.",
    });
    const unknown = sanitizeFailure(new Error("private initialization failure"), "initialization");
    expect(unknown.message).toBe("Claude initialization failed.");
    expect(JSON.stringify(unknown)).not.toContain("private");
  });

  it("marks only the failures it minted, so a raw stream payload is not forwarded", () => {
    expect(isSanitizedFailure(failure("provider-failed", "Claude request failed."))).toBe(true);
    expect(
      isSanitizedFailure({ category: "provider-failed", message: "private raw payload" }),
    ).toBe(false);
  });

  it("accepts a tool call that names its caller, which every current runtime does", () => {
    const decoded = decodeMessage(
      {
        type: "stream_event",
        uuid: "u-1",
        session_id: "session-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: {},
            caller: { type: "direct" },
          },
        },
      },
      openInput,
      { kind: "active", sessionId: "session-1" },
    );
    expect(decoded).toEqual({
      kind: "stream-event",
      sessionId: "session-1",
      event: {
        kind: "content-start",
        index: 1,
        content: { kind: "tool-use", toolUseId: "toolu_1", toolName: "Read", input: {} },
      },
    });
  });
});
