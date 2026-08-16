import type {
  BrowserAutomationSnapshot,
  BrowserThreadId,
  CodeOperationCommand,
  CodeOperationResult,
  CodeTerminalId,
  CodeThread,
  ToolActionAuthority,
  ToolActionRequest,
  WindowId,
} from "@octant/contracts";
import { MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS } from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { CodeOperationTerminalSnapshot } from "./codeOperationService";

const MAX_TOOL_INPUT_BYTES = 16 * 1024;
const MAX_TERMINAL_RESULT_BYTES = 32 * 1024;
const MAX_TERMINAL_SCAN_BYTES = 64 * 1024;
const MAX_BROWSER_TEXT_RESULT_BYTES = 24 * 1024;
const TERMINAL_COMMAND_TIMEOUT_MS = 30_000;
const TERMINAL_COMPLETION_POLL_MS = 50;

export const CODE_BROWSER_TOOL_NAME = "octant_browser";
export const CODE_TERMINAL_TOOL_NAME = "octant_terminal";

const browserDefinition = {
  name: CODE_BROWSER_TOOL_NAME,
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["navigate", "read-page", "click", "type", "scroll", "wait", "screenshot", "stop"],
      },
      url: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
    },
    required: ["operation"],
  },
} as const;

const terminalDefinition = {
  name: CODE_TERMINAL_TOOL_NAME,
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["run", "write", "read", "stop"] },
      command: { type: "string" },
    },
    required: ["operation"],
  },
} as const;

export interface CodeAppManagedToolsOptions {
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly readThread: (windowId: WindowId, threadId: CodeThread["id"]) => CodeThread | undefined;
  readonly uuid: () => string;
  readonly executeOperation: (
    windowId: WindowId,
    command: CodeOperationCommand,
  ) => Promise<CodeOperationResult>;
  readonly terminal: {
    readonly read: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThread["id"];
        readonly checkoutId: CodeThread["checkoutId"];
        readonly terminalId: CodeTerminalId;
      },
    ) => Promise<CodeOperationTerminalSnapshot>;
    readonly interrupt?: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThread["id"];
        readonly checkoutId: CodeThread["checkoutId"];
        readonly terminalId: CodeTerminalId;
      },
    ) => Promise<CodeOperationTerminalSnapshot>;
    readonly terminate?: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThread["id"];
        readonly checkoutId: CodeThread["checkoutId"];
        readonly terminalId: CodeTerminalId;
      },
    ) => Promise<CodeOperationTerminalSnapshot>;
  };
  readonly browser?: {
    readonly resolveAuthority: (
      threadId: BrowserThreadId,
      mode: "code",
    ) => ToolActionAuthority | undefined;
    readonly inspectThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => BrowserAutomationSnapshot;
    readonly create: (input: {
      readonly windowId: WindowId;
      readonly threadId: BrowserThreadId;
      readonly action: ToolActionRequest;
      readonly policy: {
        readonly profileMode: "isolated";
        readonly allowedOrigins: readonly string[];
        readonly credentialFieldProtection: true;
        readonly maxConcurrentTabs: 1;
        readonly sessionTimeoutMs: number;
      };
    }) => Promise<BrowserAutomationSnapshot>;
    readonly act: (input: {
      readonly windowId: WindowId;
      readonly request: {
        readonly actionId: ToolActionRequest["actionId"];
        readonly contextId: NonNullable<BrowserAutomationSnapshot["context"]>["contextId"];
        readonly correlationId: ToolActionRequest["correlationId"];
        readonly authority: ToolActionAuthority;
        readonly kind:
          | "navigate"
          | "click"
          | "type"
          | "scroll"
          | "screenshot"
          | "extract-text"
          | "wait";
        readonly target?: string;
        readonly value?: string;
      };
    }) => Promise<BrowserAutomationSnapshot>;
    readonly releaseThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => Promise<BrowserAutomationSnapshot>;
  };
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export function createCodeAppManagedTools(options: CodeAppManagedToolsOptions): AppManagedToolSet {
  return {
    definitions: [browserDefinition, terminalDefinition],
    execute: async ({ name, inputJson, signal }) => {
      if (signal?.aborted) return failure("tool-interrupted");
      const authorityFailure = currentAuthorityFailure(options);
      if (authorityFailure !== undefined) return failure(authorityFailure);
      if (name === CODE_TERMINAL_TOOL_NAME) {
        return terminalTool(options, parseTerminalInput(inputJson), signal);
      }
      if (name === CODE_BROWSER_TOOL_NAME && options.browser !== undefined) {
        return browserTool(options, parseBrowserInput(inputJson), signal);
      }
      return failure("tool-unavailable");
    },
  };
}

