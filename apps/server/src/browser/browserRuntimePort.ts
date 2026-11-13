import type {
  PersistentBrowserLeaseBinding,
  PersistentBrowserOwnerStatus,
  PersistentBrowserContextCreated,
  PersistentBrowserLeaseId,
} from "@octant/contracts/persistent-browser-owner";
import type { BrowserAccountProfileCreateResult } from "@octant/contracts/browser-profiles";
import type { BrowserTransferLimits } from "@octant/domain";
import type {
  OwnerBrowserNativeCommand,
  OwnerBrowserNativeResult,
} from "@octant/contracts/owner-browser";
import type {
  BrowserPageScriptNativeCommand,
  BrowserPageScriptPreparation,
} from "@octant/contracts/browser-page-script";
import type {
  HumanBrowserRequest,
  HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import type {
  BrowserProfileClearScope,
  ImportedCookie,
  StoredBrowserProfile,
} from "@octant/contracts/browser-profiles";
import type {
  BrowserActionRequest,
  BrowserContextId,
  BrowserDialogReport,
  BrowserDownloadReport,
  BrowserContextPolicy,
  BrowserEmulationReport,
  BrowserPresentationKind,
  BrowserRecordingTruncation,
  BrowserThreadId,
} from "@octant/contracts/browser-automation";
import type { WindowId } from "@octant/contracts/shell";
import type { BrowserPageAuditReading, BrowserPageSnapshotRef } from "@octant/domain";
import type {
  BrowserCredentialFillPreparation,
  BrowserCredentialNativeResult,
} from "@octant/contracts/browser-credential-use";

export interface BrowserRuntimeObservation {
  readonly url?: string;
  readonly title?: string;
  readonly contentHash?: string;
  readonly extractedText?: string;
  /** Only a snapshot action fills these: the outline, and what each ref names. */
  readonly snapshot?: string;
  readonly snapshotRefs?: ReadonlyArray<BrowserPageSnapshotRef>;
  readonly screenshotDataUrl?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Only a resize fills this: what the page reports about its device now. */
  readonly emulation?: BrowserEmulationReport;
  /** The page's own dialogs since the last action, and how each was answered. */
  readonly dialogs?: ReadonlyArray<BrowserDialogReport>;
  /** Only a tab action fills this: the context's tabs as they now stand. */
  readonly tabs?: ReadonlyArray<{
    readonly tabId: string;
    readonly url?: string;
    readonly title?: string;
    readonly active: boolean;
  }>;
  /** Only the observe-diagnostics action fills these; see the contract. */
  readonly consoleErrors?: ReadonlyArray<{
    readonly text: string;
    readonly url?: string;
    readonly seq?: number;
  }>;
  readonly failedRequests?: ReadonlyArray<{
    readonly url: string;
    readonly method?: string;
    readonly failure: string;
    readonly seq?: number;
  }>;
  readonly consoleWarnings?: ReadonlyArray<{
    readonly text: string;
    readonly url?: string;
    readonly seq?: number;
  }>;
  readonly httpErrors?: ReadonlyArray<{
    readonly url: string;
    readonly method?: string;
    readonly status: number;
    readonly seq?: number;
  }>;
  readonly diagnosticsCursor?: number;
  /** Only an audit action fills this: what the fixed reader measured, before the server shapes it. */
  readonly audit?: BrowserPageAuditReading;
  /** Downloads the page started while an action that allowed them ran. */
  readonly downloads?: ReadonlyArray<BrowserDownloadReport>;
  /** Only a `record-stop` fills this: the recording that ended; see the contract. */
  readonly recording?: BrowserRuntimeRecording;
}

/**
 * What a `record-stop` hands back. A recorded animation is an animated PNG as
 * a data URL, the same transport a screenshot takes; it is kept as a thread
 * capture and never handed to the model. `withheld` is a recording whose every
 * frame showed a page that held a credential field (or could not be checked),
 * and `empty` a page that painted nothing. A recording belongs to the tab it
 * started on: `url` and `title` are that tab's when the recording stopped,
 * whichever tab is in front now, and are absent where it had none.
 */
export type BrowserRuntimeRecording =
  | {
      readonly status: "recorded";
      readonly dataUrl: string;
      readonly frames: number;
      readonly durationMs: number;
      readonly truncated?: BrowserRecordingTruncation;
      readonly url?: string;
      readonly title?: string;
    }
  | { readonly status: "withheld" }
  | { readonly status: "empty" };

/**
 * This Browser cannot record its page: it has no screencast to take frames
 * from. The action did not run, and the agent is told so in words.
 */
export class BrowserRecordingUnavailableError extends Error {
  constructor() {
    super("This Browser cannot record the page.");
    this.name = "BrowserRecordingUnavailableError";
  }
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
export type BrowserPointDescription = Extract<
  import("@octant/contracts/product-feedback").ProductFeedbackPointObservation,
  { readonly status: "described" }
>["element"];

export type BrowserPointObservation =
  import("@octant/contracts/product-feedback").ProductFeedbackPointObservation;

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

/**
 * The element a snapshot ref named is no longer there, or is no longer the
 * element the snapshot described. The action did not run.
 */
export class BrowserTargetStaleError extends Error {
  constructor() {
    super("The element behind that ref changed since the snapshot.");
    this.name = "BrowserTargetStaleError";
  }
}

/**
 * A wait ran out its time before its conditions were met. The message says
 * which were not, so the agent knows what to wait for differently.
 */
export class BrowserWaitTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserWaitTimedOutError";
  }
}

