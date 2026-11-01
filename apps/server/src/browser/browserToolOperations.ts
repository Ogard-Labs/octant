import type {
  BrowserActionRequest,
  BrowserAutomationSnapshot,
  ProviderToolImage,
} from "@octant/contracts";
import {
  BROWSER_RESIZE_BOUNDS,
  MAX_BROWSER_UPLOAD_FILES,
  MAX_BROWSER_WAIT_MS,
  type BrowserWaitCondition,
  type BrowserWaitFor,
} from "@octant/contracts";
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
const TAB_PATTERN = /^t[1-9][0-9]{0,3}$/;

/** One element to act on: a CSS selector, or a ref from the latest snapshot. */
export type BrowserToolTarget =
  | { readonly selector: string; readonly ref?: undefined }
  | { readonly ref: string; readonly selector?: undefined };

/** What an action may bring back besides what changed; see the contract. */
export type BrowserToolInclude = ReadonlyArray<"text" | "screenshot" | "snapshot">;

/** One operation of a `steps` call: anything but a batch, an upload, stop, or help. */
export type BrowserToolStep = Exclude<
  BrowserToolInput,
  { readonly operation: "steps" | "upload" | "stop" | "sign-in" }
>;

/** How many operations one `steps` call may carry. */
export const MAX_BROWSER_TOOL_STEPS = 10;

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
  | { readonly operation: "snapshot" | "screenshot" | "stop" }
  | { readonly operation: "diagnostics"; readonly since?: number; readonly warnings?: boolean }
  | { readonly operation: "scroll"; readonly deltaX?: number; readonly deltaY?: number }
  | ({ readonly operation: "click" } & BrowserToolTarget)
  | ({ readonly operation: "wait" } & BrowserToolTarget)
  | { readonly operation: "wait"; readonly waitFor: BrowserWaitFor }
  | {
      readonly operation: "resize";
      readonly viewport?: { readonly width: number; readonly height: number };
    }
  | { readonly operation: "press"; readonly key: string }
  | ({ readonly operation: "type"; readonly text: string } & BrowserToolTarget)
  | ({ readonly operation: "hover" } & BrowserToolTarget)
  | ({ readonly operation: "select"; readonly value: string } & BrowserToolTarget)
  | ({
      readonly operation: "drag";
      readonly to: { readonly selector: string } | { readonly ref: string };
    } & BrowserToolTarget)
  | ({ readonly operation: "upload"; readonly files: ReadonlyArray<string> } & BrowserToolTarget)
  | { readonly operation: "tab-list" }
  | { readonly operation: "tab-open"; readonly url?: string }
  | { readonly operation: "tab-switch" | "tab-close"; readonly tabId: string }
  | { readonly operation: "steps"; readonly steps: ReadonlyArray<BrowserToolStep> }
  | { readonly operation: "sign-in"; readonly reason?: string }
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
  if (record.operation !== "steps") return parseBrowserToolRecord(record, options);
  // A batch is a list of ordinary operations, each read exactly as it would be
  // alone. It never opens a signed-in page, nests, uploads, or stops: those
  // need a call, and a question to the person, of their own.
  const steps = record.steps;
  if (
    Object.keys(record).some((key) => key !== "operation" && key !== "steps") ||
    !Array.isArray(steps) ||
    steps.length === 0 ||
    steps.length > MAX_BROWSER_TOOL_STEPS
  )
    return undefined;
  const parsedSteps: BrowserToolStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) return undefined;
    const one = parseBrowserToolRecord(step as Record<string, unknown>, { allowProfile: false });
    if (
      one === undefined ||
      one.operation === "steps" ||
      one.operation === "upload" ||
      one.operation === "stop" ||
      one.operation === "sign-in"
    )
      return undefined;
    parsedSteps.push(one);
  }
  return { operation: "steps", steps: parsedSteps };
}

