import type { BrowserActionKind } from "@octant/contracts";
import { MAX_BROWSER_CAPTURES_PER_THREAD } from "@octant/contracts";

/** Who asked for the screenshot: the model through the tool, or the person in the pane. */
export type BrowserCaptureTaker = "agent" | "person";

/**
 * Which browser actions leave a capture behind. Only an explicit `screenshot`
 * keeps one: every other action also yields a picture for the model, and
 * keeping those would fill the thread's allowance with page states nobody
 * asked to remember. A caller that does not say who asked keeps nothing, so a
 * new call site is silent until it opts in.
 */
export function browserCaptureTaker(
  kind: BrowserActionKind,
  takenBy: BrowserCaptureTaker | undefined,
): BrowserCaptureTaker | undefined {
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