/**
 * A page asked for a stored Browser profile and this runtime cannot hold one.
 * Only the desktop app's own Browser keeps a profile's store, so a runtime
 * without it refuses instead of opening a headless copy that would disagree
 * about who is signed in.
 */
export class BrowserProfileUnavailableError extends Error {
  constructor() {
    super("Signed-in pages open only in the Octant app's own Browser.");
    this.name = "BrowserProfileUnavailableError";
  }
}

/** The stores behind the Project and Personal profiles, kept by the desktop app. */
export interface BrowserProfileStorePort {
  readonly createAccount?: (label: string) => Promise<BrowserAccountProfileCreateResult>;
  readonly list: (includeSizes?: boolean) => Promise<
    ReadonlyArray<{
      readonly profile: StoredBrowserProfile;
      readonly sizeBytes: number;
      readonly label?: string;
    }>
  >;
  readonly clear: (profile: StoredBrowserProfile, scope: BrowserProfileClearScope) => Promise<void>;
  /**
   * Makes the extensions loaded in a profile's session exactly these: loads the
   * ones that are missing or changed and removes the rest. A Private page has no
   * session of this kind and never runs an extension.
   */
  readonly syncExtensions: (
    profile: StoredBrowserProfile,
    extensions: ReadonlyArray<{
      readonly id: string;
      readonly path: string;
      readonly contentHash: string;
    }>,
  ) => Promise<void>;
  /**
   * Puts cookies into a profile's store, one bounded batch at a time, and says
   * how many it kept. The cookies pass through and are retained nowhere.
   */
  readonly importCookies: (
    profile: StoredBrowserProfile,
    cookies: ReadonlyArray<ImportedCookie>,
  ) => Promise<{ readonly imported: number; readonly skipped: number }>;
}

/**
 * What a runtime is told to do to a page. It carries no authority: whoever
 * owns the context has already decided the action may run, and a runtime only
 * ever needed the action itself.
 */
export type BrowserRuntimeAction = Pick<BrowserActionRequest, "kind"> &
  Partial<
    Pick<
      BrowserActionRequest,
      | "target"
      | "value"
      | "point"
      | "deltaX"
      | "deltaY"
      | "include"
      | "destination"
      | "files"
      | "tabId"
      | "waitFor"
      | "viewport"
      | "deviceScaleFactor"
      | "mobile"
      | "touch"
      | "colorScheme"
      | "diagnosticsSince"
      | "diagnosticsWarnings"
      | "auditKind"
      | "dialog"
    >
  > & {
    /**
     * Set when `target` came from a snapshot ref: the page must still be at the
     * snapshot's address (as an observation reports it) and the element there
     * must still have this role and name, or the runtime refuses with
     * `BrowserTargetStaleError` before touching it.
     */
    readonly expected?: { readonly role: string; readonly name: string; readonly url: string };
    /**
     * Set only by the server, for an action of the agent tool while the
     * person's "Let agents download files" switch is on: a download the page
     * starts while this action runs is held for the agent. Absent, a download
     * is cancelled. It is not part of the action contract, so no route can set it.
     */
    readonly downloads?: "hold";
    /**
     * The person's limits for the downloads this action holds, set by the
     * server beside `downloads`. Absent, the runtime uses the defaults.
     */
    readonly downloadLimits?: BrowserTransferLimits;
    /** The same check for a `drag`'s drop target when it came from a ref. */
    readonly destinationExpected?: {
      readonly role: string;
      readonly name: string;
      readonly url: string;
    };
  };

