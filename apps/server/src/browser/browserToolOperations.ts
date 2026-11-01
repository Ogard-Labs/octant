import type { BrowserActionRequest, BrowserAutomationSnapshot } from "@octant/contracts";
import { browserToolImage } from "./browserToolImage";

/**
 * The `octant_browser` operations every mode shares: how a call's arguments
 * are read, which page action each one asks for, and what the model gets
 * back. Work and Code differ in who approves and how a page opens, never in
 * what an operation means, so both read and answer it here.
 */

const MAX_TOOL_INPUT_BYTES = 16 * 1024;
const MAX_TEXT_RESULT_BYTES = 24 * 1024;
const REF_PATTERN = /^e[1-9][0-9]{0,3}$/;

/** One element to act on: a CSS selector, or a ref from the latest snapshot. */
export type BrowserToolTarget =
  | { readonly selector: string; readonly ref?: undefined }
  | { readonly ref: string; readonly selector?: undefined };

/** What an action may bring back besides what changed; see the contract. */
export type BrowserToolInclude = ReadonlyArray<"text" | "screenshot" | "snapshot">;

export type BrowserToolInput = {
  readonly expectedObservationRevision?: number;
  readonly include?: BrowserToolInclude;
} & (
  | {
      readonly operation: "navigate";
      readonly url: string;
      /** Ask for a page in the Project's or the Personal profile; absent is Private. */
      readonly profile?: "project" | "personal";
    }
  | ({ readonly operation: "read-page" } & Partial<BrowserToolTarget>)
  | { readonly operation: "snapshot" | "screenshot" | "diagnostics" | "stop" }
  | { readonly operation: "scroll"; readonly deltaX?: number; readonly deltaY?: number }
  | ({ readonly operation: "click" | "wait" } & BrowserToolTarget)
  | { readonly operation: "press"; readonly key: string }
  | ({ readonly operation: "type"; readonly text: string } & BrowserToolTarget)
);

/**
 * Read one call's arguments, or nothing when they are malformed. A mode
 * without signed-in pages refuses the `profile` argument rather than ignoring
 * it, so the model is never told a private page is a signed-in one.
 */
export function parseBrowserToolInput(
  value: string,
  options: { readonly allowProfile: boolean },
): BrowserToolInput | undefined {
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
  const include = parseInclude(record.include);
  if (include === null) return undefined;
  // Reading operations are the thing `include` would add, so only an action
  // that changes the page takes it.
  const acts = ACTING_OPERATIONS.has(String(operation));
  if (include !== undefined && !acts) return undefined;
  const common = {
    ...(revision === undefined ? {} : { expectedObservationRevision: revision }),
    ...(include === undefined ? {} : { include }),
  };
  const keys = Object.keys(record);
  const only = (...allowed: ReadonlyArray<string>) =>
    keys.every(
      (key) =>
        key === "operation" ||
        key === "expectedObservationRevision" ||
        (key === "include" && acts) ||
        allowed.includes(key),
    );
  const text = (key: string, max: number) =>
    typeof record[key] === "string" && record[key] !== "" && record[key].length <= max;
  // Exactly one of a selector and a ref names the element; neither is a
  // malformed call for every operation that acts on one.
  const target = (): BrowserToolTarget | undefined => {
    if (record.selector !== undefined && record.ref !== undefined) return undefined;
    if (record.ref !== undefined) {
      return typeof record.ref === "string" && REF_PATTERN.test(record.ref)
        ? { ref: record.ref }
        : undefined;
    }
    return text("selector", 4096) ? { selector: record.selector as string } : undefined;
  };
  if (operation === "read-page") {
    if (!only("selector", "ref")) return undefined;
    if (record.selector === undefined && record.ref === undefined) return { ...common, operation };
    const named = target();
    return named === undefined ? undefined : { ...common, operation, ...named };
  }
  if (operation === "navigate" && only("url", "profile") && text("url", 4096)) {
    if (record.profile !== undefined) {
      if (!options.allowProfile) return undefined;
      if (record.profile !== "project" && record.profile !== "personal") return undefined;
    }
    return {
      ...common,
      operation,
      url: record.url as string,
      ...(record.profile === undefined ? {} : { profile: record.profile }),
    };
  }
  if ((operation === "click" || operation === "wait") && only("selector", "ref")) {
    const named = target();
    return named === undefined ? undefined : { ...common, operation, ...named };
  }
  if (operation === "type" && only("selector", "ref", "text") && text("text", 65536)) {
    const named = target();
    return named === undefined
      ? undefined
      : { ...common, operation, ...named, text: record.text as string };
  }
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
  if (
    (operation === "snapshot" ||
      operation === "screenshot" ||
      operation === "diagnostics" ||
      operation === "stop") &&
    only()
  )
    return { ...common, operation };
  return undefined;
}

