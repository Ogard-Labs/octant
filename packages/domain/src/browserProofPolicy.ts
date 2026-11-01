import type {
  BrowserActionKind,
  BrowserCapture,
  BrowserStep,
  BrowserStepFailureCategory,
  StoredBrowserProfile,
} from "@octant/contracts";
import { MAX_BROWSER_STEPS_PER_THREAD } from "@octant/contracts";
import { browserCaptureRetention } from "./browserCapturePolicy";
import { imageFileExtension } from "./imageGenerationInvocationPolicy";

/** What a step is built from: only fields that are safe to keep, never the request itself. */
export interface BrowserStepFacts {
  readonly operation: BrowserActionKind;
  /** The element the action named by ref, as the page's snapshot described it. */
  readonly element?: { readonly role: string; readonly name: string } | undefined;
  /** The page's address after the action (or the last known one when it failed). */
  readonly url?: string | undefined;
  /**
   * What the page was and became, so the record can say in fixed words what
   * changed. Page titles and text are compared here and never copied.
   */
  readonly change?:
    | {
        readonly before: BrowserPageState;
        readonly after: BrowserPageState;
      }
    | undefined;
  readonly failure?: BrowserStepFailureCategory | undefined;
  readonly captureId?: BrowserStep["captureId"] | undefined;
  readonly profile?: StoredBrowserProfile | undefined;
}

export interface BrowserPageState {
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly contentHash: string | undefined;
}

const READ_ONLY_OPERATIONS: ReadonlySet<BrowserActionKind> = new Set([
  "extract-text",
  "snapshot",
  "screenshot",
  "observe-diagnostics",
  "tab-list",
]);

/**
 * The stored result of a step, built from fixed categories. A page can echo
 * what the agent typed into its title or text (search results do), so the
 * record never copies either: it says only that the address, title, or
 * content changed, and the new address as origin and path.
 */
export function browserStepChange(
  operation: BrowserActionKind,
  before: BrowserPageState,
  after: BrowserPageState,
): string | undefined {
  if (READ_ONLY_OPERATIONS.has(operation)) return undefined;
  const parts: string[] = [];
  if (after.url !== before.url) {
    const page = pageOf(after.url);
    parts.push(
      page === undefined ? "Address changed" : `Address changed to ${page.origin}${page.path}`,
    );
  }
  if (after.title !== before.title && after.title !== undefined) parts.push("Title changed");
  if (after.contentHash === undefined) parts.push("Page content not compared");
  else if (before.contentHash !== undefined && after.contentHash !== before.contentHash) {
    parts.push("Page content changed");
  }
  return parts.length === 0 ? "Nothing changed." : `${parts.join(". ")}.`;
}

const MAX_ELEMENT_NAME = 160;
const MAX_PATH = 512;

/**
 * The record of one step, without its identity. The request's own text, a
 * field's value, and the address's query and fragment have no field to go in:
 * a step names the operation, the element by role and accessible name, the page
 * by origin and path, and what happened in one line.
 *
 * Rationale: the result line is built from categories (see
 * `browserStepChange`), so no page title or text, and no query or fragment of an
 * address, can reach the journal or a pull request body.
 */
export function browserStepRecord(
  facts: BrowserStepFacts,
): Omit<BrowserStep, "stepId" | "threadId" | "recordedAt"> {
  const page = pageOf(facts.url);
  const changed =
    facts.change === undefined
      ? undefined
      : browserStepChange(facts.operation, facts.change.before, facts.change.after);
  const role = facts.element?.role.trim().slice(0, 64);
  return {
    operation: facts.operation,
    ...(facts.element === undefined || role === undefined || role.length === 0
      ? {}
      : { element: { role, name: facts.element.name.trim().slice(0, MAX_ELEMENT_NAME) } }),
    ...(page === undefined ? {} : { origin: page.origin, path: page.path }),
    ...(changed === undefined ? {} : { changed }),
    ...(facts.failure === undefined ? {} : { failure: facts.failure }),
    ...(facts.captureId === undefined ? {} : { captureId: facts.captureId }),
    ...(facts.profile === undefined ? {} : { profile: facts.profile }),
  };
}

function pageOf(
  url: string | undefined,
): { readonly origin: string; readonly path: string } | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return { origin: parsed.origin, path: parsed.pathname.slice(0, MAX_PATH) };
  } catch {
    return undefined;
  }
}

/** The newest steps a thread keeps, by journal order; the same rule captures follow. */
export function browserStepRetention(headVersion: number): {
  readonly firstRetainedVersion: number;
} {
  return browserCaptureRetention(headVersion, MAX_BROWSER_STEPS_PER_THREAD);
}

export type BrowserProofEntry =
  | { readonly kind: "step"; readonly number: number; readonly step: BrowserStep }
  | {
      readonly kind: "capture";
      /** The capture's place in the saved files, counted from 1 in time order. */
      readonly fileNumber: number;
      readonly capture: BrowserCapture;
    };

