import type {
  BrowserActionRequest,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserPresentationKind,
  BrowserThreadId,
} from "@octant/contracts/browser-automation";
import type { WindowId } from "@octant/contracts/shell";

export interface BrowserRuntimeObservation {
  readonly url?: string;
  readonly title?: string;
  readonly contentHash?: string;
  readonly extractedText?: string;
  readonly screenshotDataUrl?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export interface BrowserTargetInspection {
  readonly sensitive: boolean;
}

/**
 * One element the host resolved from a point in its own viewport, so a client
 * that only ever saw a picture can still name what the user pointed at.
 *
 * `bounds` is normalized to the viewport, so a caller can draw the same box the
 * host cropped without knowing the page's pixel size.
 */
export interface BrowserPointDescription {
  readonly selector: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly text?: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type BrowserPointObservation =
  | {
      readonly status: "described";
      readonly element: BrowserPointDescription;
      readonly cropDataUrl?: string;
      readonly url?: string;
      readonly title?: string;
    }
  | { readonly status: "no-element" };

/**
 * A navigation was refused because the page tried to move to an origin outside
 * the context allowlist (typically a redirect such as example.com →
 * www.example.com). Carries the blocked URL so the failure can tell the user
 * which origin to open instead of reporting a generic action failure.
 */
export class BrowserNavigationBlockedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`Navigation to ${url} is outside the browser context allowlist.`);
    this.name = "BrowserNavigationBlockedError";
    this.url = url;
  }
}

export interface BrowserRuntimePort {
  readonly available: () => Promise<boolean>;
  readonly createContext: (
    contextId: BrowserContextId,
    policy: BrowserContextPolicy,
    signal: AbortSignal,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
  ) => Promise<BrowserPresentationKind | void>;
  readonly inspectTarget: (
    contextId: BrowserContextId,
    selector: string,
    signal: AbortSignal,
  ) => Promise<BrowserTargetInspection>;
  readonly act: (
    contextId: BrowserContextId,
    request: BrowserActionRequest,
    signal: AbortSignal,
  ) => Promise<BrowserRuntimeObservation>;
  /**
   * Resolve the element under one normalized viewport point and cut a picture
   * of it. Optional: a runtime that cannot read its own page — a native view
   * Octant only presents — simply offers no pointed-at notes.
   */
  readonly describePoint?: (
    contextId: BrowserContextId,
    point: { readonly x: number; readonly y: number },
    signal: AbortSignal,
  ) => Promise<BrowserPointObservation>;
  readonly closeContext: (contextId: BrowserContextId) => Promise<void>;
  readonly closeAll: () => Promise<void>;
  readonly reconcile?: () => Promise<void>;
  readonly onProcessExit?: (
    listener: (contextIds?: ReadonlyArray<BrowserContextId>) => void,
  ) => () => void;
}
