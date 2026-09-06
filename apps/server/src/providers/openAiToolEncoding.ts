import type {
  ProviderFailure,
  ProviderToolAnswer,
  ProviderToolDefinition,
} from "@octant/contracts";
import { MAX_PROVIDER_TOOL_RESULT_BYTES, MAX_PROVIDER_TOOLS } from "@octant/contracts";

/**
 * OpenAI function name grammar: ^[a-zA-Z0-9_-]{1,64}$
 * The contracts bound tool names to 128 characters; OpenAI-compatible endpoints enforce 64.
 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
// One bound for every tool set that reaches a provider; the harness alone offers thirteen.
const MAX_ENCODED_TOOLS = MAX_PROVIDER_TOOLS;
const MAX_TOOL_CALL_ID_LENGTH = 128;
const MAX_TOOL_OUTPUT_BYTES = MAX_PROVIDER_TOOL_RESULT_BYTES;
const MAX_TOOL_OUTPUT_DEPTH = 16;
const MAX_TOOL_OUTPUT_ENTRIES = 256;
const MAX_TOOL_OUTPUT_KEY_LENGTH = 128;
// A read or a command's output is one string; the whole-result byte bound is
// the real ceiling, and a per-string bound below it only refused honest reads.
const MAX_TOOL_OUTPUT_STRING_LENGTH = MAX_PROVIDER_TOOL_RESULT_BYTES;

export const OCTANT_CAPABILITY_ECHO_TOOL_NAME = "octant_capability_echo";

export interface EncodedResponsesTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface EncodedChatCompletionsTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface EncodedResponsesInputItem {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

export interface EncodedChatCompletionsMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

export function normalizeToolName(name: string): string {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw invalidConfiguration("The provider tool name is malformed.");
  }
  return name;
}

export function encodeResponsesTools(
  tools: readonly ProviderToolDefinition[],
): EncodedResponsesTool[] {
  assertBoundedToolSet(tools);
  return tools.map((tool) => ({
    type: "function",
    name: normalizeToolName(String(tool.name)),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: tool.inputSchema,
  }));
}

export function encodeChatCompletionsTools(
  tools: readonly ProviderToolDefinition[],
): EncodedChatCompletionsTool[] {
  assertBoundedToolSet(tools);
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: normalizeToolName(String(tool.name)),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
    },
  }));
}

export function isCapabilityEchoToolCall(toolName: string): boolean {
  return toolName === OCTANT_CAPABILITY_ECHO_TOOL_NAME;
}

export function capabilityEchoToolDefinition(): ProviderToolDefinition {
  return {
    name: OCTANT_CAPABILITY_ECHO_TOOL_NAME as ProviderToolDefinition["name"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["echo"],
      properties: {
        echo: { type: "string", description: "Echo payload to return verbatim." },
      },
    },
  };
}

export function encodeResponsesToolResults(
  answers: readonly ProviderToolAnswer[],
): EncodedResponsesInputItem[] {
  assertBoundedToolAnswers(answers);
  return answers.map((answer) => ({
    type: "function_call_output",
    call_id: normalizeToolCallId(answer.requestId),
    output: assertBoundedToolOutput(answer.resultJson),
  }));
}

export function encodeChatCompletionsToolResults(
  answers: readonly ProviderToolAnswer[],
): EncodedChatCompletionsMessage[] {
  assertBoundedToolAnswers(answers);
  return answers.map((answer) => ({
    role: "tool",
    tool_call_id: normalizeToolCallId(answer.requestId),
    content: assertBoundedToolOutput(answer.resultJson),
  }));
}

function assertBoundedToolAnswers(answers: readonly ProviderToolAnswer[]): void {
  const seen = new Set<string>();
  for (const answer of answers) {
    const callId = normalizeToolCallId(answer.requestId);
    if (seen.has(callId)) {
      throw invalidConfiguration("The provider tool answers contained a duplicate tool call id.");
    }
    seen.add(callId);
  }
}

function normalizeToolCallId(toolCallId: string): string {
  if (
    typeof toolCallId !== "string" ||
    toolCallId.length === 0 ||
    toolCallId.length > MAX_TOOL_CALL_ID_LENGTH
  ) {
    throw invalidConfiguration("The provider tool call id was malformed.");
  }
  return toolCallId;
}

function assertBoundedToolOutput(outputJson: string): string {
  if (outputJson.length === 0) {
    throw invalidConfiguration("The provider tool output was empty.");
  }
  if (outputJson.length > MAX_TOOL_OUTPUT_BYTES) {
    throw invalidConfiguration("The provider tool output exceeded the size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputJson);
  } catch {
    throw invalidConfiguration("The provider tool output was not valid JSON.");
  }
  if (!isBoundedToolOutput(parsed)) {
    throw invalidConfiguration("The provider tool output exceeded the bounded JSON limits.");
  }
  return outputJson;
}

function isBoundedToolOutput(value: unknown, depth = 0, active: Set<object> = new Set()): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return Array.from(value).length <= MAX_TOOL_OUTPUT_STRING_LENGTH;
  }
  if (typeof value !== "object" || depth > MAX_TOOL_OUTPUT_DEPTH || active.has(value as object)) {
    return false;
  }
  active.add(value as object);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= MAX_TOOL_OUTPUT_ENTRIES &&
        value.every((entry) => isBoundedToolOutput(entry, depth + 1, active))
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_TOOL_OUTPUT_ENTRIES ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          key.trim().length === 0 ||
          Array.from(key).length > MAX_TOOL_OUTPUT_KEY_LENGTH,
      )
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        isBoundedToolOutput(descriptor.value, depth + 1, active)
      );
    });
  } finally {
    active.delete(value as object);
  }
}

function assertBoundedToolSet(tools: readonly ProviderToolDefinition[]): void {
  if (tools.length > MAX_ENCODED_TOOLS) {
    throw invalidConfiguration("The provider request exceeded the tool count limit.");
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(String(tool.name));
    if (seen.has(name)) {
      throw invalidConfiguration("The provider request contained a duplicate tool name.");
    }
    seen.add(name);
  }
}

function invalidConfiguration(message: string): ProviderFailure {
  return { category: "invalid-configuration", message };
}
