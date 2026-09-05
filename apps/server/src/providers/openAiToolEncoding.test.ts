import { MAX_PROVIDER_TOOLS } from "@octant/contracts";
import type { ProviderFailure, ProviderToolDefinition } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  encodeChatCompletionsTools,
  encodeResponsesTools,
  OCTANT_CAPABILITY_ECHO_TOOL_NAME,
  capabilityEchoToolDefinition,
  isCapabilityEchoToolCall,
  normalizeToolName,
  type EncodedResponsesTool,
  type EncodedChatCompletionsTool,
} from "./openAiToolEncoding";

function tool(
  name: string,
  inputSchema: Record<string, unknown> = {},
  description?: string,
): ProviderToolDefinition {
  return {
    name: name as ProviderToolDefinition["name"],
    inputSchema,
    ...(description === undefined ? {} : { description }),
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

describe("encodeResponsesTools", () => {
  it("encodes bounded tool definitions into Responses function tools with descriptions", () => {
    const tools = encodeResponsesTools([
      tool(
        "octant_read_file",
        { type: "object", properties: { path: { type: "string" } } },
        "Read a workspace file.",
      ),
    ]);
    expect(tools).toEqual<EncodedResponsesTool[]>([
      {
        type: "function",
        name: "octant_read_file",
        description: "Read a workspace file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("encodes an empty tool list as an empty array", () => {
    expect(encodeResponsesTools([])).toEqual([]);
  });

  it("rejects tool names that do not match the OpenAI function name grammar", () => {
    const failure = failureOf(() => encodeResponsesTools([tool("octant read file")]));
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects tool names longer than 64 characters", () => {
    const failure = failureOf(() => encodeResponsesTools([tool("a".repeat(65))]));
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects more tools than the provider contract bound", () => {
    const failure = failureOf(() =>
      encodeResponsesTools(
        Array.from({ length: MAX_PROVIDER_TOOLS + 1 }, (_, index) => tool(`t${index + 1}`)),
      ),
    );
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects duplicate tool names", () => {
    const failure = failureOf(() => encodeResponsesTools([tool("dup"), tool("dup")]));
    expect(failure.category).toBe("invalid-configuration");
  });
});

describe("encodeChatCompletionsTools", () => {
  it("encodes bounded tool definitions into Chat Completions function tools", () => {
    const tools = encodeChatCompletionsTools([
      tool("octant_read_file", { type: "object", properties: {} }, "Read a workspace file."),
    ]);
    expect(tools).toEqual<EncodedChatCompletionsTool[]>([
      {
        type: "function",
        function: {
          name: "octant_read_file",
          description: "Read a workspace file.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("encodes an empty tool list as an empty array", () => {
    expect(encodeChatCompletionsTools([])).toEqual([]);
  });

  it("rejects malformed tool names with the same grammar as Responses", () => {
    const failure = failureOf(() => encodeChatCompletionsTools([tool("bad/name")]));
    expect(failure.category).toBe("invalid-configuration");
  });

  it("rejects more tools than the provider contract bound", () => {
    const failure = failureOf(() =>
      encodeChatCompletionsTools(
        Array.from({ length: MAX_PROVIDER_TOOLS + 1 }, (_, index) => tool(`t${index + 1}`)),
      ),
    );
    expect(failure.category).toBe("invalid-configuration");
  });
});

describe("normalizeToolName", () => {
  it("accepts a valid OpenAI function name", () => {
    expect(normalizeToolName("octant_read_file_1")).toBe("octant_read_file_1");
  });

  it("rejects an empty name", () => {
    expect(() => normalizeToolName("")).toThrow();
  });

  it("rejects names with spaces", () => {
    expect(() => normalizeToolName("has space")).toThrow();
  });
});

describe("capabilityEchoToolDefinition", () => {
  it("exposes the octant_capability_echo tool with a bounded echo schema and zero authority", () => {
    const definition = capabilityEchoToolDefinition();
    expect(String(definition.name)).toBe(OCTANT_CAPABILITY_ECHO_TOOL_NAME);
    expect(definition.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["echo"],
      properties: {
        echo: { type: "string", description: "Echo payload to return verbatim." },
      },
    });
  });

  it("is recognized as the capability echo tool by name", () => {
    expect(isCapabilityEchoToolCall(OCTANT_CAPABILITY_ECHO_TOOL_NAME)).toBe(true);
    expect(isCapabilityEchoToolCall("octant_read_file")).toBe(false);
  });
});
