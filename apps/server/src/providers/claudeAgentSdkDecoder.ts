import type {
  ProviderContextBreakdown,
  ProviderContextPart,
  ProviderDeferredContextPart,
  ProviderExecutionPolicy,
  ProviderFailure,
} from "@octant/contracts";
import { MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS } from "@octant/contracts";
import { advertisedSlashCommands } from "./providerSlashCommands";

import type {
  ClaudeAccountState,
  ClaudeAssistantContent,
  ClaudeDecodedMessage,
  ClaudeInitialization,
  ClaudeJsonValue,
  ClaudeModelInfo,
  ClaudeOpenQueryInput,
  ClaudePermissionMode,
  ClaudeResultSubtype,
  ClaudeSessionMetadata,
  ClaudeStreamEvent,
  ClaudeTaskUsage,
  ClaudeWorkflowAgent,
  ClaudeUsage,
} from "./claudeAgentSdkPort";
import { claudeTaskToolOutput } from "./claudeTaskList";

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const API_PROVIDERS = new Set([
  "firstParty",
  "bedrock",
  "vertex",
  "foundry",
  "anthropicAws",
  "mantle",
  "gateway",
]);

class ClaudePortError {
  constructor(readonly failure: ProviderFailure) {}
}

/**
 * Every failure this port emits is minted here, so a consumer can tell a
 * sentence the sanitizer wrote from a raw payload that arrived on a stream.
 * The driver forwards only the former; anything else is reduced to its own
 * generic sentence, which is the leak guard the driver tests pin.
 */
const sanitizedFailures = new WeakSet<ProviderFailure>();

export function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  const minted: ProviderFailure = { category, message };
  sanitizedFailures.add(minted);
  return minted;
}

export function isSanitizedFailure(candidate: ProviderFailure): boolean {
  return sanitizedFailures.has(candidate);
}

export function protocol(message = "Claude returned an invalid SDK response."): ClaudePortError {
  return new ClaudePortError(failure("protocol", message));
}

/**
 * A frame showing the runtime holds authority Octant did not give it: another
 * permission mode, or a call to a tool that was not offered. It ends the
 * session. Every other frame `decodeMessage` cannot read is dropped,
 * because a runtime release that adds a message, a field, or a value used to
 * end the turn each time (`ping`, `caller`, `thinking_tokens`, `dev_intent`
 * and `api_retry` were each an outage before they were listed here).
 */
class ClaudeSurfaceRefusal extends ClaudePortError {}

function surfaceRefused(message: string): ClaudeSurfaceRefusal {
  return new ClaudeSurfaceRefusal(failure("protocol", message));
}

/**
 * The reason a runtime error is allowed to carry into the person's view.
 *
 * Raw error text stays out of every failure (it can quote paths, prompts, or
 * tokens), so the cause is named only when it matches a known shape, and
 * then in fixed words. Observed before this: every stream failure reached
 * the transcript as "Claude message stream failed." whether the binary was
 * missing, the account was signed out, or the process had crashed.
 */
export function runtimeErrorReason(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (text === "") return undefined;
  const exitCode = /(?:exited with|exit) code (\d{1,3})\b/i.exec(text)?.[1];
  if (exitCode !== undefined) return `the Claude runtime exited with code ${exitCode}`;
  if (/\bENOENT\b|not found|no such file/i.test(text))
    return "the Claude runtime binary was not found";
  if (/\bEACCES\b|permission denied/i.test(text)) return "the Claude runtime could not be started";
  if (/\b401\b|unauthori[sz]ed|not logged in|please log in|authentication/i.test(text)) {
    return "Claude is not signed in on this computer";
  }
  if (/\b429\b|rate.?limit/i.test(text)) return "Claude is rate limited";
  if (/\bECONNREFUSED\b|\bETIMEDOUT\b|\bENOTFOUND\b|fetch failed|network/i.test(text)) {
    return "the connection to Claude failed";
  }
  return undefined;
}

export function sanitizeFailure(error: unknown, operation: string): ProviderFailure {
  if (error instanceof ClaudePortError) return error.failure;
  const reason = runtimeErrorReason(error);
  return failure(
    "provider-failed",
    reason === undefined ? `Claude ${operation} failed.` : `Claude ${operation} failed: ${reason}.`,
  );
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const decoded = nonNegativeNumber(value);
  return decoded !== undefined && Number.isInteger(decoded) ? decoded : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw protocol("Claude returned an unsupported runtime message.");
  return value;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const decoded = nonNegativeNumber(value);
  if (decoded === undefined) throw protocol("Claude returned an unsupported runtime message.");
  return decoded;
}

export function decodeInterruptReceipt(value: unknown): readonly string[] | undefined {
  const receipt = object(value);
  return receipt === undefined ? undefined : stringArray(receipt.still_queued);
}

// A count the runtime sends as null, or leaves out, is none.
function nullableTokenCount(value: unknown): number | undefined {
  if (value === null || value === undefined) return 0;
  return nonNegativeNumber(value);
}