export interface PersistentBrowserOwnerPort {
  readonly status: (signal?: AbortSignal) => Promise<PersistentBrowserOwnerStatus>;
  /** Called only from the authoritative local-person setting, never a tool or renderer owner input. */
  readonly configure: (
    enabled: boolean,
    signal?: AbortSignal,
  ) => Promise<PersistentBrowserOwnerStatus>;
  readonly createContext: (
    contextId: BrowserContextId,
    policy: BrowserContextPolicy,
    signal: AbortSignal,
    binding: PersistentBrowserLeaseBinding,
  ) => Promise<PersistentBrowserContextCreated>;
  readonly release: (leaseId: PersistentBrowserLeaseId) => Promise<"closed" | "unconfirmed">;
}

export interface BrowserRuntimePort {
  readonly persistentOwner?: PersistentBrowserOwnerPort | undefined;
  readonly ownerControl?: (
    command: OwnerBrowserNativeCommand,
    signal: AbortSignal,
  ) => Promise<OwnerBrowserNativeResult>;
  readonly runPageScript?: (
    command: BrowserPageScriptNativeCommand,
    signal: AbortSignal,
  ) => Promise<BrowserPageScriptPreparation>;
  readonly prepareCredentialFill?: (
    contextId: BrowserContextId,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
    origin: string,
  ) => Promise<BrowserCredentialFillPreparation>;
  readonly validateCredentialFill?: (
    contextId: BrowserContextId,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
    planId: string,
  ) => Promise<boolean>;
  readonly cancelCredentialFill?: (
    contextId: BrowserContextId,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
    planId: string,
  ) => Promise<BrowserCredentialNativeResult>;
  readonly submitCredentialFill?: (
    contextId: BrowserContextId,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
    planId: string,
    expiresAt: string,
  ) => Promise<BrowserCredentialNativeResult>;
  readonly humanPresentation?: (
    request: HumanBrowserRequest,
    windowId: WindowId,
    signal: AbortSignal,
  ) => Promise<HumanBrowserResult>;
  readonly available: () => Promise<boolean>;
  /**
   * Whether the desktop app's own Browser can hold a page right now. Absent on a
   * runtime that is headless only. A stored profile opens only where this is true.
   */
  readonly nativeAvailable?: () => Promise<boolean>;
  /** The stored profiles' stores; absent where no desktop app keeps them. */
  readonly profiles?: BrowserProfileStorePort | undefined;
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
    request: BrowserRuntimeAction,
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
    selectionId?: string,
  ) => Promise<BrowserPointObservation>;
  /**
   * Look at the page as it stands without acting on it: address, title, and
   * a picture when the page is not a credential form. A page the person
   * drives themselves records no action, so this is how its preview stays
   * current. Optional: a runtime that cannot picture its page offers none.
   */
  readonly peek?: (
    contextId: BrowserContextId,
    signal: AbortSignal,
  ) => Promise<BrowserRuntimeObservation>;
  /**
   * The absolute path of a download this context holds for the agent, in the
   * host's private download folder, or undefined if it holds none by that id.
   * Absent where a runtime holds no downloads.
   */
  readonly claimDownload?: (
    contextId: BrowserContextId,
    downloadId: string,
  ) => Promise<string | undefined>;
  /** Delete one held download. */
  readonly discardDownload?: (contextId: BrowserContextId, downloadId: string) => Promise<void>;
  readonly closeContext: (contextId: BrowserContextId) => Promise<void>;
  readonly closeAll: () => Promise<void>;
  readonly reconcile?: () => Promise<void>;
  readonly onProcessExit?: (
    listener: (contextIds?: ReadonlyArray<BrowserContextId>) => void,
  ) => () => void;
  /**
   * The person typed or clicked in a page of their own screen. Only a runtime
   * that shows the person the page itself can say so; a headless page reaches
   * the person through relayed actions, which the service already knows of.
   */
  readonly onPersonInput?: (listener: (contextId: BrowserContextId) => void) => () => void;
}
