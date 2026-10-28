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

describe("Stream keep-alive", () => {
  const active = { kind: "active", sessionId: "session-1" } as const;
  const streamed = (event: unknown, session_id = "session-1") => ({
    type: "stream_event",
    uuid: "u-ping",
    session_id,
    parent_tool_use_id: null,
    event,
  });
  const refusal = (message: unknown): string | undefined => {
    try {
      decodeMessage(message, openInput, active);
      return undefined;
    } catch (error) {
      return (error as { readonly failure?: { readonly message?: string } }).failure?.message;
    }
  };

  it("reads the API's keep-alive ping as a stream event that carries nothing", () => {
    expect(decodeMessage(streamed({ type: "ping" }), openInput, active)).toEqual({
      kind: "stream-event",
      sessionId: "session-1",
      event: { kind: "ping" },
    });
  });

  it("still refuses a stream event it does not know, and a ping for another session", () => {
    expect(refusal(streamed({ type: "heartbeat" }))).toBe(
      "Claude returned an unsupported runtime message.",
    );
    expect(refusal(streamed({ type: "ping" }, "session-2"))).toBe(
      "Claude returned an unsupported runtime message.",
    );
  });
});

describe("Disabled Plan file tools", () => {
  const active = { kind: "active", sessionId: "session-1" } as const;
  const stream = (name: string, input: unknown = {}) => ({
    type: "stream_event",
    session_id: "session-1",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "disabled-1",
        name,
        input,
        caller: { type: "direct" },
      },
    },
  });

  it.each(["Write", "Edit"])("recognizes a disabled %s attempt without offering it", (name) => {
    const input = { ...openInput, executionPolicy: "plan" as const };
    expect(decodeMessage(stream(name), input, active)).toMatchObject({
      kind: "stream-event",
      event: { content: { kind: "tool-use", toolName: name, disabled: true } },
    });
    expect(input.tools).toEqual(["Read"]);
    expect(() => decodeMessage(stream(name), openInput, active)).toThrow();
    expect(() => decodeMessage(stream(name, []), input, active)).toThrow();
  });

  it("still rejects unknown and unoffered runtime tools in Plan", () => {
    for (const name of ["FutureTool", "mcp__unknown__write", "Bash", "WebFetch"]) {
      expect(() =>
        decodeMessage(stream(name), { ...openInput, executionPolicy: "plan" }, active),
      ).toThrow();
    }
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
      trigger: "auto",
      preTokens: 167_412,
      postTokens: 18_204,
    });
  });

  it("carries how a compaction ended on the status that reports it", () => {
    // Shaped as `SDKStatusMessage` in @anthropic-ai/claude-agent-sdk 0.3.211.
    for (const compact_result of ["success", "failed"] as const) {
      expect(
        decodeMessage(
          {
            type: "system",
            subtype: "status",
            status: null,
            compact_result,
            uuid: "u-status",
            session_id: "session-1",
          },
          openInput,
          active,
        ),
      ).toEqual({
        kind: "status",
        sessionId: "session-1",
        status: null,
        compactResult: compact_result,
      });
    }
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
    ).toEqual({ kind: "compaction", sessionId: "session-1", trigger: "manual", preTokens: 90_000 });
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

describe("Interruption", () => {
  const active = { kind: "active", sessionId: "session-1" } as const;
  // What Claude Code 2.1.296 sends once a turn is interrupted, just before the
  // result that ends it: the first text while output was streaming, the second
  // while a tool was waiting.
  const marker = (text: string) => ({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "session-1",
    uuid: "u-marker",
    timestamp: "2026-10-12T10:52:30.164Z",
  });

  it.each(["[Request interrupted by user]", "[Request interrupted by user for tool use]"])(
    "drops the runtime's note %s, so the result can end the turn as interrupted",
    (text) => {
      expect(decodeMessage(marker(text), openInput, active)).toEqual({ kind: "ignored" });
    },
  );

  it("refuses any other text the runtime sends as a user message's blocks", () => {
    expect(() => decodeMessage(marker("Run the deploy."), openInput, active)).toThrow();
    expect(() =>
      decodeMessage(
        {
          ...marker("[Request interrupted by user]"),
          message: {
            role: "user",
            content: [
              { type: "text", text: "[Request interrupted by user]" },
              { type: "text", text: "Run the deploy." },
            ],
          },
        },
        openInput,
        active,
      ),
    ).toThrow();
  });
});

describe("A published Claude artifact", () => {
  const active = { kind: "active", sessionId: "session-1" } as const;
  const settled = (toolUseResult: unknown, isError = false) => ({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu-1", is_error: isError, content: "ok" }],
    },
    parent_tool_use_id: null,
    session_id: "session-1",
    tool_use_result: toolUseResult,
  });

  it("carries the claude.ai address and title the publish returned", () => {
    expect(
      decodeMessage(
        settled({
          url: "https://claude.ai/artifact/abc123",
          path: "/repo/report.html",
          title: "  Quarterly\nreport ",
        }),
        openInput,
        active,
      ),
    ).toEqual({
      kind: "tool-results",
      sessionId: "session-1",
      results: [
        {
          toolUseId: "toolu-1",
          isError: false,
          publishedPage: { url: "https://claude.ai/artifact/abc123", title: "Quarterly report" },
        },
      ],
    });
  });

  it("names no page for another host, plain http, a failed call, or no address", () => {
    for (const message of [
      settled({ url: "https://claude.ai.example.com/artifact/abc" }),
      settled({ url: "http://claude.ai/artifact/abc" }),
      settled({ url: "https://user:secret@claude.ai/artifact/abc" }),
      settled({ url: "https://claude.ai/artifact/abc" }, true),
      settled({ artifacts: [] }),
    ]) {
      const decoded = decodeMessage(message, openInput, active);
      expect(decoded).toMatchObject({ results: [{ toolUseId: "toolu-1" }] });
      expect(JSON.stringify(decoded)).not.toContain("publishedPage");
    }
  });
});