async function terminalTool(
  options: CodeAppManagedToolsOptions,
  input: TerminalToolInput | undefined,
  signal?: AbortSignal,
) {
  if (input === undefined) return failure("invalid-terminal-input");
  const terminalId = options.thread.id as unknown as CodeTerminalId;
  const scope = {
    threadId: options.thread.id,
    checkoutId: options.thread.checkoutId,
    terminalId,
  } as const;
  if (input.operation === "stop") {
    const stopped = await options.executeOperation(options.windowId, {
      kind: "stop-terminal",
      operationId: operationId(options),
      ...scope,
    });
    return operationResult(stopped, options, scope);
  }

  let snapshot: CodeOperationTerminalSnapshot | undefined;
  try {
    snapshot = await options.terminal.read(options.windowId, scope);
  } catch {
    // A missing terminal is an ordinary first-run state. Starting it remains a
    // server-authorized operation, while reads never replace a UI observer.
  }
  if (input.operation === "run" && snapshot?.status !== "running") {
    const started = await options.executeOperation(options.windowId, {
      kind: "start-terminal",
      operationId: operationId(options),
      ...scope,
      columns: 100,
      rows: 30,
      credentialRefs: [],
    });
    if (started.kind !== "terminal-state" || started.state !== "running") {
      return operationResult(started, options, scope);
    }
    snapshot = await options.terminal.read(options.windowId, scope);
  }
  if (snapshot === undefined) return failure("terminal-unavailable");
  if (snapshot.status !== "running") {
    return terminalSnapshot(snapshot);
  }
  if (input.operation === "run" || input.operation === "write") {
    if (signal?.aborted) return failure("tool-interrupted");
    const command = input.command;
    if (command === undefined) return failure("terminal-command-required");
    const marker =
      input.operation === "run" ? `oo${options.uuid().replaceAll("-", "")}` : undefined;
    const data =
      marker === undefined
        ? command
        : `${command}\rprintf '\\033]777;octant=${marker};exit=%s\\007' "$?"\r`;
    const written = await options.executeOperation(options.windowId, {
      kind: "write-terminal",
      operationId: operationId(options),
      ...scope,
      data,
    });
    if (written.kind === "operation-failed") return operationResult(written, options, scope);
    if (marker !== undefined) {
      return waitForTerminalCommand(options, scope, marker, signal);
    }
    await (options.wait ?? defaultWait)(200);
  }
  return terminalSnapshot(await options.terminal.read(options.windowId, scope));
}

async function waitForTerminalCommand(
  options: CodeAppManagedToolsOptions,
  scope: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly terminalId: CodeTerminalId;
  },
  marker: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + TERMINAL_COMMAND_TIMEOUT_MS;
  const completion = new RegExp(`\\u001b\\]777;octant=${marker};exit=(\\d+)\\u0007`, "g");
  for (;;) {
    const authorityFailure = currentAuthorityFailure(options);
    if (signal?.aborted || authorityFailure !== undefined) {
      await interruptTerminalCommand(options, scope, marker);
      return failure(signal?.aborted ? "tool-interrupted" : authorityFailure!);
    }
    await (options.wait ?? defaultWait)(TERMINAL_COMPLETION_POLL_MS);
    const postWaitAuthorityFailure = currentAuthorityFailure(options);
    if (signal?.aborted || postWaitAuthorityFailure !== undefined) {
      await interruptTerminalCommand(options, scope, marker);
      return failure(signal?.aborted ? "tool-interrupted" : postWaitAuthorityFailure!);
    }
    const snapshot = await options.terminal.read(options.windowId, scope);
    const transcript = terminalTranscriptTail(snapshot, MAX_TERMINAL_SCAN_BYTES).value;
    const matches = [...transcript.matchAll(completion)];
    const exitCode = matches.at(-1)?.[1];
    if (exitCode !== undefined) {
      return terminalSnapshot(
        {
          ...snapshot,
          transcript: {
            ...snapshot.transcript,
            chunks: [transcript.replace(completion, "")],
          },
        },
        { commandCompleted: true, commandExitCode: Number(exitCode) },
      );
    }
    if (snapshot.status !== "running") {
      return terminalSnapshot(snapshot, { commandCompleted: false });
    }
    if (Date.now() >= deadline) {
      await interruptTerminalCommand(options, scope, marker);
      const partial = terminalSnapshot(snapshot, { commandCompleted: false });
      return {
        result: { ...partial.result, error: "terminal-command-timeout" },
        isError: true,
      };
    }
  }
}