function parseBrowserToolRecord(
  record: Record<string, unknown>,
  options: { readonly allowProfile: boolean },
): BrowserToolInput | undefined {
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
  if (operation === "wait" && only("selector", "ref", "conditions", "match", "timeoutMs")) {
    const waitFor = parseWaitFor(record);
    if (waitFor === null) return undefined;
    if (waitFor !== undefined) return { ...common, operation, waitFor };
  }
  if (operation === "resize" && only("width", "height")) {
    if (record.width === undefined && record.height === undefined) return { ...common, operation };
    const { width, height } = record;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < BROWSER_RESIZE_BOUNDS.minWidth ||
      width > BROWSER_RESIZE_BOUNDS.maxWidth ||
      height < BROWSER_RESIZE_BOUNDS.minHeight ||
      height > BROWSER_RESIZE_BOUNDS.maxHeight
    )
      return undefined;
    return { ...common, operation, viewport: { width, height } };
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
  if (operation === "hover" && only("selector", "ref")) {
    const named = target();
    return named === undefined ? undefined : { ...common, operation, ...named };
  }
  if (operation === "select" && only("selector", "ref", "value") && text("value", 1024)) {
    const named = target();
    return named === undefined
      ? undefined
      : { ...common, operation, ...named, value: record.value as string };
  }
  if (operation === "drag" && only("selector", "ref", "toSelector", "toRef")) {
    const named = target();
    if (named === undefined || (record.toSelector === undefined) === (record.toRef === undefined))
      return undefined;
    if (record.toRef !== undefined) {
      return typeof record.toRef === "string" && REF_PATTERN.test(record.toRef)
        ? { ...common, operation, ...named, to: { ref: record.toRef } }
        : undefined;
    }
    return text("toSelector", 4096)
      ? { ...common, operation, ...named, to: { selector: record.toSelector as string } }
      : undefined;
  }
  if (operation === "upload" && only("selector", "ref", "files")) {
    const named = target();
    const files = record.files;
    if (
      named === undefined ||
      !Array.isArray(files) ||
      files.length === 0 ||
      files.length > MAX_BROWSER_UPLOAD_FILES ||
      !files.every((file) => typeof file === "string" && file !== "" && file.length <= 4096)
    )
      return undefined;
    return { ...common, operation, ...named, files: files as ReadonlyArray<string> };
  }
  if (operation === "tab-list" && only()) return { ...common, operation };
  if (operation === "sign-in" && only("reason")) {
    if (record.reason !== undefined && !text("reason", 300)) return undefined;
    return {
      ...common,
      operation,
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    };
  }
  if (operation === "tab-open" && only("url")) {
    if (record.url !== undefined && !text("url", 4096)) return undefined;
    return {
      ...common,
      operation,
      ...(typeof record.url === "string" ? { url: record.url } : {}),
    };
  }
  if ((operation === "tab-switch" || operation === "tab-close") && only("tabId")) {
    return typeof record.tabId === "string" && TAB_PATTERN.test(record.tabId)
      ? { ...common, operation, tabId: record.tabId }
      : undefined;
  }
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
  if (operation === "diagnostics" && only("since", "warnings")) {
    const { since, warnings } = record;
    if (
      since !== undefined &&
      (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0)
    )
      return undefined;
    if (warnings !== undefined && typeof warnings !== "boolean") return undefined;
    return {
      ...common,
      operation,
      ...(typeof since === "number" ? { since } : {}),
      ...(typeof warnings === "boolean" ? { warnings } : {}),
    };
  }
  if ((operation === "snapshot" || operation === "screenshot" || operation === "stop") && only())
    return { ...common, operation };
  return undefined;
}

const ACTING_OPERATIONS: ReadonlySet<string> = new Set([
  "resize",
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "wait",
  "hover",
  "select",
  "drag",
  "upload",
]);
const INCLUDE_PARTS: ReadonlySet<unknown> = new Set(["text", "screenshot", "snapshot"]);

