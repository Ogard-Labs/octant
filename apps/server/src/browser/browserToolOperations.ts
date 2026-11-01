import type {
  BrowserActionRequest,
  BrowserAutomationSnapshot,
  ProviderToolImage,
} from "@octant/contracts";
import { MAX_BROWSER_UPLOAD_FILES } from "@octant/contracts";
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
  { readonly operation: "steps" | "upload" | "stop" }
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
  | { readonly operation: "snapshot" | "screenshot" | "diagnostics" | "stop" }
  | { readonly operation: "scroll"; readonly deltaX?: number; readonly deltaY?: number }
  | ({ readonly operation: "click" | "wait" } & BrowserToolTarget)
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
      one.operation === "stop"
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
  "hover",
  "select",
  "drag",
  "upload",
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
      return undefined;
  }
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