async function interruptTerminalCommand(
  options: CodeAppManagedToolsOptions,
  scope: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly terminalId: CodeTerminalId;
  },
  marker: string,
): Promise<void> {
  try {
    if (options.terminal.interrupt === undefined) return;
    let snapshot = await options.terminal.interrupt(options.windowId, scope);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (snapshot.status !== "running" || terminalHasCompletionMarker(snapshot, marker)) return;
      await (options.wait ?? defaultWait)(TERMINAL_COMPLETION_POLL_MS);
      snapshot = await options.terminal.read(options.windowId, scope);
    }
    await options.terminal.terminate?.(options.windowId, scope);
  } catch {
    try {
      await options.terminal.terminate?.(options.windowId, scope);
    } catch {
      // The terminal may already have exited. No further provider result is accepted.
    }
  }
}

function terminalHasCompletionMarker(
  snapshot: CodeOperationTerminalSnapshot,
  marker: string,
): boolean {
  return terminalTranscriptTail(snapshot, MAX_TERMINAL_SCAN_BYTES).value.includes(
    `\u001b]777;octant=${marker};exit=`,
  );
}

async function browserTool(
  options: CodeAppManagedToolsOptions,
  input: BrowserToolInput | undefined,
  signal?: AbortSignal,
) {
  if (input === undefined || options.browser === undefined) return failure("invalid-browser-input");
  const threadId = options.thread.id as unknown as BrowserThreadId;
  const authority = options.browser.resolveAuthority(threadId, "code");
  if (authority === undefined) return failure("browser-authority-unavailable");
  if (input.operation === "stop") {
    const released = await options.browser.releaseThread(options.windowId, threadId);
    return browserResult(released);
  }
  let snapshot = options.browser.inspectThread(options.windowId, threadId);
  if (snapshot.context === undefined) {
    if (input.operation !== "navigate" || input.url === undefined) {
      return failure("browser-navigation-required");
    }
    const origin = allowedOrigin(input.url);
    if (origin === undefined) return failure("invalid-browser-url");
    const action = actionRequest(options, authority);
    const created = await guardedBrowserEffect(options, threadId, signal, () =>
      options.browser!.create({
        windowId: options.windowId,
        threadId,
        action,
        policy: {
          profileMode: "isolated",
          allowedOrigins: [origin],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 600_000,
        },
      }),
    );
    if (created.kind === "failure") return failure(created.reason);
    snapshot = created.snapshot;
  }
  const context = snapshot.context;
  if (context === undefined || context.state !== "active") return browserResult(snapshot);
  if (signal?.aborted) return failure("tool-interrupted");
  const request = browserAction(input, context);
  if (request === undefined) return failure("invalid-browser-input");
  const acted = await guardedBrowserEffect(options, threadId, signal, () =>
    options.browser!.act({ windowId: options.windowId, request }),
  );
  if (acted.kind === "failure") return failure(acted.reason);
  if (
    input.operation === "screenshot" &&
    acted.snapshot.observation?.screenshotDataUrl === undefined
  ) {
    return failure("browser-screenshot-unavailable");
  }
  return browserResult(acted.snapshot, input.operation === "screenshot");
}

async function guardedBrowserEffect(
  options: CodeAppManagedToolsOptions,
  threadId: BrowserThreadId,
  signal: AbortSignal | undefined,
  effect: () => Promise<BrowserAutomationSnapshot>,
): Promise<
  | { readonly kind: "snapshot"; readonly snapshot: BrowserAutomationSnapshot }
  | { readonly kind: "failure"; readonly reason: string }
