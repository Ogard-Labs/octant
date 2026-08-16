import type { ProviderFailure, ProviderToolAnswer } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  encodeChatCompletionsToolResults,
  encodeResponsesToolResults,
  type EncodedChatCompletionsMessage,
  type EncodedResponsesInputItem,
} from "./openAiToolEncoding";

function answer(toolCallId: string, resultJson: string, isError = false): ProviderToolAnswer {
  return {
    sessionId: "019f64cf-7241-7000-8000-000000000001" as never,
    requestId: toolCallId,
    resultJson,
    isError,
  };
}

function failureOf(throwable: () => unknown): ProviderFailure {
  try {
    throwable();
  } catch (error) {
    expect(error).toBeDefined();
    return error as ProviderFailure;
  }
  throw new Error("Expected encoding to fail closed.");
}

describe("encodeResponsesToolResults", () => {
  it("encodes a single tool answer as a function_call_output input item", () => {
    const items = encodeResponsesToolResults([answer("call_abc", '{"ok":true}')]);
    expect(items).toEqual<EncodedResponsesInputItem[]>([
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: '{"ok":true}',
      },
    ]);
  });

  it("encodes multiple tool answers preserving order", () => {
    const items = encodeResponsesToolResults([
      answer("call_one", '{"a":1}'),
      answer("call_two", '{"b":2}'),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.call_id).toBe("call_one");
    expect(items[1]!.call_id).toBe("call_two");
  });

  it("encodes an empty answer list as an empty array", () => {
    expect(encodeResponsesToolResults([])).toEqual([]);
  });

  it("rejects a malformed tool call id", () => {
    const failure = failureOf(() => encodeResponsesToolResults([answer("", "{}")]));
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects tool output that is not valid JSON", () => {
    const failure = failureOf(() => encodeResponsesToolResults([answer("call_abc", "{not json}")]));
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects oversized tool output", () => {
    const failure = failureOf(() =>
      encodeResponsesToolResults([answer("call_abc", JSON.stringify({ big: "x".repeat(70_000) }))]),
    );
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects duplicate tool call ids", () => {
    const failure = failureOf(() =>
      encodeResponsesToolResults([answer("call_dup", "{}"), answer("call_dup", "{}")]),
    );
    expect(failure.category).toBe("invalid-configuration");
  });
});

describe("encodeChatCompletionsToolResults", () => {
  it("encodes a single tool answer as a tool role message", () => {
    const messages = encodeChatCompletionsToolResults([answer("call_abc", '{"ok":true}')]);
    expect(messages).toEqual<EncodedChatCompletionsMessage[]>([
      {
        role: "tool",
        tool_call_id: "call_abc",
        content: '{"ok":true}',
      },
    ]);
  });

  it("encodes multiple tool answers preserving order", () => {
    const messages = encodeChatCompletionsToolResults([
      answer("call_one", '{"a":1}'),
      answer("call_two", '{"b":2}'),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.tool_call_id).toBe("call_one");
    expect(messages[1]!.tool_call_id).toBe("call_two");
  });

  it("encodes an empty answer list as an empty array", () => {
    expect(encodeChatCompletionsToolResults([])).toEqual([]);
  });

  it("rejects a malformed tool call id", () => {
    const failure = failureOf(() => encodeChatCompletionsToolResults([answer("", "{}")]));
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects tool output that is not valid JSON", () => {
    const failure = failureOf(() =>
      encodeChatCompletionsToolResults([answer("call_abc", "{not json}")]),
    );
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects oversized tool output", () => {
    const failure = failureOf(() =>
      encodeChatCompletionsToolResults([
        answer("call_abc", JSON.stringify({ big: "x".repeat(70_000) })),
      ]),
    );
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects duplicate tool call ids", () => {
    const failure = failureOf(() =>
      encodeChatCompletionsToolResults([answer("call_dup", "{}"), answer("call_dup", "{}")]),
    );
    expect(failure.category).toBe("invalid-configuration");
  });
});
