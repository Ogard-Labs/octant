import type {
  BrowserActionRequest,
  BrowserAutomationSnapshot,
  BrowserContextPolicy,
  BrowserThreadId,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolActionRequest,
  WindowId,
} from "@octant/contracts";
import {
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
  MAX_BROWSER_TABS_PER_CONTEXT,
  sameToolActionAuthority,
} from "@octant/contracts";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { BrowserToolApprovalService } from "./browserToolApprovalService";

export const BROWSER_TOOL_NAME = "octant_browser";
const MAX_TEXT_RESULT_BYTES = 24 * 1024;
const MAX_TOOL_INPUT_BYTES = 16 * 1024;
const browserDefinition = {
  name: BROWSER_TOOL_NAME,
  description:
    "Control Octant's built-in browser for this task. Start with navigate and an HTTP(S) URL, then read-page, click or type using CSS selectors, press a key, scroll, wait for a selector, or capture a screenshot. Browser approval is requested inline when required.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "navigate",
          "read-page",
          "click",
          "type",
          "press",
          "scroll",
          "wait",
          "screenshot",
          "stop",
        ],
      },
      url: { type: "string", maxLength: 4096 },
      selector: { type: "string", maxLength: 4096 },
      text: { type: "string", maxLength: 65536 },
      key: { type: "string", maxLength: 64 },
      deltaX: { type: "integer", minimum: -2000, maximum: 2000 },
      deltaY: { type: "integer", minimum: -2000, maximum: 2000 },
      expectedObservationRevision: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
    required: ["operation"],
  },
} as const;

export interface BrowserAppManagedToolsOptions {
  readonly windowId: WindowId;
  readonly threadId: BrowserThreadId;
  readonly mode: "chat" | "work" | "code";
  readonly resolveAuthority: (
    threadId: BrowserThreadId,
    mode: ToolActionAuthority["mode"],
  ) => ToolActionAuthority | undefined;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly toolConstraints?: ReadonlyArray<string>;
  readonly browser: {
    readonly inspectThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => BrowserAutomationSnapshot;
    readonly create: (input: {
      readonly windowId: WindowId;
      readonly threadId: BrowserThreadId;
      readonly action: ToolActionRequest;
      readonly policy: BrowserContextPolicy;
    }) => Promise<BrowserAutomationSnapshot>;
    readonly act: (input: {
      readonly windowId: WindowId;
      readonly request: BrowserActionRequest;
    }) => Promise<BrowserAutomationSnapshot>;
    readonly releaseThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => Promise<BrowserAutomationSnapshot>;
  };
  readonly approvals?: Pick<BrowserToolApprovalService, "request">;
  readonly uuid: () => string;
}

type BrowserToolInput =
  | {
      readonly operation: "navigate";
      readonly url: string;
      readonly expectedObservationRevision?: number;
    }
  | {
      readonly operation: "read-page" | "screenshot" | "stop";
      readonly expectedObservationRevision?: number;
    }
  | {
      readonly operation: "click" | "wait";
      readonly selector: string;
      readonly expectedObservationRevision?: number;
    }
  | {
      readonly operation: "type";
      readonly selector: string;
      readonly text: string;
      readonly expectedObservationRevision?: number;
    }
  | {
      readonly operation: "press";
      readonly key: string;
      readonly expectedObservationRevision?: number;
    }
  | {
      readonly operation: "scroll";
      readonly deltaX?: number;
      readonly deltaY?: number;
      readonly expectedObservationRevision?: number;
    };

const hostPolicy: BrowserContextPolicy = {
  profileMode: "isolated",
  allowedOrigins: [],
  credentialFieldProtection: true,
  maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
  sessionTimeoutMs: 600_000,
};