/**
 * A wait for conditions, read from the tool's own shape: `conditions` of
 * `{text, present}`, `{urlContains}`, `{load}`, or `{selector|ref, state}`,
 * with `match` and `timeoutMs`. A bare selector or ref with a `timeoutMs` is a
 * wait for that element to be attached. Undefined means a plain element wait;
 * null means the arguments are malformed.
 */
function parseWaitFor(record: Record<string, unknown>): BrowserWaitFor | undefined | null {
  const { conditions, match, timeoutMs } = record;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_BROWSER_WAIT_MS)
  )
    return null;
  if (match !== undefined && match !== "all" && match !== "any") return null;
  const limit = typeof timeoutMs === "number" ? { timeoutMs } : {};
  if (conditions === undefined) {
    if (match !== undefined) return null;
    if (timeoutMs === undefined) return undefined;
    const element = record.ref !== undefined ? { ref: record.ref } : { target: record.selector };
    const one = parseCondition({ ...element, state: "attached" });
    return one === undefined ? null : { conditions: [one], match: "all", ...limit };
  }
  if (record.selector !== undefined || record.ref !== undefined) return null;
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 5) return null;
  const parsed: BrowserWaitCondition[] = [];
  for (const entry of conditions) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const one = parseCondition(entry as Record<string, unknown>);
    if (one === undefined) return null;
    parsed.push(one);
  }
  return { conditions: parsed, match: match ?? "all", ...limit };
}

const ELEMENT_STATES: ReadonlySet<unknown> = new Set([
  "attached",
  "detached",
  "visible",
  "hidden",
  "enabled",
  "disabled",
]);

function parseCondition(entry: Record<string, unknown>): BrowserWaitCondition | undefined {
  const keys = Object.keys(entry);
  const string = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.trim() !== "" && value.length <= max;
  if (entry.text !== undefined) {
    if (keys.some((key) => key !== "text" && key !== "present")) return undefined;
    if (!string(entry.text, 1024)) return undefined;
    if (entry.present !== undefined && typeof entry.present !== "boolean") return undefined;
    return { kind: "text", text: entry.text, present: entry.present !== false };
  }
  if (entry.urlContains !== undefined) {
    if (keys.length !== 1 || !string(entry.urlContains, 2048)) return undefined;
    return { kind: "url", contains: entry.urlContains };
  }
  if (entry.load !== undefined) {
    if (keys.length !== 1 || (entry.load !== "load" && entry.load !== "domcontentloaded")) {
      return undefined;
    }
    return { kind: "load", state: entry.load };
  }
  if (
    keys.some((key) => key !== "selector" && key !== "target" && key !== "ref" && key !== "state")
  ) {
    return undefined;
  }
  if (!ELEMENT_STATES.has(entry.state)) return undefined;
  const state = entry.state as Extract<BrowserWaitCondition, { kind: "element" }>["state"];
  if (entry.ref !== undefined) {
    return typeof entry.ref === "string" && REF_PATTERN.test(entry.ref)
      ? { kind: "element", ref: entry.ref, state }
      : undefined;
  }
  const target = entry.selector ?? entry.target;
  return string(target, 4096) ? { kind: "element", target, state } : undefined;
}

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
    case "resize":
      return {
        ...base,
        kind: "resize",
        ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
      };
    case "wait":
      if ("waitFor" in input) return { ...base, kind: "wait", waitFor: input.waitFor };
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
      return {
        ...base,
        kind: "observe-diagnostics",
        ...(input.since === undefined ? {} : { diagnosticsSince: input.since }),
        ...(input.warnings === undefined ? {} : { diagnosticsWarnings: input.warnings }),
      };
    case "hover":
      return { ...base, kind: "hover", ...element(input) };
    case "select":
      return { ...base, kind: "select", ...element(input), value: input.value };
    case "drag":
      return {
        ...base,
        kind: "drag",
        ...element(input),
        ...("ref" in input.to
          ? { destinationRef: input.to.ref }
          : { destination: input.to.selector }),
      };
    case "upload":
      return { ...base, kind: "upload", ...element(input), files: input.files };
    case "tab-list":
      return { ...base, kind: "tab-list" };
    case "tab-open":
      return {
        ...base,
        kind: "tab-open",
        ...(input.url === undefined ? {} : { target: input.url }),
      };
    case "tab-switch":
      return { ...base, kind: "tab-select", tabId: input.tabId };
    case "tab-close":
      return { ...base, kind: "tab-close", tabId: input.tabId };
    case "stop":
    case "steps":
    case "sign-in":
      return undefined;
  }
}

