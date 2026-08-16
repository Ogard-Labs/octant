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
  readonly closeContext: (contextId: BrowserContextId) => Promise<void>;
  readonly closeAll: () => Promise<void>;
  readonly reconcile?: () => Promise<void>;
  readonly onProcessExit?: (
    listener: (contextIds?: ReadonlyArray<BrowserContextId>) => void,
  ) => () => void;
}