const ACTING_OPERATIONS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "wait",
]);
const INCLUDE_PARTS: ReadonlySet<unknown> = new Set(["text", "screenshot", "snapshot"]);

/** Absent is undefined; anything but a short list of distinct known parts is null. */
function parseInclude(value: unknown): BrowserToolInclude | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > INCLUDE_PARTS.size ||
    new Set(value).size !== value.length ||
    !value.every((part) => INCLUDE_PARTS.has(part))
  ) {
    return null;
  }
  return value as BrowserToolInclude;
}

/** Whether the model asked to see the page as a picture after this call. */
export function browserToolWantsScreenshot(input: BrowserToolInput): boolean {
  return input.operation === "screenshot" || input.include?.includes("screenshot") === true;
}

/** The page action one operation asks for, bound to the context that runs it. */
export function browserToolAction(
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
    ...(input.include === undefined ? {} : { include: input.include }),
  } as const;
  const element = (named: Partial<BrowserToolTarget>) =>
    named.ref !== undefined
      ? { ref: named.ref }
      : named.selector !== undefined
        ? { target: named.selector }
        : {};
  switch (input.operation) {
    case "navigate":
      return { ...base, kind: "navigate", target: input.url };
    case "read-page":
      return { ...base, kind: "extract-text", ...element(input) };
    case "snapshot":
      return { ...base, kind: "snapshot" };
    case "click":
      return { ...base, kind: "click", ...element(input) };
    case "type":
      return { ...base, kind: "type", ...element(input), value: input.text };
    case "press":
      return { ...base, kind: "press", value: input.key };
    case "wait":
      return { ...base, kind: "wait", ...element(input) };
    case "scroll":
      return {
        ...base,
        kind: "scroll",
        ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
        ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
      };
    case "screenshot":
      return { ...base, kind: "screenshot" };
    case "diagnostics":
      return { ...base, kind: "observe-diagnostics" };
    case "stop":
      return undefined;
  }
}

/**
 * What the model reads back from one operation: the page's address, title,
 * revision, and what changed, plus whatever the operation read or the call
 * asked to include. A text hash is the server's to compare, not the model's.
 */
export function browserToolResult(snapshot: BrowserAutomationSnapshot, includeScreenshot = false) {
  const image = includeScreenshot
    ? browserToolImage(snapshot.observation?.screenshotDataUrl)
    : undefined;
  const observation = snapshot.observation;
  const text = observation?.extractedText;
  const bounded =
    text === undefined
      ? undefined
      : Buffer.from(text, "utf8").subarray(0, MAX_TEXT_RESULT_BYTES).toString("utf8");
  return {
    ...(image === undefined ? {} : { images: [image] }),
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
              ...(observation.change === undefined ? {} : { changed: observation.change }),
              ...(observation.snapshot === undefined ? {} : { snapshot: observation.snapshot }),
              ...(bounded === undefined
                ? {}
                : {
                    text: bounded,
                    ...(bounded.length < (text?.length ?? 0) ? { textTruncated: true } : {}),
                  }),
              ...(observation.consoleErrors === undefined
                ? {}
                : { consoleErrors: observation.consoleErrors }),
              ...(observation.failedRequests === undefined
                ? {}
                : { failedRequests: observation.failedRequests }),
              ...(includeScreenshot && image === undefined
                ? { screenshotOmitted: "invalid-or-too-large" as const }
                : {}),
              // The screenshot reached the model either way; this only tells
              // it the thread's Browser captures strip will not show it.
              ...(observation.capture?.status === "kept"
                ? { captureId: observation.capture.captureId }
                : {}),
              ...(observation.capture?.status === "not-kept"
                ? { captureNotKept: observation.capture.reason }
                : {}),
            },
          }),
    },
    isError: snapshot.failure !== undefined || snapshot.status === "failed",
  };
}
