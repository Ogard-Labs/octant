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

describe("Managed tool progress", () => {
  it("accepts a parent-correlated heartbeat only for an offered app-owned tool", () => {
    const toolName = "mcp__octant__octant_browser";
    const message = {
      type: "tool_progress",
      session_id: "session-1",
      tool_use_id: "heartbeat-1",
      tool_name: toolName,
      parent_tool_use_id: "tool-1",
      elapsed_time_seconds: 30,
      heartbeat: true,
    };
    expect(
      decodeMessage(
        message,
        { ...openInput, tools: [...openInput.tools, toolName], managedToolServer: true },
        { kind: "active", sessionId: "session-1" },
      ),
    ).toMatchObject({
      kind: "tool-progress",
      toolName,
      elapsedSeconds: 30,
      parentToolUseId: "tool-1",
    });
    expect(() =>
      decodeMessage(message, openInput, { kind: "active", sessionId: "session-1" }),
    ).toThrow();
  });
});

describe("Runtime compaction", () => {
  const active = { kind: "active", sessionId: "session-1" } as const;
  const refusal = (message: unknown): string | undefined => {
    try {
      decodeMessage(message, openInput, active);
      return undefined;
    } catch (error) {
      return (error as { readonly failure?: { readonly message?: string } }).failure?.message;
    }
  };
  // Shaped as `SDKCompactBoundaryMessage` in @anthropic-ai/claude-agent-sdk 0.3.211.
  const boundary = {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 167_412,
      post_tokens: 18_204,
      duration_ms: 41_200,
      preserved_segment: { head_uuid: "u-head", anchor_uuid: "u-anchor", tail_uuid: "u-tail" },
      preserved_messages: { anchor_uuid: "u-anchor", uuids: ["u-head", "u-tail"] },
    },
    uuid: "u-boundary",
    session_id: "session-1",
  };

  it("reads Claude compacting its own session mid-turn as a notice, not an unsupported message", () => {
    expect(decodeMessage(boundary, openInput, active)).toEqual({
      kind: "compaction",
      sessionId: "session-1",
      postTokens: 18_204,
    });
  });

  it("accepts the fields the runtime adds beyond its published type", () => {
    // Claude Code 0.3.211's runtime also sends `logical_parent_uuid` and
    // summary bookkeeping that the published type leaves out.
    expect(
      decodeMessage(
        {
          ...boundary,
          logical_parent_uuid: "u-parent",
          compact_metadata: {
            trigger: "manual",
            pre_tokens: 90_000,
            user_context: "",
            messages_summarized: 40,
          },
        },
        openInput,
        active,
      ),
    ).toEqual({ kind: "compaction", sessionId: "session-1" });
  });

  it.each([
    ["an unknown trigger", { ...boundary.compact_metadata, trigger: "scheduled" }],
    ["no token count", { trigger: "auto" }],
    ["a negative token count", { trigger: "auto", pre_tokens: -1 }],
  ])("refuses a compaction notice with %s", (_, compact_metadata) => {
    expect(refusal({ ...boundary, compact_metadata })).toBe(
      "Claude returned an unsupported runtime message.",
    );
  });

  it("refuses a compaction notice for another session", () => {
    expect(refusal({ ...boundary, session_id: "session-2" })).toBe(
      "Claude returned an unsupported runtime message.",
    );
  });

  it("refuses a system message it does not know without quoting its subtype", () => {
    expect(
      refusal({
        type: "system",
        subtype: "conversation_reset",
        uuid: "u-1",
        session_id: "session-1",
      }),
    ).toBe("Claude returned an unsupported system message.");
    expect(
      refusal({
        type: "system",
        subtype: "Not An Identifier!",
        uuid: "u-1",
        session_id: "session-1",
      }),
    ).toBe("Claude returned an unsupported system message.");
  });
});