/** The token counts a frame reports, or nothing when they cannot be read. */
function readUsage(
  value: unknown,
  nullableCache: boolean,
  nullableInput = false,
): ClaudeUsage | undefined {
  const usage = object(value);
  const inputTokens = nullableInput
    ? nullableTokenCount(usage?.input_tokens)
    : nonNegativeNumber(usage?.input_tokens);
  const outputTokens = nonNegativeNumber(usage?.output_tokens);
  const cacheCreationInputTokens = nullableCache
    ? nullableTokenCount(usage?.cache_creation_input_tokens)
    : nonNegativeNumber(usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = nullableCache
    ? nullableTokenCount(usage?.cache_read_input_tokens)
    : nonNegativeNumber(usage?.cache_read_input_tokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    cacheReadInputTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
}

function decodeUsage(value: unknown, nullableCache: boolean, nullableInput = false): ClaudeUsage {
  const usage = readUsage(value, nullableCache, nullableInput);
  if (usage === undefined) throw protocol("Claude returned an unsupported runtime message.");
  return usage;
}

function decodeJsonValue(value: unknown, depth = 0): ClaudeJsonValue {
  if (depth > 16) throw protocol("Claude returned an unsupported runtime message.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => decodeJsonValue(entry, depth + 1));
  const record = object(value);
  if (record === undefined) throw protocol("Claude returned an unsupported runtime message.");
  const decoded: Record<string, ClaudeJsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    decoded[key] = decodeJsonValue(entry, depth + 1);
  }
  return decoded;
}

/**
 * One block of an assistant message, or nothing for a block this build does
 * not read (a block type a newer runtime added, or one missing what Octant
 * shows of it). Fields beyond the ones read are the runtime's own.
 */
function decodeAssistantContent(
  value: unknown,
  input: Pick<ClaudeOpenQueryInput, "tools" | "executionPolicy" | "nativeSetup">,
): ClaudeAssistantContent | undefined {
  const block = object(value);
  if (block === undefined) return undefined;
  if (block.type === "text") {
    return typeof block.text === "string" ? { kind: "text", text: block.text } : undefined;
  }
  if (block.type === "thinking") {
    return typeof block.thinking === "string"
      ? { kind: "reasoning", text: block.thinking }
      : undefined;
  }
  if (block.type === "redacted_thinking") return { kind: "redacted-reasoning" };
  if (block.type !== "tool_use") return undefined;
  if (typeof block.id !== "string" || typeof block.name !== "string") return undefined;
  // Claude 2.1.301 can report a file-tool attempt before its disabled-tool
  // error in Plan. Recognize that report without granting execution authority.
  const disabled =
    input.executionPolicy === "plan" &&
    !input.tools.includes(block.name) &&
    (block.name === "Write" || block.name === "Edit");
  // A call to a tool Octant did not offer is the runtime acting beyond the
  // session it was opened with, which no later frame can undo.
  if (!claudeOffersTool(input, block.name) && !disabled) {
    throw surfaceRefused("Claude returned an unsupported runtime message.");
  }
  // Claude Code 2.1.26x stamps every tool call with `caller: { type }`; the
  // annotation changes nothing about the call, and refusing it failed every
  // tool-using turn while plain chat kept working.
  const decodedInputObject = object(decodeJsonValue(block.input));
  if (decodedInputObject === undefined) return undefined;
  return {
    kind: "tool-use",
    toolUseId: block.id,
    toolName: block.name,
    ...(disabled ? { disabled: true as const } : {}),
    input: decodedInputObject as { readonly [key: string]: ClaudeJsonValue },
  };
}

function decodeStreamEvent(
  value: unknown,
  input: Pick<ClaudeOpenQueryInput, "tools" | "executionPolicy" | "nativeSetup">,
): ClaudeStreamEvent {
  const event = object(value);
  if (event === undefined || typeof event.type !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (event.type === "message_start") {
    const message = object(event.message);
    if (
      message === undefined ||
      typeof message.id !== "string" ||
      typeof message.model !== "string"
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "message-start",
      messageId: message.id,
      model: message.model,
      usage: decodeUsage(message.usage, true),
    };
  }
  if (event.type === "message_delta") {
    const delta = object(event.delta);
    if (delta === undefined) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "message-delta",
      // Any reason is carried as the runtime names it; only the result's own
      // stop reason is shown, and an unknown one there reads as none.
      stopReason: typeof delta.stop_reason === "string" ? delta.stop_reason : null,
      usage: decodeUsage(event.usage, true, true),
    };
  }
  if (event.type === "message_stop") return { kind: "message-stop" };
  // The streaming API sends `ping` as a keep-alive during a long generation,
  // and the runtime forwards it like any other stream event. It carries no
  // content, so it is read as nothing; refusing it ended every turn whose
  // tool input took long enough to stream (observed on 2.1.3xx while the
  // model wrote a large Canvas document).
  if (event.type === "ping") return { kind: "ping" };
  const index = nonNegativeNumber(event.index);
  if (index === undefined || !Number.isInteger(index)) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (event.type === "content_block_start") {
    const content = decodeAssistantContent(event.content_block, input);
    if (content === undefined) throw protocol("Claude returned an unsupported runtime message.");
    return { kind: "content-start", index, content };
  }
  if (event.type === "content_block_stop") return { kind: "content-stop", index };
  if (event.type !== "content_block_delta") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  const delta = object(event.delta);
  if (delta === undefined || typeof delta.type !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return { kind: "text-delta", index, text: delta.text };
  }
  const estimatedTokens = nonNegativeNumber(delta.estimated_tokens);
  if (
    delta.type === "thinking_delta" &&
    typeof delta.thinking === "string" &&
    (delta.estimated_tokens === null || estimatedTokens !== undefined)
  ) {
    return {
      kind: "reasoning-delta",
      index,
      text: delta.thinking,
      ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
    };
  }
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return { kind: "tool-input-delta", index };
  }
  if (delta.type === "signature_delta" && typeof delta.signature === "string") {
    return { kind: "reasoning-signature", index };
  }
  if (delta.type === "citations_delta" && object(delta.citation) !== undefined) {
    return { kind: "citation-delta", index };
  }
  if (
    delta.type === "compaction_delta" &&
    (delta.content === null || typeof delta.content === "string") &&
    (delta.encrypted_content === null || typeof delta.encrypted_content === "string")
  ) {
    return { kind: "compaction-delta", index };
  }
  throw protocol("Claude returned an unsupported runtime message.");
}

// The runtime records an interrupt in its transcript as a user message it
// writes itself: one text block holding one of these markers. Claude Code
// 2.1.296 sends the first when output was streaming and the second when a
// tool was waiting, each just before the result that names
// `aborted_streaming` or `aborted_tools`. Read as a tool result the marker
// was refused, which ended every interrupted turn as a protocol failure
// before that result arrived. The marker settles nothing, so it is dropped
// and the result stays the turn's terminal statement.
const INTERRUPTION_MARKERS: ReadonlySet<string> = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

function isInterruptionMarker(content: ReadonlyArray<unknown>): boolean {
  if (content.length !== 1) return false;
  const block = object(content[0]);
  return (
    block?.type === "text" && typeof block.text === "string" && INTERRUPTION_MARKERS.has(block.text)
  );
}

function decodeToolResults(message: Record<string, unknown>): ClaudeDecodedMessage {
  const user = object(message.message);
  if (
    user === undefined ||
    user.role !== "user" ||
    (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined)
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (message.isReplay === true || typeof user.content === "string") return { kind: "ignored" };
  if (!Array.isArray(user.content) || typeof message.session_id !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (isInterruptionMarker(user.content)) return { kind: "ignored" };
  // A block that is not a tool result (text the runtime wrote into its own
  // transcript, a block type a newer runtime added) settles no call.
  const results = user.content.flatMap((value) => {
    const block = object(value);
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") return [];
    return [
      {
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        ...toolResultText(block.content),
      },
    ];
  });
  if (results.length === 0) return { kind: "ignored" };
  // `tool_use_result` is the structured output of the one call a message
  // settles; with several results it cannot be told apart, so it is ignored.
  const only = results.length === 1 ? results[0] : undefined;
  const publishedPage =
    only === undefined || only.isError ? undefined : claudePublishedPage(message.tool_use_result);
  const taskOutput =
    only === undefined || only.isError ? undefined : claudeTaskToolOutput(message.tool_use_result);
  return {
    kind: "tool-results",
    sessionId: message.session_id,
    results:
      only === undefined || (publishedPage === undefined && taskOutput === undefined)
        ? results
        : [
            {
              ...only,
              ...(publishedPage === undefined ? {} : { publishedPage }),
              ...(taskOutput === undefined ? {} : { taskOutput }),
            },
          ],
  };
}

/**
 * The text of a tool result: a string, or the text blocks of a content list
 * joined by newlines. Images and other blocks carry no text and are left out.
 */
function toolResultText(content: unknown): {
  readonly text?: string;
  readonly textTruncated?: true;
} {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((value) => {
              const part = object(value);
              return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
            })
            .join("\n")
        : "";
  if (text.length === 0) return {};
  return text.length <= MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS
    ? { text }
    : { text: text.slice(0, MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS), textTruncated: true };
}

const MAX_PUBLISHED_URL_CHARACTERS = 2_048;
const MAX_PUBLISHED_TITLE_CHARACTERS = 256;

/**
 * The page a Claude artifact publish names: an `https` address on claude.ai
 * and its title, from the tool's structured output (`{ url, path, title }` in
 * Claude Code 2.1.211's `ArtifactOutput`). Anything else is read as no page,
 * so a malformed or foreign address never becomes a link in the transcript.
 */
function claudePublishedPage(
  value: unknown,
): { readonly url: string; readonly title?: string } | undefined {
  const output = object(value);
  if (output === undefined || typeof output.url !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(output.url);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    // ASCII once parsed, so characters are bytes for the contract's bound.
    url.href.length > MAX_PUBLISHED_URL_CHARACTERS ||
    url.username !== "" ||
    url.password !== "" ||
    (url.hostname !== "claude.ai" && !url.hostname.endsWith(".claude.ai"))
  ) {
    return undefined;
  }
  const title =
    typeof output.title === "string"
      ? output.title.replace(/\s+/g, " ").trim().slice(0, MAX_PUBLISHED_TITLE_CHARACTERS).trim()
      : "";
  return { url: url.href, ...(title === "" ? {} : { title }) };
}

export function decodeModels(value: unknown): readonly ClaudeModelInfo[] {
  if (!Array.isArray(value)) throw protocol();
  return value.map((entry) => {
    const model = object(entry);
    if (
      model === undefined ||
      typeof model.value !== "string" ||
      typeof model.displayName !== "string" ||
      typeof model.description !== "string" ||
      (model.resolvedModel !== undefined && typeof model.resolvedModel !== "string") ||
      (model.supportsEffort !== undefined && typeof model.supportsEffort !== "boolean") ||
      (model.supportedEffortLevels !== undefined &&
        (!Array.isArray(model.supportedEffortLevels) ||
          !model.supportedEffortLevels.every(
            (level) => typeof level === "string" && EFFORT_LEVELS.has(level),
          )))
    ) {
      throw protocol();
    }
    return {
      id: model.value,
      ...(model.resolvedModel === undefined ? {} : { resolvedId: model.resolvedModel }),
      displayName: model.displayName,
      description: model.description,
      supportsEffort: model.supportsEffort === true,
      supportedEffortLevels:
        model.supportedEffortLevels === undefined
          ? []
          : (model.supportedEffortLevels as ClaudeModelInfo["supportedEffortLevels"]),
    };
  });
}

export function decodeAccount(value: unknown): ClaudeAccountState {
  const account = object(value);
  if (
    account === undefined ||
    (account.apiProvider !== undefined &&
      (typeof account.apiProvider !== "string" || !API_PROVIDERS.has(account.apiProvider)))
  ) {
    throw protocol();
  }
  if (account.apiProvider === undefined) return { ready: true };
  return {
    ready: true,
    apiProvider: account.apiProvider as NonNullable<ClaudeAccountState["apiProvider"]>,
  };
}

export function decodeInitialization(value: unknown): ClaudeInitialization {
  const initialized = object(value);
  const availableOutputStyles =
    initialized === undefined || initialized.available_output_styles === undefined
      ? []
      : stringArray(initialized.available_output_styles);
  // Claude Code announces its built-in slash commands and agents here on
  // every install (2.1.258 lists `clear`, `compact`, `Explore`, `Plan`, ...)
  // and the entries are objects, not names. Their presence is not evidence of
  // injected authority: the query opens with only the setting sources,
  // skills, plugins, and MCP servers the session's setup allows, and the tool
  // set is checked on the initialized message. Only the shape is validated here; requiring the
  // lists to be empty rejected every current install as incompatible.
  if (
    initialized === undefined ||
    !Array.isArray(initialized.agents) ||
    !Array.isArray(initialized.commands) ||
    typeof initialized.output_style !== "string" ||
    availableOutputStyles === undefined
  ) {
    throw protocol();
  }
  const commands = advertisedSlashCommands(initialized.commands);
  return {
    models: decodeModels(initialized.models),
    account: decodeAccount(initialized.account),
    compactAnnounced: initialized.commands.some(
      (command: unknown) => object(command)?.name === "compact",
    ),
    // Absent when the runtime announced none, as the initialization says.
    ...(commands.length === 0 ? {} : { commands }),
  };
}

/**
 * The compaction point in a runtime's context-usage answer. Claude Code 2.1.287
 * answers with `autoCompactThreshold` beside `maxTokens`, both in tokens (the
 * observed pairs are 167000 of 200000 and 967000 of 1000000), and with
 * `isAutoCompactEnabled`. The same release documents its other report of this
 * figure as "the token count where threshold-triggered compaction fires". The
 * threshold counts only while compaction is on and sits inside the window it
 * is measured against; anything else promises nothing.
 */
export function decodeAutoCompactThreshold(value: unknown): number | undefined {
  const usage = object(value);
  if (usage === undefined || usage.isAutoCompactEnabled !== true) return undefined;
  const { autoCompactThreshold, maxTokens } = usage;
  if (!Number.isSafeInteger(autoCompactThreshold) || !Number.isSafeInteger(maxTokens)) {
    return undefined;
  }
  const threshold = autoCompactThreshold as number;
  return threshold > 0 && threshold <= (maxTokens as number) ? threshold : undefined;
}

/**
 * The window in a runtime's context-usage answer (`maxTokens`), whether or not
 * it compacts by itself. A runtime's catalogue names its models by alias
 * ("haiku"), which no window profile matches, so this is what the window is.
 */
export function decodeContextUsageWindow(value: unknown): number | undefined {
  const maxTokens = object(value)?.maxTokens;
  return Number.isSafeInteger(maxTokens) && (maxTokens as number) > 0
    ? (maxTokens as number)
    : undefined;
}

// The runtime's own category names. Claude Code 2.1.287 answers every
// context-usage request with the ones it has content for. A name outside this
// table (for example "MCP server instructions" or "Free space") is not a part
// Octant names, so its tokens stay in the occupancy the reader shows as
// "Other (provider)" rather than being folded into a part it is not.
const CONTEXT_PART_BY_CATEGORY: Readonly<Record<string, ProviderContextPart["kind"]>> = {
  "System prompt": "system-prompt",
  "System tools": "system-tools",
  "MCP tools": "mcp-tools",
  "Custom agents": "agents",
  "Memory files": "memory-files",
  Skills: "skills",
  Messages: "messages",
  "Autocompact buffer": "reserved",
};
const DEFERRED_CONTEXT_CATEGORY: Readonly<Record<string, ProviderDeferredContextPart["kind"]>> = {
  "System tools (deferred)": "system-tools",
  "MCP tools (deferred)": "mcp-tools",
};

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function countWhere(
  value: unknown,
  wanted: (entry: Record<string, unknown>) => boolean,
): number | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry) => {
    const item = object(entry);
    return item !== undefined && wanted(item);
  }).length;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * What a runtime's context-usage answer says fills its window. Claude Code
 * 2.1.287 answers with `categories` (name, tokens, and `isDeferred` for tools it
 * knows of but has not loaded), `totalTokens` and `maxTokens`, plus lists that
 * give counts: `memoryFiles`, `mcpTools` (each with `isLoaded`), `agents`, and
 * `skills.includedSkills`. Every figure is the runtime's own, so it is
 * `provider-reported`. Only counts leave the lists: memory file paths and skill
 * names are never carried. An answer whose categories are malformed gives
 * nothing, so a half-read breakdown is never shown, and a category the runtime
 * left empty is not a part.
 */
export function decodeContextBreakdown(value: unknown): ProviderContextBreakdown | undefined {
  const usage = object(value);
  if (usage === undefined || !Array.isArray(usage.categories)) return undefined;
  const tokensByKind = new Map<ProviderContextPart["kind"], number>();
  const deferredKinds = new Set<ProviderDeferredContextPart["kind"]>();
  for (const raw of usage.categories) {
    const category = object(raw);
    if (category === undefined || typeof category.name !== "string") return undefined;
    const tokens = safeCount(category.tokens);
    if (tokens === undefined) return undefined;
    const deferred = DEFERRED_CONTEXT_CATEGORY[category.name];
    if (deferred !== undefined) {
      deferredKinds.add(deferred);
      continue;
    }
    const kind = category.kind === "buffer" ? "reserved" : CONTEXT_PART_BY_CATEGORY[category.name];
    if (kind === undefined || tokens === 0) continue;
    tokensByKind.set(kind, (tokensByKind.get(kind) ?? 0) + tokens);
  }
  const counts: Partial<Record<ProviderContextPart["kind"], number | undefined>> = {
    "system-tools": arrayLength(usage.systemTools),
    "mcp-tools": countWhere(usage.mcpTools, (tool) => tool.isLoaded !== false),
    "memory-files": arrayLength(usage.memoryFiles),
    agents: arrayLength(usage.agents),
    skills: safeCount(object(usage.skills)?.includedSkills),
  };
  const deferredCounts: Partial<Record<ProviderDeferredContextPart["kind"], number | undefined>> = {
    "system-tools": countWhere(usage.deferredBuiltinTools, (tool) => tool.isLoaded === false),
    "mcp-tools": countWhere(usage.mcpTools, (tool) => tool.isLoaded === false),
  };
  // The lists name tools the runtime left unloaded even when no category
  // carries tokens for them.
  for (const kind of ["system-tools", "mcp-tools"] as const) {
    if ((deferredCounts[kind] ?? 0) > 0) deferredKinds.add(kind);
  }
  const parts: ProviderContextPart[] = [...tokensByKind].map(([kind, tokens]) => {
    const count = counts[kind];
    return {
      kind,
      tokens,
      accuracy: "provider-reported" as const,
      ...(count === undefined ? {} : { count }),
    };
  });
  const deferred: ProviderDeferredContextPart[] = [...deferredKinds].map((kind) => {
    const count = deferredCounts[kind];
    return { kind, ...(count === undefined ? {} : { count }) };
  });
  if (parts.length === 0 && deferred.length === 0) return undefined;
  return { parts, ...(deferred.length === 0 ? {} : { deferred }) };
}

export function permissionMode(
  policy: ProviderExecutionPolicy,
  autoApprove?: boolean,
  ownPermissions = false,
): ClaudePermissionMode {
  if (policy === "full-access") return "bypassPermissions";
  if (policy === "plan") return "plan";
  if (autoApprove === true) return "auto";
  // Outside Strict, Accept edits is Claude Code's own `acceptEdits`, so its
  // engine accepts the edits; under Strict Octant's gate waives them itself.
  if (policy === "auto-accept-edits" && ownPermissions) return "acceptEdits";
  return "default";
}

// Authority only widens when the runtime holds a tool Octant did not ask
// for. It may hold fewer: Claude Code 2.1.258 never lists AskUserQuestion in
// the initialized tool set even when it was requested. A session that loads
// a trusted Project's code also holds the tools of the MCP servers the person
// and the Project set up, which Octant cannot name in advance; each call to
// one still passes Octant's gate. A session with the full built-in set holds
// every built-in tool but the withheld ones, also not named in advance, and
// each call to one passes the gate too. A tool the person blocked is never
// offered, so a runtime that still holds one is refused as widened.
export function claudeOffersTool(
  input: Pick<
    ClaudeOpenQueryInput,
    "tools" | "nativeSetup" | "withheldTools" | "planMcpServers" | "blockedTools"
  >,
  toolName: string,
): boolean {
  if (input.blockedTools?.includes(toolName) === true) return false;
  if (input.tools.includes(toolName)) return true;
  if (toolName.startsWith("mcp__")) {
    if (toolName.startsWith("mcp__octant__")) return false;
    return (
      claudeStartsOwnServers(input.nativeSetup) ||
      (input.planMcpServers ?? []).some((server) => toolName.startsWith(`mcp__${server}__`))
    );
  }
  return input.withheldTools !== undefined && !input.withheldTools.includes(toolName);
}

/**
 * Whether the session starts MCP servers other than Octant's: the account's
 * own with its tool servers on, and a trusted Project's with its code.
 */
function claudeStartsOwnServers(setup: ClaudeOpenQueryInput["nativeSetup"]): boolean {
  return setup?.toolServers === true || setup?.projectCode === true;
}

/** Whether a server the session reports is one this session may hold. */
function claudeOffersMcpServer(input: ClaudeOpenQueryInput, server: unknown): boolean {
  if (typeof server !== "object" || server === null) return false;
  const record = server as Record<string, unknown>;
  if (record.name === "octant")
    return input.managedToolServer === true && record.status === "connected";
  // The person's and the trusted Project's own servers; one that failed or
  // waits for sign-in simply offers no tools.
  if (typeof record.name !== "string") return false;
  // A Plan session holds only the account's servers the person marked.
  return (
    claudeStartsOwnServers(input.nativeSetup) || (input.planMcpServers ?? []).includes(record.name)
  );
}

function decodeInitializedMessage(
  message: Record<string, unknown>,
  input: ClaudeOpenQueryInput,
  acceptedModels: ReadonlySet<string> | undefined,
): ClaudeDecodedMessage {
  const mcpServers = Array.isArray(message.mcp_servers) ? message.mcp_servers : undefined;
  const tools = stringArray(message.tools);
  const capabilities = message.capabilities === undefined ? [] : stringArray(message.capabilities);
  const expectedPermissionMode = permissionMode(
    input.executionPolicy,
    input.autoApprove,
    input.ownPermissions === true,
  );
  if (
    mcpServers === undefined ||
    tools === undefined ||
    capabilities === undefined ||
    (message.agents !== undefined && !Array.isArray(message.agents)) ||
    (message.skills !== undefined && !Array.isArray(message.skills)) ||
    (message.plugins !== undefined && !Array.isArray(message.plugins)) ||
    (message.slash_commands !== undefined && !Array.isArray(message.slash_commands)) ||
    typeof message.session_id !== "string" ||
    typeof message.cwd !== "string" ||
    typeof message.model !== "string" ||
    typeof message.permissionMode !== "string" ||
    typeof message.output_style !== "string" ||
    typeof message.claude_code_version !== "string"
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  // Authority is what the runtime can actually do: the working directory,
  // the permission mode, no tool beyond the requested set, and no MCP server
  // Octant did not configure. Claude Code 2.1.258 also announces its built-in agents and
  // slash commands and the user's own skills on every install, returns the
  // tool list sorted, and echoes the model an alias resolved to. None of
  // those widen what the session may touch, so they are tolerated instead of
  // being reported as an incompatible runtime.
  const modelAccepted =
    message.model === input.model || acceptedModels?.has(message.model) === true;
  if (
    message.cwd !== input.projectRoot ||
    !modelAccepted ||
    message.permissionMode !== expectedPermissionMode ||
    (input.resumeSessionId !== undefined && message.session_id !== input.resumeSessionId) ||
    !mcpServers.every((server) => claudeOffersMcpServer(input, server)) ||
    !tools.every((tool) => claudeOffersTool(input, tool))
  ) {
    throw protocol("Claude initialized an unexpected runtime surface.");
  }
  return {
    kind: "initialized",
    sessionId: message.session_id,
    projectRoot: message.cwd,
    model: message.model,
    requestedModel: input.model,
    permissionMode: expectedPermissionMode,
    tools,
    capabilities,
    runtimeVersion: message.claude_code_version,
  };
}

const RESULT_SUBTYPES = new Set<ClaudeResultSubtype>([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);

const MAX_WORKFLOW_PROGRESS_ENTRIES = 512;
const WORKFLOW_AGENT_STATES = new Set(["start", "progress", "done", "error"]);

/**
 * The agents a workflow's `task_progress` reports. The runtime sends its
 * whole progress list each time: one `workflow_agent` entry per agent, kept
 * up to date in place, beside phase and log entries Octant does not show.
 * Only an agent's place, label, state, and last tool are read; its prompt
 * and result previews stay the runtime's.
 */
function decodeWorkflowAgents(value: unknown): readonly ClaudeWorkflowAgent[] {
  if (!Array.isArray(value) || value.length > MAX_WORKFLOW_PROGRESS_ENTRIES) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return value.flatMap((entry): ClaudeWorkflowAgent[] => {
    const item = object(entry);
    // An entry this build cannot place (another entry type, a state a newer
    // runtime added) is left out; the next whole list restates the rest.
    if (
      item?.type !== "workflow_agent" ||
      typeof item.index !== "number" ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      typeof item.label !== "string" ||
      typeof item.state !== "string" ||
      !WORKFLOW_AGENT_STATES.has(item.state)
    ) {
      return [];
    }
    return [
      {
        index: item.index,
        label: item.label,
        state: item.state as ClaudeWorkflowAgent["state"],
        ...(typeof item.lastToolName === "string" ? { lastToolName: item.lastToolName } : {}),
      },
    ];
  });
}

function decodeTaskUsage(value: unknown): ClaudeTaskUsage {
  const usage = object(value);
  const totalTokens = nonNegativeNumber(usage?.total_tokens);
  const toolUses = nonNegativeNumber(usage?.tool_uses);
  const durationMs = nonNegativeNumber(usage?.duration_ms);
  if (
    totalTokens === undefined ||
    toolUses === undefined ||
    !Number.isInteger(toolUses) ||
    durationMs === undefined
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return { totalTokens, toolUses, durationMs };
}

/**
 * The turn's terminal statement, read as leniently as it can be: a result the
 * decoder dropped would leave the turn waiting for an end that never comes.
 * A subtype this build does not know reads as the plain success or failure
 * `is_error` states, and a figure it cannot read is left out.
 */
function decodeResult(message: Record<string, unknown>): ClaudeDecodedMessage {
  if (typeof message.session_id !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  const knownSubtype =
    typeof message.subtype === "string" &&
    RESULT_SUBTYPES.has(message.subtype as ClaudeResultSubtype)
      ? (message.subtype as ClaudeResultSubtype)
      : undefined;
  const failed =
    message.is_error === true || (knownSubtype !== undefined && knownSubtype !== "success");
  const usage = readUsage(message.usage, true, true);
  const durationMs = nonNegativeNumber(message.duration_ms);
  const totalCostUsd = nonNegativeNumber(message.total_cost_usd);
  const permissionDenials = Array.isArray(message.permission_denials)
    ? message.permission_denials.flatMap((value) => {
        const entry = object(value);
        return typeof entry?.tool_name === "string" && typeof entry.tool_use_id === "string"
          ? [{ toolName: entry.tool_name, toolUseId: entry.tool_use_id }]
          : [];
      })
    : [];
  return {
    kind: "result",
    sessionId: message.session_id,
    outcome: failed ? "error" : "success",
    subtype: !failed
      ? "success"
      : knownSubtype === undefined || knownSubtype === "success"
        ? "error_during_execution"
        : knownSubtype,
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : null,
    ...(typeof message.terminal_reason === "string"
      ? { terminalReason: message.terminal_reason }
      : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage === undefined ? {} : { usage }),
    // Claude states the turn's price itself. Carrying it through is the only
    // way Octant can show a cost: it holds no price list of its own.
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    permissionDenials,
  };
}

function decodeRateLimit(message: Record<string, unknown>): ClaudeDecodedMessage {
  const info = object(message.rate_limit_info);
  const resetsAt = optionalNonNegativeNumber(info?.resetsAt);
  const utilization = optionalNonNegativeNumber(info?.utilization);
  if (
    typeof message.session_id !== "string" ||
    info === undefined ||
    (info.status !== "allowed" && info.status !== "allowed_warning" && info.status !== "rejected")
  )
    throw protocol("Claude returned an unsupported runtime message.");
  const overageResetsAt = optionalNonNegativeNumber(info.overageResetsAt);
  const overageStatus = info.overageStatus;
  return {
    kind: "rate-limit",
    sessionId: message.session_id,
    status: info.status,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(typeof info.rateLimitType === "string" ? { rateLimitType: info.rateLimitType } : {}),
    ...(utilization === undefined ? {} : { utilization }),
    ...(overageStatus === "allowed" ||
    overageStatus === "allowed_warning" ||
    overageStatus === "rejected"
      ? { overageStatus }
      : {}),
    ...(overageResetsAt === undefined ? {} : { overageResetsAt }),
    ...(typeof info.overageDisabledReason === "string"
      ? { overageDisabledReason: info.overageDisabledReason }
      : {}),
    ...(info.overageInUse === true || info.isUsingOverage === true ? { overageInUse: true } : {}),
  };
}

function decodeStatus(
  message: Record<string, unknown>,
  input: ClaudeOpenQueryInput,
): ClaudeDecodedMessage {
  const mode = message.permissionMode;
  const expectedMode = permissionMode(
    input.executionPolicy,
    input.autoApprove,
    input.ownPermissions === true,
  );
  // The one field of a status note that states authority: a mode other than
  // the one the host launched the session at is never passed over, whatever
  // else the note carries.
  if (mode !== undefined && mode !== expectedMode) {
    throw surfaceRefused("Claude returned an unsupported runtime message.");
  }
  if (
    typeof message.session_id !== "string" ||
    (message.status !== null && message.status !== "compacting" && message.status !== "requesting")
  )
    throw protocol("Claude returned an unsupported runtime message.");
  return {
    kind: "status",
    sessionId: message.session_id,
    status: message.status,
    ...(mode === undefined ? {} : { permissionMode: expectedMode }),
    ...(message.compact_result === "success" || message.compact_result === "failed"
      ? { compactResult: message.compact_result }
      : {}),
  };
}

/**
 * The runtime's own word on whether it is running a turn. It sends these only
 * when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set; `idle` follows the
 * last result of a run of turns, so a turn the runtime starts by itself from
 * a queued notice comes before it.
 */
function decodeSessionState(message: Record<string, unknown>): ClaudeDecodedMessage {
  if (
    typeof message.session_id !== "string" ||
    (message.state !== "idle" && message.state !== "running" && message.state !== "requires_action")
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return { kind: "session-state", sessionId: message.session_id, state: message.state };
}

export type ClaudeDecodePhase =
  | {
      readonly kind: "initializing";
      /** Model ids the runtime may report for the alias that was requested. */
      readonly acceptedModels?: ReadonlySet<string>;
    }
  | { readonly kind: "active"; readonly sessionId: string };

const MAX_CHILD_TOOL_USES = 32;

/**
 * What Octant reads of a subagent's own message: which tools its reply
 * calls, so the parent thread can show the run and mark a web read. The
 * subagent's text, its streamed deltas, and its tool results stay the
 * runtime's; each call it makes already passed Octant's gate with the
 * parent's posture before it ran.
 */
function decodeChildMessage(
  message: Record<string, unknown>,
  parentToolUseId: string,
): ClaudeDecodedMessage {
  if (typeof message.session_id !== "string") {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (message.type !== "assistant") return { kind: "ignored" };
  const content = object(message.message)?.content;
  if (!Array.isArray(content)) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  const toolUses = content.flatMap((value) => {
    const block = object(value);
    if (block?.type !== "tool_use") return [];
    const input = object(decodeJsonValue(block.input));
    if (typeof block.id !== "string" || typeof block.name !== "string" || input === undefined) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return [
      {
        toolUseId: block.id,
        toolName: block.name,
        input: input as { readonly [key: string]: ClaudeJsonValue },
      },
    ];
  });
  if (toolUses.length > MAX_CHILD_TOOL_USES) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  return { kind: "child-assistant", sessionId: message.session_id, parentToolUseId, toolUses };
}

export function decodeMessage(
  value: unknown,
  input: ClaudeOpenQueryInput,
  phase: ClaudeDecodePhase,
): ClaudeDecodedMessage {
  const message = object(value);
  if (message === undefined || typeof message.type !== "string") return { kind: "ignored" };
  // The initialized message is where the runtime states its surface, so it is
  // never dropped: unreadable, or sent a second time, it ends the session.
  if (message.type === "system" && message.subtype === "init") {
    if (phase.kind !== "initializing") {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return decodeInitializedMessage(message, input, phase.acceptedModels);
  }
  try {
    return decodeRecognizedMessage(message, input, phase);
  } catch (error) {
    // No log sink exists here, and the frame is runtime-supplied text, so a
    // frame this build cannot read is dropped without a note.
    if (error instanceof ClaudePortError && !(error instanceof ClaudeSurfaceRefusal)) {
      return { kind: "ignored" };
    }
    throw error;
  }
}

function decodeRecognizedMessage(
  message: Record<string, unknown>,
  input: ClaudeOpenQueryInput,
  phase: ClaudeDecodePhase,
): ClaudeDecodedMessage {
  if (phase.kind === "initializing") {
    // Since Claude Code 2.1.258 the runtime does not initialize until the
    // first user message arrives; what it sends before that is informational.
    // The runtime writes its status notes and rate-limit frames straight to
    // its output, beside the stream that opens with the initialized message.
    // A resumed session whose first input is `/compact` says `compacting`,
    // and passes on the limits its summarizing request reported, before it
    // initializes; refusing them failed every requested compaction. They are
    // decoded as they would be later, and the port holds them until the
    // runtime has initialized.
    if (message.type === "system" && message.subtype === "status") {
      return decodeStatus(message, input);
    }
    if (message.type === "rate_limit_event") return decodeRateLimit(message);
    // The session's state before it initializes says nothing about a turn,
    // but it does say the runtime reports its state: dropped, a background
    // task that ended before the first result could end the turn early.
    if (message.type === "system" && message.subtype === "session_state_changed") {
      return decodeSessionState(message);
    }
    return { kind: "ignored" };
  }
  // A frame for another session is dropped, never applied to this one.
  if (message.session_id !== phase.sessionId) return { kind: "ignored" };
  // A subagent's own messages name the parent's `Agent` call. They exist only
  // in a session the person let run its own subagents; anywhere else one is
  // still a runtime surface Octant did not open.
  if (
    input.nativeSetup?.subagents === true &&
    typeof message.parent_tool_use_id === "string" &&
    message.parent_tool_use_id.length > 0 &&
    message.parent_tool_use_id.length <= 256
  ) {
    return decodeChildMessage(message, message.parent_tool_use_id);
  }
  // A subagent's own task frames name its type; they are read below only in
  // a session with its own subagents on.
  const ownSubagentTaskFrame =
    input.nativeSetup?.subagents === true &&
    message.type === "system" &&
    typeof message.subtype === "string" &&
    message.subtype.startsWith("task_");
  if (
    (message.subagent_type !== undefined && !ownSubagentTaskFrame) ||
    message.task_description !== undefined
  ) {
    throw protocol("Claude returned an unsupported runtime message.");
  }
  if (message.type === "assistant") {
    const assistant = object(message.message);
    if (
      assistant === undefined ||
      typeof assistant.id !== "string" ||
      assistant.role !== "assistant" ||
      !Array.isArray(assistant.content) ||
      typeof message.session_id !== "string" ||
      (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined)
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    const usage = readUsage(assistant.usage, true, true);
    return {
      kind: "assistant",
      sessionId: message.session_id,
      messageId: assistant.id,
      ...(typeof message.uuid === "string" && message.uuid.trim().length > 0
        ? { uuid: message.uuid }
        : {}),
      // Any error code ends the turn; one this build does not know reads as
      // the plain failure.
      ...(typeof message.error === "string" ? { error: message.error } : {}),
      content: assistant.content.flatMap((content) => {
        const decoded = decodeAssistantContent(content, input);
        return decoded === undefined ? [] : [decoded];
      }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (message.type === "stream_event") {
    if (
      typeof message.session_id !== "string" ||
      (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined)
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "stream-event",
      sessionId: message.session_id,
      event: decodeStreamEvent(message.event, input),
    };
  }
  if (message.type === "user") return decodeToolResults(message);
  if (message.type === "result") return decodeResult(message);
  if (message.type === "tool_progress") {
    const elapsedSeconds = nonNegativeNumber(message.elapsed_time_seconds);
    // App-owned MCP calls report parent-correlated heartbeats while awaiting
    // approval. This is progress metadata, not authority to spawn an agent.
    const managedHeartbeat =
      input.managedToolServer === true &&
      message.heartbeat === true &&
      typeof message.tool_name === "string" &&
      message.tool_name.startsWith("mcp__octant__") &&
      typeof message.parent_tool_use_id === "string" &&
      message.parent_tool_use_id.length > 0 &&
      message.parent_tool_use_id.length <= 256;
    if (
      typeof message.session_id !== "string" ||
      typeof message.tool_use_id !== "string" ||
      typeof message.tool_name !== "string" ||
      !claudeOffersTool(input, message.tool_name) ||
      elapsedSeconds === undefined ||
      (message.parent_tool_use_id !== null && !managedHeartbeat) ||
      (message.task_id !== undefined && typeof message.task_id !== "string")
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "tool-progress",
      sessionId: message.session_id,
      toolUseId: message.tool_use_id,
      toolName: message.tool_name,
      elapsedSeconds,
      ...(managedHeartbeat && typeof message.parent_tool_use_id === "string"
        ? { parentToolUseId: message.parent_tool_use_id }
        : {}),
      ...(typeof message.task_id === "string" ? { taskId: message.task_id } : {}),
    };
  }
  if (message.type === "tool_use_summary") {
    const toolUseIds = stringArray(message.preceding_tool_use_ids);
    if (
      typeof message.session_id !== "string" ||
      typeof message.summary !== "string" ||
      toolUseIds === undefined
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "tool-summary",
      sessionId: message.session_id,
      summary: message.summary,
      toolUseIds,
    };
  }
  if (message.type === "rate_limit_event") return decodeRateLimit(message);
  if (message.type === "auth_status") {
    if (
      typeof message.session_id !== "string" ||
      typeof message.isAuthenticating !== "boolean" ||
      stringArray(message.output) === undefined ||
      (message.error !== undefined && typeof message.error !== "string")
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    return {
      kind: "authentication",
      sessionId: message.session_id,
      authenticating: message.isAuthenticating,
      failed: typeof message.error === "string",
    };
  }
  if (message.type === "system" && message.subtype === "status")
    return decodeStatus(message, input);
  // Claude Code compacts its own session when the window nears its threshold
  // (or on `/compact`) and marks the cut with a boundary. It used to end the
  // turn as an unsupported message the moment a long turn compacted. The
  // runtime sends fields its published type leaves out (`logical_parent_uuid`,
  // summary bookkeeping), so only the fields read here are checked.
  if (message.type === "system" && message.subtype === "compact_boundary") {
    const metadata = object(message.compact_metadata);
    if (
      typeof message.session_id !== "string" ||
      typeof message.uuid !== "string" ||
      metadata === undefined ||
      nonNegativeInteger(metadata.pre_tokens) === undefined ||
      (metadata.post_tokens !== undefined && nonNegativeInteger(metadata.post_tokens) === undefined)
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    const postTokens = nonNegativeInteger(metadata.post_tokens);
    return {
      kind: "compaction",
      sessionId: message.session_id,
      // Only `manual` can be a compaction the person asked for; any other
      // trigger is the runtime's own choice.
      trigger: metadata.trigger === "manual" ? "manual" : "auto",
      preTokens: nonNegativeInteger(metadata.pre_tokens) ?? 0,
      ...(postTokens === undefined ? {} : { postTokens }),
    };
  }
  if (message.type === "system" && message.subtype === "session_state_changed") {
    return decodeSessionState(message);
  }
  if (
    message.type === "system" &&
    (message.subtype === "task_started" ||
      message.subtype === "task_updated" ||
      message.subtype === "task_progress" ||
      message.subtype === "task_notification")
  ) {
    if (
      typeof message.session_id !== "string" ||
      typeof message.task_id !== "string" ||
      typeof message.uuid !== "string" ||
      (message.tool_use_id !== undefined && typeof message.tool_use_id !== "string")
    ) {
      throw protocol("Claude returned an unsupported runtime message.");
    }
    let status: string | undefined;
    let description: string | undefined;
    let summary: string | undefined;
    let usage: ClaudeTaskUsage | undefined;
    // A session with its own subagents on reports each one's lifecycle as a
    // task: `task_started` names the agent (`task_type: "local_agent"`,
    // `subagent_type`, its prompt) and later frames carry the subagent type.
    // The prompt is the runtime's and is never kept.
    const subagentTask = (value: Record<string, unknown>) =>
      input.nativeSetup?.subagents === true &&
      (value.subagent_type === undefined || typeof value.subagent_type === "string");
    let background = false;
    let workflow: { name?: string; agents?: readonly ClaudeWorkflowAgent[] } | undefined;
    if (message.subtype === "task_started") {
      const ownSubagent =
        subagentTask(message) &&
        (message.task_type === undefined || message.task_type === "local_agent") &&
        (message.prompt === undefined || typeof message.prompt === "string") &&
        (message.skip_transcript === undefined || typeof message.skip_transcript === "boolean");
      // A command Claude runs in the background, and a watch its Monitor
      // tool keeps, are `local_bash` tasks (Claude Code 2.1.211). Each wakes
      // the model when it finishes or reports, which the driver holds inside
      // the turn that started it (maintainer decision, 2026-11-14).
      const command =
        message.task_type === "local_bash" &&
        message.subagent_type === undefined &&
        message.prompt === undefined &&
        message.workflow_name === undefined &&
        (message.skip_transcript === undefined || typeof message.skip_transcript === "boolean");
      // A workflow runs in this process as a `local_workflow` task named by
      // its script's `meta.name`, and wakes the model when it ends, as a
      // background command does (maintainer decision, 2026-11-14). Its
      // `prompt` is the script, which is the runtime's and is never kept. A
      // run sent to a remote session (`remote_agent`) stays refused.
      const ownWorkflow =
        input.nativeSetup?.subagents === true &&
        message.task_type === "local_workflow" &&
        message.subagent_type === undefined &&
        (message.workflow_name === undefined || typeof message.workflow_name === "string") &&
        (message.prompt === undefined || typeof message.prompt === "string") &&
        (message.skip_transcript === undefined || typeof message.skip_transcript === "boolean");
      background = command || ownWorkflow;
      if (ownWorkflow) {
        const name = optionalString(message.workflow_name)?.trim().slice(0, 256);
        workflow = name === undefined || name.length === 0 ? {} : { name };
      }
      if (
        typeof message.description !== "string" ||
        (message.workflow_name !== undefined && !ownWorkflow) ||
        (!ownSubagent &&
          !background &&
          (message.subagent_type !== undefined ||
            message.task_type !== undefined ||
            message.prompt !== undefined ||
            (message.skip_transcript !== undefined && message.skip_transcript !== false)))
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      description = message.description;
    } else if (message.subtype === "task_progress") {
      if (
        typeof message.description !== "string" ||
        (message.subagent_type !== undefined && !subagentTask(message)) ||
        (message.last_tool_name !== undefined && typeof message.last_tool_name !== "string") ||
        (message.summary !== undefined && typeof message.summary !== "string")
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      description = message.description;
      summary = optionalString(message.summary);
      usage = decodeTaskUsage(message.usage);
      if (message.workflow_progress !== undefined) {
        if (input.nativeSetup?.subagents !== true) {
          throw protocol("Claude returned an unsupported runtime message.");
        }
        workflow = { agents: decodeWorkflowAgents(message.workflow_progress) };
      }
    } else if (message.subtype === "task_notification") {
      if (
        // A notification says the task ended; any status but `completed`
        // reads as not finished, so one a newer runtime added still ends it.
        typeof message.status !== "string" ||
        typeof message.summary !== "string"
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      status = message.status;
      summary = message.summary;
      if (message.usage !== undefined) usage = decodeTaskUsage(message.usage);
    } else {
      const patch = object(message.patch);
      if (
        patch === undefined ||
        (patch.status !== undefined && typeof patch.status !== "string") ||
        (patch.description !== undefined && typeof patch.description !== "string") ||
        (patch.error !== undefined && typeof patch.error !== "string") ||
        (patch.is_backgrounded !== undefined &&
          patch.is_backgrounded !== false &&
          !(subagentTask(message) && typeof patch.is_backgrounded === "boolean"))
      ) {
        throw protocol("Claude returned an unsupported runtime message.");
      }
      status = optionalString(patch.status);
      description = optionalString(patch.description);
    }
    return {
      kind: "task",
      sessionId: message.session_id,
      subtype: message.subtype,
      taskId: message.task_id,
      ...(typeof message.tool_use_id === "string" ? { toolUseId: message.tool_use_id } : {}),
      ...(background ? { background: true } : {}),
      ...(workflow === undefined ? {} : { workflow }),
      ...(status === undefined ? {} : { status }),
      ...(description === undefined ? {} : { description }),
      ...(summary === undefined ? {} : { summary }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  // Only the automatic-mode reviewer's refusal is a verdict. A denial for any
  // other reason keeps being an unsupported message, as it was.
  if (
    message.type === "system" &&
    message.subtype === "permission_denied" &&
    message.decision_reason_type === "classifier"
  ) {
    if (
      typeof message.session_id !== "string" ||
      typeof message.tool_use_id !== "string" ||
      typeof message.tool_name !== "string" ||
      (message.decision_reason !== undefined && typeof message.decision_reason !== "string")
    )
      throw protocol("Claude returned an unsupported runtime message.");
    return {
      kind: "review-denied",
      sessionId: message.session_id,
      toolUseId: message.tool_use_id,
      toolName: message.tool_name,
      ...(message.decision_reason === undefined ? {} : { reason: message.decision_reason }),
    };
  }
  // The runtime pushes its whole command list when skills are found mid-
  // session (SDK 0.3.211 `commands_changed`); it replaces the cached list.
  if (
    message.type === "system" &&
    message.subtype === "commands_changed" &&
    typeof message.session_id === "string" &&
    Array.isArray(message.commands)
  ) {
    return {
      kind: "commands-changed",
      sessionId: message.session_id,
      commands: advertisedSlashCommands(message.commands),
    };
  }
  // Everything else is the runtime's own bookkeeping (keep-alives, retry and
  // thinking notes, goals, prompt suggestions) or a message type or system
  // subtype a newer runtime added. None of it is read, so none of it can
  // change what the session may do.
  return { kind: "ignored" };
}

/**
 * The runtime's sessions whose own folder is `expectedRoot`. A session's
 * title (a name the person gave it, or the runtime's summary of its first
 * prompt) is kept only with `titles`, for the list a person picks a session
 * from; a resume lookup never carries it.
 */
export function decodeSessions(
  value: unknown,
  expectedRoot: string,
  options: { readonly titles?: true } = {},
): readonly ClaudeSessionMetadata[] {
  if (!Array.isArray(value)) throw protocol();
  return value.flatMap((entry) => {
    const session = object(entry);
    if (
      session === undefined ||
      typeof session.sessionId !== "string" ||
      typeof session.lastModified !== "number" ||
      (session.createdAt !== undefined && typeof session.createdAt !== "number") ||
      (session.cwd !== undefined && typeof session.cwd !== "string")
    ) {
      throw protocol();
    }
    if (session.cwd !== expectedRoot) return [];
    // A title or branch the runtime reports oddly is left out, never a reason
    // to drop the session.
    const named = typeof session.customTitle === "string" ? session.customTitle.trim() : "";
    const summary = typeof session.summary === "string" ? session.summary.trim() : "";
    const title = options.titles === true ? (named.length > 0 ? named : summary).slice(0, 200) : "";
    const gitBranch =
      options.titles === true && typeof session.gitBranch === "string"
        ? session.gitBranch.slice(0, 256)
        : undefined;
    return [
      {
        sessionId: session.sessionId,
        projectRoot: session.cwd,
        lastModified: session.lastModified,
        ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
        ...(title.length === 0 ? {} : { title }),
        ...(gitBranch === undefined || gitBranch.length === 0 ? {} : { gitBranch }),
      },
    ];
  });
}