/**
 * The proof as one numbered sequence: the steps oldest first, each capture
 * right after the step that took it. A capture no retained step names (the
 * person's own, or one whose step has aged out) follows the last step recorded
 * at or before it, or leads when none was.
 */
export function browserProofTimeline(
  steps: ReadonlyArray<BrowserStep>,
  captures: ReadonlyArray<BrowserCapture>,
): ReadonlyArray<BrowserProofEntry> {
  const oldestFirst = browserProofCaptureOrder(captures);
  const fileNumbers = new Map(oldestFirst.map((capture, index) => [capture.captureId, index + 1]));
  const after = new Map<number, BrowserCapture[]>();
  const leading: BrowserCapture[] = [];
  for (const capture of oldestFirst) {
    let place = steps.findIndex((step) => step.captureId === capture.captureId);
    if (place === -1) {
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const candidate = steps[index];
        if (candidate !== undefined && candidate.recordedAt <= capture.capturedAt) {
          place = index;
          break;
        }
      }
    }
    if (place === -1) leading.push(capture);
    else after.set(place, [...(after.get(place) ?? []), capture]);
  }
  const entry = (capture: BrowserCapture): BrowserProofEntry => ({
    kind: "capture",
    fileNumber: fileNumbers.get(capture.captureId) ?? 0,
    capture,
  });
  return [
    ...leading.map(entry),
    ...steps.flatMap((step, index): BrowserProofEntry[] => [
      { kind: "step", number: index + 1, step },
      ...(after.get(index) ?? []).map(entry),
    ]),
  ];
}

/** The captures in the order their files are numbered: oldest first, from 1. */
export function browserProofCaptureOrder(
  captures: ReadonlyArray<BrowserCapture>,
): ReadonlyArray<BrowserCapture> {
  return [...captures].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

/** `browser-check-03.png`: a name from the position and media type alone, never from a page. */
export function browserProofScreenshotFileName(
  fileNumber: number,
  mime: BrowserCapture["mime"],
): string {
  return `browser-check-${String(fileNumber).padStart(2, "0")}.${imageFileExtension(mime)}`;
}

/** One line for a step, shared by the panel and the pull request section. */
export function browserStepLine(step: BrowserStep): string {
  const element =
    step.element === undefined
      ? ""
      : step.element.name.length === 0
        ? ` ${step.element.role}`
        : ` ${step.element.role} "${step.element.name}"`;
  const page = step.origin === undefined ? "" : ` on ${step.origin}${step.path ?? ""}`;
  const result =
    step.failure !== undefined
      ? ` — failed (${step.failure})`
      : step.changed === undefined
        ? ""
        : ` — ${step.changed}`;
  return `${step.operation}${element}${page}${result}`;
}

/**
 * The "Browser check" section a pull request body can carry, only when the
 * person chose it. Pictures cannot be uploaded into a body, so each capture
 * appears as the name of the file the person saved for it.
 *
 * Rationale: GitHub offers no way to put a picture into a pull request body
 * from here, and uploading to some other host would send a page's picture off
 * the machine. Naming the saved file leaves the person to drag it in.
 */
export function browserProofPullRequestSection(
  steps: ReadonlyArray<BrowserStep>,
  captures: ReadonlyArray<BrowserCapture>,
): string | undefined {
  if (steps.length === 0) return undefined;
  const lines = ["## Browser check", ""];
  const timeline = browserProofTimeline(steps, captures);
  for (const entry of timeline) {
    if (entry.kind === "step") {
      lines.push(`${entry.number}. ${escapeLine(browserStepLine(entry.step))}`);
    } else {
      lines.push(
        `   - Screenshot: ${browserProofScreenshotFileName(entry.fileNumber, entry.capture.mime)}`,
      );
    }
  }
  if (captures.length > 0) {
    lines.push(
      "",
      "Screenshots are not embedded. Drag the saved files of the same names into this description.",
    );
  }
  return lines.join("\n");
}

/**
 * A step line is a list item: a page cannot start a new block, a link, or
 * emphasis with its element names or paths. One pass over the characters, so
 * the work is linear in the line; the backslash is escaped with the rest so an
 * escape cannot be cancelled by the text before it.
 */
function escapeLine(line: string): string {
  let out = "";
  for (const char of line) {
    if (char === "\r" || char === "\n") out += " ";
    else if ("\\`*_[]<>~|&".includes(char)) out += `\\${char}`;
    else out += char;
  }
  return out;
}

/** The body with the section after it, separated by a blank line; nothing added when absent. */
export function bodyWithBrowserProof(body: string, section: string | undefined): string {
  if (section === undefined) return body;
  const trimmed = body.trimEnd();
  return trimmed.length === 0 ? section : `${trimmed}\n\n${section}`;
}