> {
  let settled = false;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<string>((resolve) => {
    onAbort = () => resolve("tool-interrupted");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const authorityChanged = (async () => {
    while (!settled) {
      await defaultWait(25);
      if (settled) break;
      const reason = currentAuthorityFailure(options);
      if (reason !== undefined) return reason;
    }
    return new Promise<string>(() => undefined);
  })();
  const pending = effect();
  try {
    const outcome = await Promise.race([
      pending.then((snapshot) => ({ kind: "snapshot" as const, snapshot })),
      interrupted.then((reason) => ({ kind: "failure" as const, reason })),
      authorityChanged.then((reason) => ({ kind: "failure" as const, reason })),
    ]);
    settled = true;
    if (outcome.kind === "snapshot") {
      const reason = currentAuthorityFailure(options);
      if (reason === undefined && signal?.aborted !== true) return outcome;
      await options.browser?.releaseThread(options.windowId, threadId);
      return { kind: "failure", reason: signal?.aborted === true ? "tool-interrupted" : reason! };
    }
    void pending.catch(() => undefined);
    await options.browser?.releaseThread(options.windowId, threadId);
    return outcome;
  } finally {
    settled = true;
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function browserAction(
  input: BrowserToolInput,
  context: NonNullable<BrowserAutomationSnapshot["context"]>,
) {
  const base = {
    actionId: context.actionId,
    contextId: context.contextId,
    correlationId: context.correlationId,
    authority: context.authority,
  } as const;
  switch (input.operation) {
    case "navigate":
      return input.url === undefined
        ? undefined
        : { ...base, kind: "navigate" as const, target: input.url };
    case "read-page":
      return { ...base, kind: "extract-text" as const };
    case "click":
      return input.selector === undefined
        ? undefined
        : { ...base, kind: "click" as const, target: input.selector };
    case "type":
      return input.selector === undefined || input.text === undefined
        ? undefined
        : { ...base, kind: "type" as const, target: input.selector, value: input.text };
    case "wait":
      return input.selector === undefined
        ? undefined
        : { ...base, kind: "wait" as const, target: input.selector };
    case "scroll":
      return { ...base, kind: "scroll" as const };
    case "screenshot":
      return { ...base, kind: "screenshot" as const };
  }
}

function actionRequest(
  options: CodeAppManagedToolsOptions,
  authority: ToolActionAuthority,
): ToolActionRequest {
  return {
    actionId: options.uuid() as ToolActionRequest["actionId"],
    correlationId: options.uuid() as ToolActionRequest["correlationId"],
    capability: {
      id: "browser-automation" as ToolActionRequest["capability"]["id"],
      version: 1,
    },
    authority,
    intent: "Operate the thread-owned isolated browser for the active Code task.",
    approval: { kind: "not-required" },
  };
}

function operationId(options: CodeAppManagedToolsOptions) {
  return options.uuid() as CodeOperationCommand["operationId"];
}

async function operationResult(
  result: CodeOperationResult,
  options: CodeAppManagedToolsOptions,
  scope: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly terminalId: CodeTerminalId;
  },
) {
  if (result.kind === "operation-failed") {
    return failure(result.failure.category, result.failure.message);
  }
  if (result.kind !== "terminal-state") return failure("terminal-operation-failed");
  try {
    return terminalSnapshot(await options.terminal.read(options.windowId, scope));
  } catch {
    return {
      result: { status: result.state, transcript: "" },
      isError: result.state === "failed" || result.state === "unavailable",
    };
  }
}

function terminalSnapshot(
  snapshot: CodeOperationTerminalSnapshot,
  command?: { readonly commandCompleted: boolean; readonly commandExitCode?: number },
) {
  const transcript = terminalTranscriptTail(snapshot, MAX_TERMINAL_RESULT_BYTES);
  return {
    result: {
      status: snapshot.status,
      transcript: transcript.value,
      truncated: transcript.truncated,
      ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
      ...(command === undefined ? {} : command),
    },
    isError: false,
  };
}

function browserResult(snapshot: BrowserAutomationSnapshot, includeScreenshot = false) {
  return {
    result: {
      status: snapshot.status,
      ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
      ...(snapshot.observation === undefined
        ? {}
        : {
            page: {
              ...(snapshot.observation.url === undefined ? {} : { url: snapshot.observation.url }),
              ...(snapshot.observation.title === undefined
                ? {}
                : { title: snapshot.observation.title }),
              ...(snapshot.observation.extractedText === undefined
                ? {}
                : {
                    text: boundedUtf8(
                      snapshot.observation.extractedText,
                      MAX_BROWSER_TEXT_RESULT_BYTES,
                    ),
                    ...(Buffer.byteLength(snapshot.observation.extractedText, "utf8") <=
                    MAX_BROWSER_TEXT_RESULT_BYTES
                      ? {}
                      : { textTruncated: true }),
                  }),
              ...(snapshot.observation.contentHash === undefined
                ? {}
                : { contentHash: snapshot.observation.contentHash }),
              ...(!includeScreenshot || snapshot.observation.screenshotDataUrl === undefined
                ? {}
                : snapshot.observation.screenshotDataUrl.length <=
                    MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS
                  ? { screenshotDataUrl: snapshot.observation.screenshotDataUrl }
                  : { screenshotOmitted: "too-large" as const }),
            },
          }),
    },
    isError: snapshot.failure !== undefined || snapshot.status === "failed",
  };
}

type TerminalToolInput =
  | { readonly operation: "read" | "stop" }
  | { readonly operation: "run" | "write"; readonly command?: string };

type BrowserToolInput =
  | { readonly operation: "navigate"; readonly url?: string }
  | { readonly operation: "read-page" | "scroll" | "screenshot" | "stop" }
  | { readonly operation: "click" | "wait"; readonly selector?: string }
  | { readonly operation: "type"; readonly selector?: string; readonly text?: string };

function parseTerminalInput(value: string): TerminalToolInput | undefined {
  const parsed = parseObject(value, new Set(["operation", "command"]));
  if (parsed === undefined) return undefined;
  const operation = parsed.operation;
  if (
    operation !== "run" &&
    operation !== "write" &&
    operation !== "read" &&
    operation !== "stop"
  ) {
    return undefined;
  }
  if (parsed.command !== undefined && typeof parsed.command !== "string") return undefined;
  if (
    typeof parsed.command === "string" &&
    Buffer.byteLength(parsed.command, "utf8") > MAX_TOOL_INPUT_BYTES
  ) {
    return undefined;
  }
  return { operation, ...(typeof parsed.command === "string" ? { command: parsed.command } : {}) };
}

function parseBrowserInput(value: string): BrowserToolInput | undefined {
  const parsed = parseObject(value, new Set(["operation", "url", "selector", "text"]));
  if (parsed === undefined) return undefined;
  const operation = parsed.operation;
  if (
    operation !== "navigate" &&
    operation !== "read-page" &&
    operation !== "click" &&
    operation !== "type" &&
    operation !== "scroll" &&
    operation !== "wait" &&
    operation !== "screenshot" &&
    operation !== "stop"
  )
    return undefined;
  for (const field of ["url", "selector", "text"] as const) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") return undefined;
  }
  return parsed as BrowserToolInput;
}

function currentAuthorityFailure(options: CodeAppManagedToolsOptions): string | undefined {
  const current = options.readThread(options.windowId, options.thread.id);
  if (
    current === undefined ||
    current.lifecycle !== "active" ||
    current.id !== options.thread.id ||
    current.checkoutId !== options.thread.checkoutId ||
    current.projectId !== options.thread.projectId ||
    current.repositoryId !== options.thread.repositoryId ||
    current.providerInstanceId !== options.thread.providerInstanceId ||
    current.modelId !== options.thread.modelId ||
    current.bindingRevisionId !== options.thread.bindingRevisionId
  ) {
    return "tool-authority-stale";
  }
  return current.executionPolicy === "full-access" ? undefined : "full-access-required";
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && isHighSurrogate(value.charCodeAt(low - 1))) low -= 1;
  return value.slice(0, low);
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  if (low < value.length && isLowSurrogate(value.charCodeAt(low))) low += 1;
  return value.slice(low);
}

function terminalTranscriptTail(
  snapshot: CodeOperationTerminalSnapshot,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const selected: string[] = [];
  let remaining = maxBytes;
  let firstSelectedIndex = snapshot.transcript.chunks.length;
  let truncatedByBound = false;
  for (let index = snapshot.transcript.chunks.length - 1; index >= 0; index -= 1) {
    const chunk = snapshot.transcript.chunks[index]!;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    firstSelectedIndex = index;
    if (chunkBytes <= remaining) {
      selected.unshift(chunk);
      remaining -= chunkBytes;
      continue;
    }
    selected.unshift(boundedUtf8Tail(chunk, remaining));
    truncatedByBound = true;
    break;
  }
  return {
    value: selected.join(""),
    truncated: snapshot.transcript.truncated || truncatedByBound || firstSelectedIndex > 0,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function parseObject(
  value: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_INPUT_BYTES) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function allowedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function failure(error: string, message?: string) {
  return { result: { error, ...(message === undefined ? {} : { message }) }, isError: true };
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
