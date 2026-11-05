import type { BrowserActionKind, BrowserCapture, ThreadExportAttachment } from "@octant/contracts";
import {
  MAX_BROWSER_CAPTURES_PER_THREAD,
  MAX_BROWSER_RECORDINGS_PER_THREAD,
} from "@octant/contracts";
import { imageFileExtension } from "./imageGenerationInvocationPolicy";

/** Who asked for the screenshot: the model through the tool, or the person in the pane. */
export type BrowserCaptureTaker = "agent" | "person";

/**
 * Which browser actions leave a capture behind. An explicit `screenshot`
 * keeps one, and so does the `record-stop` that ends a recording the agent
 * asked for: every other action may also yield a picture for the model, and
 * keeping those would fill the thread's allowance with page states nobody
 * asked to remember. A caller that does not say who asked keeps nothing, so a
 * new call site is silent until it opts in. Only the agent records.
 */
export function browserCaptureTaker(
  kind: BrowserActionKind,
  takenBy: BrowserCaptureTaker | undefined,
): BrowserCaptureTaker | undefined {
  if (kind === "record-stop") return takenBy === "agent" ? takenBy : undefined;
  return kind === "screenshot" ? takenBy : undefined;
}

/** The page origin a capture is recorded under, or nothing when the page has no web origin. */
export function browserCapturePageOrigin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newest captures a thread keeps, by journal order. A thread's captures are
 * one aggregate whose versions rise with each capture, so retention is a
 * function of the head version alone: the journal decides what survives and
 * deleting bytes is only cleanup that can be repeated or finished after a crash.
 */
export function browserCaptureRetention(
  headVersion: number,
  limit: number = MAX_BROWSER_CAPTURES_PER_THREAD,
): { readonly firstRetainedVersion: number } {
  return { firstRetainedVersion: Math.max(1, headVersion - limit + 1) };
}

/**
 * The captures a thread keeps out of its retained window (newest first): every
 * screenshot, and only the newest `MAX_BROWSER_RECORDINGS_PER_THREAD`
 * recordings. Like the window itself this is a rule over the journal, so a
 * listing, a read, an export, and a recovery pass all apply it the same way;
 * an older recording is gone the moment a newer one takes its place, and its
 * bytes are only cleanup. A recording never pushes out a screenshot.
 */
export function browserRetainedCaptures(
  window: ReadonlyArray<BrowserCapture>,
  maxRecordings: number = MAX_BROWSER_RECORDINGS_PER_THREAD,
): ReadonlyArray<BrowserCapture> {
  let recordings = 0;
  return window.filter((capture) => {
    if (capture.recording === undefined) return true;
    recordings += 1;
    return recordings <= maxRecordings;
  });
}

/**
 * A thread's retained captures as export attachments, in the order given.
 * Bytes stay omitted, as for generated images; the cut carries identity, media
 * type, size, and the page the picture came from. The file name comes from the
 * capture id, never from the page title or URL, so a page cannot name a file.
 */
export function browserCaptureExportAttachments(
  captures: ReadonlyArray<BrowserCapture>,
): ReadonlyArray<ThreadExportAttachment> {
  return captures.map((capture) => ({
    displayName: `browser-capture-${String(capture.captureId)}.${imageFileExtension(capture.mime)}`,
    mediaType: capture.mime,
    byteLength: capture.size,
    status: "finalized",
    capture: {
      captureId: capture.captureId,
      origin: capture.origin,
      url: capture.url,
      ...(capture.title === undefined ? {} : { title: capture.title }),
      capturedAt: capture.capturedAt,
    },
  }));
}
