import {
  MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST,
  MAX_PAIRED_BROWSER_EVENTS_PER_SECOND,
  MAX_PAIRED_BROWSER_LEASES_PER_HOST,
  MAX_PAIRED_BROWSER_TEXT_CHARS_PER_MINUTE,
  type PairedBrowserInput,
  type PairedBrowserKeyModifiers,
  type PairedBrowserRefusalReason,
  type PairedBrowserTarget,
} from "@octant/contracts/paired-browser-control";
import type { PrincipalKind } from "./remoteAccessPolicy";

export type PairedBrowserPolicyDecision =
  | { readonly status: "allowed" }
  | {
      readonly status: "refused";
      readonly reason: PairedBrowserRefusalReason;
      readonly retryAfterSeconds?: number;
    };

export interface PairedBrowserAdmissionInput {
  readonly principalKind: PrincipalKind;
  readonly isAgentGrant?: boolean;
  readonly pagePresent: boolean;
  readonly authorityCurrent: boolean;
  readonly pageHeldByAnother: boolean;
  readonly deviceHoldsAnotherPage: boolean;
  readonly activeHostLeaseCount: number;
}

/**
 * Only a device the host's own person paired (`person-paired-device`) may open
 * or drive a remote Browser lease. Hub-introduced devices, agent grants, and
 * unauthenticated callers are refused `remote-control-not-person` before any
 * page state is touched.
 */
export function decidePairedBrowserPrincipal(input: {
  readonly principalKind: PrincipalKind;
  readonly isAgentGrant?: boolean;
}): PairedBrowserPolicyDecision {
  if (input.isAgentGrant === true || input.principalKind !== "person-paired-device") {
    return { status: "refused", reason: "remote-control-not-person" };
  }
  return { status: "allowed" };
}

export function decidePairedBrowserTakeOver(
  input: PairedBrowserAdmissionInput,
): PairedBrowserPolicyDecision {
  const principal = decidePairedBrowserPrincipal(input);
  if (principal.status === "refused") return principal;
  if (!input.pagePresent) return { status: "refused", reason: "page-not-here" };
  if (!input.authorityCurrent) return { status: "refused", reason: "authority-ended" };
  if (input.pageHeldByAnother || input.deviceHoldsAnotherPage) {
    return { status: "refused", reason: "browser-page-held-elsewhere" };
  }
  if (input.activeHostLeaseCount >= MAX_PAIRED_BROWSER_LEASES_PER_HOST) {
    return { status: "refused", reason: "rate-limited", retryAfterSeconds: 5 };
  }
  return { status: "allowed" };
}

export function samePairedBrowserTarget(a: PairedBrowserTarget, b: PairedBrowserTarget): boolean {
  return (
    String(a.threadId) === String(b.threadId) &&
    String(a.contextId) === String(b.contextId) &&
    a.tabId === b.tabId &&
    a.documentVersion === b.documentVersion &&
    a.profileKind === b.profileKind &&
    a.originPolicyVersion === b.originPolicyVersion
  );
}

/**
 * Host window and Octant shell shortcuts (quit, close window, devtools,
 * address bar, command palette, sidebar, dock, composer focus, Settings) are
 * never forwarded from a paired device into the desktop page.
 */
export function isForbiddenPairedBrowserKey(input: {
  readonly key: string;
  readonly code: string;
  readonly modifiers?: PairedBrowserKeyModifiers | undefined;
}): boolean {
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const meta = input.modifiers?.meta === true;
  const control = input.modifiers?.control === true;
  const alt = input.modifiers?.alt === true;
  const shift = input.modifiers?.shift === true;
  const primary = meta || control;

  if (key === "F12" || input.code === "F12") return true;
  if (control && !meta && !alt && !shift && key === "Escape") return true;
  if (primary && !alt && !shift && (key === "q" || key === "w" || key === "l" || key === ",")) {
    return true;
  }
  if (primary && !alt && !shift && (key === "k" || key === "\\")) return true;
  if (primary && shift && !alt && (key === "j" || key === "i")) return true;
  if (meta && alt && !control && (key === "i" || key === "j")) return true;
  return false;
}

export function countPairedBrowserTypedChars(events: ReadonlyArray<PairedBrowserInput>): number {
  let count = 0;
  for (const event of events) {
    if (event.kind === "text") {
      count += event.text.length;
    } else if (
      event.kind === "composition" &&
      (event.phase === "update" || event.phase === "commit") &&
      event.text !== undefined
    ) {
      count += event.text.length;
    }
  }
  return count;
}

export interface PairedBrowserRateWindow {
  readonly eventsInLastSecond: number;
  readonly charsInLastMinute: number;
}

export function evaluatePairedBrowserInputRate(input: {
  readonly events: ReadonlyArray<PairedBrowserInput>;
  readonly window: PairedBrowserRateWindow;
}): PairedBrowserPolicyDecision {
  if (
    input.events.length === 0 ||
    input.events.length > MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST ||
    input.window.eventsInLastSecond + input.events.length > MAX_PAIRED_BROWSER_EVENTS_PER_SECOND
  ) {
    return { status: "refused", reason: "rate-limited", retryAfterSeconds: 1 };
  }
  const typedChars = countPairedBrowserTypedChars(input.events);
  if (
    typedChars > 0 &&
    input.window.charsInLastMinute + typedChars > MAX_PAIRED_BROWSER_TEXT_CHARS_PER_MINUTE
  ) {
    return { status: "refused", reason: "rate-limited", retryAfterSeconds: 5 };
  }
  return { status: "allowed" };
}

export function evaluatePairedBrowserSequence(input: {
  readonly sequence: number;
  readonly lastAcceptedSequence: number;
}): PairedBrowserPolicyDecision {
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= input.lastAcceptedSequence) {
    return { status: "refused", reason: "stale-frame" };
  }
  return { status: "allowed" };
}

/**
 * Pointer and scroll events carry the frame they were aimed at. Any pointer
 * event aimed at a frame older than the page's last navigation, tab change, or
 * viewport change is dropped as `stale-frame`.
 */
export function evaluatePairedBrowserFrameTarget(input: {
  readonly events: ReadonlyArray<PairedBrowserInput>;
  readonly minValidFrameId: number;
  readonly latestFrameId: number;
}): PairedBrowserPolicyDecision {
  for (const event of input.events) {
    if (
      event.kind === "tap" ||
      event.kind === "long-press" ||
      event.kind === "drag" ||
      event.kind === "scroll"
    ) {
      if (
        input.latestFrameId === 0 ||
        event.frameId < input.minValidFrameId ||
        event.frameId > input.latestFrameId
      ) {
        return { status: "refused", reason: "stale-frame" };
      }
    }
  }
  return { status: "allowed" };
}