export function createBrowserAppManagedTools(
  options: BrowserAppManagedToolsOptions,
): AppManagedToolSet {
  const rememberedContexts = new Set<string>();
  const definitions = isToolAllowedByAllowlist(options.toolConstraints ?? [], BROWSER_TOOL_NAME)
    ? [browserDefinition]
    : [];
  return {
    definitions,
    execute: async ({ inputJson, name, signal }) => {
      if (name !== BROWSER_TOOL_NAME || definitions.length === 0) {
        return failure("tool-unavailable");
      }
      if (signal?.aborted) return failure("tool-interrupted");
      const input = parseInput(inputJson);
      if (input === undefined) return failure("invalid-browser-input");
      const authority = options.resolveAuthority(options.threadId, options.mode);
      if (authority === undefined) return failure("browser-authority-unavailable");
      if (input.operation === "stop") {
        const snapshot = options.browser.inspectThread(options.windowId, options.threadId);
        if (snapshot.context !== undefined)
          rememberedContexts.delete(String(snapshot.context.contextId));
        return browserResult(
          await options.browser.releaseThread(options.windowId, options.threadId),
        );
      }
      if (options.executionPolicy === "plan") return failure("plan-mode-read-only");
      let snapshot = options.browser.inspectThread(options.windowId, options.threadId);
      const existing = snapshot.context?.state === "active" ? snapshot.context : undefined;
      if (existing === undefined && snapshot.context !== undefined) {
        rememberedContexts.delete(String(snapshot.context.contextId));
      }
      const origin =
        existing === undefined
          ? input.operation === "navigate"
            ? allowedOrigin(input.url)
            : undefined
          : existing.policy.allowedOrigins.join(", ");
      if (origin === undefined) {
        return failure(
          input.operation === "navigate" ? "invalid-browser-url" : "browser-navigation-required",
        );
      }
      if (existing === undefined || !rememberedContexts.has(String(existing.contextId))) {
        if (options.approvals === undefined) return failure("browser-approval-required");
        const outcome = await options.approvals.request({
          windowId: options.windowId,
          threadId: String(options.threadId),
          authority,
          origin,
          ...(signal === undefined ? {} : { signal }),
        });
        if (outcome !== "approved") return failure(`browser-approval-${outcome}`);
        if (signal?.aborted) return failure("tool-interrupted");
        const refreshed = options.resolveAuthority(options.threadId, options.mode);
        if (refreshed === undefined || !sameToolActionAuthority(authority, refreshed)) {
          return failure("browser-authority-stale");
        }
      }
      if (existing === undefined) {
        const created = await options.browser.create({
          windowId: options.windowId,
          threadId: options.threadId,
          action: actionRequest(options, authority),
          policy: { ...hostPolicy, allowedOrigins: [origin] },
        });
        snapshot = created;
        if (created.context?.state === "active")
          rememberedContexts.add(String(created.context.contextId));
      }
      const context = snapshot.context;
      if (context === undefined || context.state !== "active") return browserResult(snapshot);
      if (!rememberedContexts.has(String(context.contextId)))
        rememberedContexts.add(String(context.contextId));
      const request = browserAction(input, context);
      if (request === undefined) return failure("invalid-browser-input");
      if (signal?.aborted) return failure("tool-interrupted");
      const acted = await options.browser.act({ windowId: options.windowId, request });
      if (signal?.aborted) return failure("tool-interrupted");
      if (input.operation === "screenshot" && acted.observation?.screenshotDataUrl === undefined) {
        return failure("browser-screenshot-unavailable");
      }
      return browserResult(acted, input.operation === "screenshot");
    },
  };
}

function actionRequest(
  options: BrowserAppManagedToolsOptions,
  authority: ToolActionAuthority,
): ToolActionRequest {
  return {
    actionId: options.uuid() as ToolActionRequest["actionId"],
    correlationId: options.uuid() as ToolActionRequest["correlationId"],
    capability: { id: "browser-automation" as ToolActionRequest["capability"]["id"], version: 1 },
    authority,
    intent: "Operate the thread-owned isolated browser.",
    approval: { kind: "not-required" },
  };
}