/**
 * Hand the page to the person to sign in, and wait. The page is marked as the
 * person's while they do, so every window showing the thread brings its
 * Browser forward and every other agent action on it is held. On Continue the
 * agent gets a fresh snapshot of whatever page the person left; it never sees
 * what they typed, because a credential field never shows a value.
 */
export async function handBrowserToPerson(input: {
  readonly hold: () => () => void;
  readonly ask: () => Promise<"approved" | "denied" | "cancelled" | "expired">;
  readonly snapshotAfter: () => Promise<BrowserToolAnswer>;
}): Promise<BrowserToolAnswer> {
  const release = input.hold();
  let outcome: "approved" | "denied" | "cancelled" | "expired";
  try {
    outcome = await input.ask();
  } finally {
    release();
  }
  if (outcome !== "approved") {
    return { result: { error: `browser-sign-in-${outcome}` }, isError: true };
  }
  return input.snapshotAfter();
}

/** What one operation answered, as an executor returns it. */
export interface BrowserToolAnswer {
  readonly images?: ReadonlyArray<ProviderToolImage>;
  readonly result: unknown;
  readonly isError: boolean;
}

/**
 * Run a batch one step at a time through the same executor a single call
 * uses, so the server admits each step on its own: authority, model, origin
 * approval, Plan, the stale check, and the credential check. The first step
 * that fails ends the batch; the answer names it and what ran before it, and
 * otherwise is the last step's answer with a line per step.
 */
export async function runBrowserToolSteps(
  steps: ReadonlyArray<BrowserToolStep>,
  run: (step: BrowserToolStep) => Promise<BrowserToolAnswer>,
): Promise<BrowserToolAnswer> {
  const completed: Array<{
    readonly step: number;
    readonly operation: string;
    readonly changed?: string;
  }> = [];
  const images: ProviderToolImage[] = [];
  let last: BrowserToolAnswer | undefined;
  for (const [index, step] of steps.entries()) {
    const answer = await run(step);
    images.push(...(answer.images ?? []));
    if (answer.isError) {
      return {
        ...(images.length === 0 ? {} : { images }),
        result: {
          completed,
          failedStep: { step: index + 1, operation: step.operation, answer: answer.result },
        },
        isError: true,
      };
    }
    const changed = (answer.result as { readonly page?: { readonly changed?: unknown } }).page
      ?.changed;
    completed.push({
      step: index + 1,
      operation: step.operation,
      ...(typeof changed === "string" ? { changed } : {}),
    });
    last = answer;
  }
  return {
    ...(images.length === 0 ? {} : { images }),
    result: { ...(last?.result as Record<string, unknown>), steps: completed },
    isError: false,
  };
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
              ...(observation.tabs === undefined ? {} : { tabs: observation.tabs }),
              ...(observation.dialogs === undefined ? {} : { dialogs: observation.dialogs }),
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
              ...(observation.consoleWarnings === undefined
                ? {}
                : { consoleWarnings: observation.consoleWarnings }),
              ...(observation.httpErrors === undefined
                ? {}
                : { httpErrors: observation.httpErrors }),
              ...(observation.diagnosticsCursor === undefined
                ? {}
                : { diagnosticsCursor: observation.diagnosticsCursor }),
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