function browserAction(
  input: BrowserToolInput,
  context: NonNullable<BrowserAutomationSnapshot["context"]>,
): BrowserActionRequest | undefined {
  const base = {
    actionId: context.actionId,
    contextId: context.contextId,
    correlationId: context.correlationId,
    authority: context.authority,
    ...(input.expectedObservationRevision === undefined
      ? {}
      : { expectedObservationRevision: input.expectedObservationRevision }),
  } as const;
  switch (input.operation) {
    case "navigate":
      return { ...base, kind: "navigate", target: input.url };
    case "read-page":
      return { ...base, kind: "extract-text" };
    case "click":
      return { ...base, kind: "click", target: input.selector };
    case "type":
      return { ...base, kind: "type", target: input.selector, value: input.text };
    case "press":
      return { ...base, kind: "press", value: input.key };
    case "wait":
      return { ...base, kind: "wait", target: input.selector };
    case "scroll":
      return {
        ...base,
        kind: "scroll",
        ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
        ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
      };
    case "screenshot":
      return { ...base, kind: "screenshot" };
    case "stop":
      return undefined;
  }
}

function parseInput(value: string): BrowserToolInput | undefined {
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_INPUT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const operation = record.operation;
  const revision = record.expectedObservationRevision;
  if (
    revision !== undefined &&
    (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
  )
    return undefined;
  const common = revision === undefined ? {} : { expectedObservationRevision: revision };
  const keys = Object.keys(record);
  const only = (...allowed: ReadonlyArray<string>) =>
    keys.every(
      (key) =>
        key === "operation" || key === "expectedObservationRevision" || allowed.includes(key),
    );
  const text = (key: string, max: number) =>
    typeof record[key] === "string" && record[key] !== "" && record[key].length <= max;
  if (operation === "navigate" && only("url") && text("url", 4096))
    return { ...common, operation, url: record.url as string };
  if ((operation === "click" || operation === "wait") && only("selector") && text("selector", 4096))
    return { ...common, operation, selector: record.selector as string };
  if (
    operation === "type" &&
    only("selector", "text") &&
    text("selector", 4096) &&
    text("text", 65536)
  )
    return {
      ...common,
      operation,
      selector: record.selector as string,
      text: record.text as string,
    };
  if (operation === "press" && only("key") && text("key", 64))
    return { ...common, operation, key: record.key as string };
  if (operation === "scroll" && only("deltaX", "deltaY")) {
    const deltaX = record.deltaX;
    const deltaY = record.deltaY;
    if (
      (deltaX !== undefined &&
        (typeof deltaX !== "number" || !Number.isInteger(deltaX) || Math.abs(deltaX) > 2000)) ||
      (deltaY !== undefined &&
        (typeof deltaY !== "number" || !Number.isInteger(deltaY) || Math.abs(deltaY) > 2000))
    )
      return undefined;
    return {
      ...common,
      operation,
      ...(typeof deltaX === "number" ? { deltaX } : {}),
      ...(typeof deltaY === "number" ? { deltaY } : {}),
    };
  }
  if ((operation === "read-page" || operation === "screenshot" || operation === "stop") && only())
    return { ...common, operation };
  return undefined;
}

function allowedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function browserResult(snapshot: BrowserAutomationSnapshot, includeScreenshot = false) {
  const observation = snapshot.observation;
  const text = observation?.extractedText;
  const bounded =
    text === undefined
      ? undefined
      : Buffer.from(text, "utf8").subarray(0, MAX_TEXT_RESULT_BYTES).toString("utf8");
  return {
    result: {
      status: snapshot.status,
      ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
      ...(observation === undefined
        ? {}
        : {
            page: {
              ...(observation.revision === undefined
                ? {}
                : { observationRevision: observation.revision }),
              ...(observation.url === undefined ? {} : { url: observation.url }),
              ...(observation.title === undefined ? {} : { title: observation.title }),
              ...(bounded === undefined
                ? {}
                : {
                    text: bounded,
                    ...(bounded.length < (text?.length ?? 0) ? { textTruncated: true } : {}),
                  }),
              ...(observation.contentHash === undefined
                ? {}
                : { contentHash: observation.contentHash }),
              ...(!includeScreenshot || observation.screenshotDataUrl === undefined
                ? {}
                : observation.screenshotDataUrl.length <= MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS
                  ? { screenshotDataUrl: observation.screenshotDataUrl }
                  : { screenshotOmitted: "too-large" as const }),
            },
          }),
    },
    isError: snapshot.failure !== undefined || snapshot.status === "failed",
  };
}

function failure(reason: string) {
  return { result: { error: reason }, isError: true };
}
