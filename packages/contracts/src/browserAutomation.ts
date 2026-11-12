import { Schema } from "effect";
import { CorrelationId, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { ToolActionAuthority, ToolActionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
export const MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS = 54 * 1024;
/**
 * How many pages one browsing context may hold open at once.
 *
 * The ceiling is a property of the host, not a preference of whoever opened the
 * context, so every context is created with it and the number of pages actually
 * open is the person's to decide. Tabs of a context share its session and its
 * origin approval; opening one is a user action and reaches the page through
 * the same navigation admission as the first.
 */
export const MAX_BROWSER_TABS_PER_CONTEXT = 8;

/**
 * The entry that stands for every http and https site. In a context's
 * `allowedOrigins` it is the Private page an agent opened at Full access,
 * which needs no site approval and may navigate across origins; the host
 * admits it from no other caller and never beside a stored profile. As the
 * `origin` of a remembered profile site it is the person's "Allow all sites
 * in this profile" answer. `*` is not an origin a URL can have, so it never
 * collides with a real site.
 */
export const ANY_BROWSER_ORIGIN = "*";
/** How many contexts one thread inspect may name. Stopping windows can pile up. */
export const MAX_BROWSER_THREAD_CONTEXTS = 8;

/**
 * Bounds for the diagnostic observations a page yields. A page can log without
 * limit and a broken subresource can fail on every request, so both the number
 * of entries and the length of each one are capped the way every other
 * browser-observation field is: evidence the agent can act on, not a transcript
 * of everything the page did.
 */
export const MAX_BROWSER_DIAGNOSTIC_ENTRIES = 32;
export const MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS = 2_048;

export const BrowserContextId = brandedUuid("BrowserContextId");
export type BrowserContextId = typeof BrowserContextId.Type;
export const BrowserCaptureId = brandedUuid("BrowserCaptureId");
export type BrowserCaptureId = typeof BrowserCaptureId.Type;
export const BrowserThreadId = brandedUuid("BrowserThreadId");
export type BrowserThreadId = typeof BrowserThreadId.Type;

/**
 * `existing-profile` was a mode that would have opened the person's everyday
 * browser profile. It is retired: the schema no longer decodes it, so no caller
 * can ask for it. Reading cookies out of another browser is a separate, explicit
 * import into an Octant profile, never a mode a page opens in.
 */
export const BrowserProfileMode = Schema.Literal("isolated");
export type BrowserProfileMode = typeof BrowserProfileMode.Type;

/**
 * The store a Browser page keeps its cookies and site data in.
 *
 * Private is in memory and belongs to one browsing context. A Project profile
 * is on disk and shared by every page of one Work or Code Project. The
 * Personal profile is on disk and shared by every page that chooses it. Chat
 * has no Browser, so no profile names a Chat Project.
 */
export const BrowserAccountProfileId = Schema.UUID.pipe(Schema.brand("BrowserAccountProfileId"));
export type BrowserAccountProfileId = typeof BrowserAccountProfileId.Type;
export const AccountBrowserProfile = Schema.Struct({
  kind: Schema.Literal("account"),
  profileId: BrowserAccountProfileId,
}).annotations(strict);
export type AccountBrowserProfile = typeof AccountBrowserProfile.Type;
export const decodeBrowserAccountProfileId = Schema.decodeUnknownSync(BrowserAccountProfileId);

export const BrowserProfile = Schema.Union(
  AccountBrowserProfile,
  Schema.Struct({ kind: Schema.Literal("private") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("personal") }).annotations(strict),
);
export type BrowserProfile = typeof BrowserProfile.Type;

/**
 * Why the host would not put a page in a profile. Each is a value the pane
 * shows in words, never a silent no-op: `profile-not-local` is a paired device,
 * `profile-needs-a-person` is a routine, subagent, or terminal grant, and
 * `profile-unavailable` is a Project that is archived or has its mode off, a
 * host with no desktop Browser, or a store that is locked.
 */
export const BrowserProfileRefusalReason = Schema.Literal(
  "profile-not-local",
  "profile-needs-a-person",
  "profile-unavailable",
);
export type BrowserProfileRefusalReason = typeof BrowserProfileRefusalReason.Type;

export const BrowserContextPolicy = Schema.Struct({
  profileMode: BrowserProfileMode,
  /**
   * Where the page keeps its site data. Absent means Private, so a policy
   * written before profiles existed keeps its isolated, ephemeral context.
   */
  profile: Schema.optional(BrowserProfile),
  allowedOrigins: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  credentialFieldProtection: Schema.Boolean,
  maxConcurrentTabs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(16)),
  /** Idle interval after activation; authorized work renews it, passive previews do not. */
  sessionTimeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(3_600_000)),
  /**
   * Accept this context's own localhost certificate. A dev server on
   * HTTPS presents a self-signed localhost certificate, and the design allows
   * the isolated tab opened for it to accept that one certificate. The host
   * refuses the flag unless every allowed origin is a loopback HTTPS origin, so
   * acceptance can never reach beyond the single local server this context was
   * created for, and Octant still installs no trust root.
   */
  acceptsLocalCertificate: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type BrowserContextPolicy = typeof BrowserContextPolicy.Type;

export const BrowserContextState = Schema.Literal(
  "creating",
  "active",
  "stopping",
  "stopped",
  "expired",
  "failed",
);
export type BrowserContextState = typeof BrowserContextState.Type;

export const BrowserPresentationKind = Schema.Literal("native-live", "headless");
export type BrowserPresentationKind = typeof BrowserPresentationKind.Type;

export const BrowserContextRecord = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  policy: BrowserContextPolicy,
  presentation: Schema.optional(BrowserPresentationKind),
  state: BrowserContextState,
  createdAt: UtcTimestamp,
  stoppedAt: Schema.optional(UtcTimestamp),
  stopReason: Schema.optional(
    Schema.Literal("user-requested", "timeout", "authority-revoked", "shutdown", "error"),
  ),
}).annotations(strict);
export type BrowserContextRecord = typeof BrowserContextRecord.Type;

export const BrowserActionKind = Schema.Literal(
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "screenshot",
  "extract-text",
  "wait",
  "close-tab",
  "observe-diagnostics",
  "snapshot",
  "hover",
  "select",
  "drag",
  "upload",
  "tab-list",
  "tab-open",
  "tab-select",
  "tab-close",
  "resize",
  "audit",
  // Only the agent tool starts and stops a recording, around one call it
  // asked to record; see the recording bounds below.
  "record-start",
  "record-stop",
);
export type BrowserActionKind = typeof BrowserActionKind.Type;

export const BrowserViewportPoint = Schema.Struct({
  x: Schema.Number.pipe(Schema.between(0, 1)),
  y: Schema.Number.pipe(Schema.between(0, 1)),
}).annotations(strict);
export type BrowserViewportPoint = typeof BrowserViewportPoint.Type;

export const BrowserViewportSize = Schema.Struct({
  width: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8192)),
  height: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8192)),
}).annotations(strict);
export type BrowserViewportSize = typeof BrowserViewportSize.Type;

/**
 * A reference to one element of the page's latest snapshot. The host keeps
 * what each reference names and resolves it itself, so a caller can neither
 * point a reference at an element the snapshot did not list nor reuse one after
 * the page has changed under it.
 */
export const BrowserElementRef = Schema.String.pipe(Schema.pattern(/^e[1-9][0-9]{0,3}$/));
export type BrowserElementRef = typeof BrowserElementRef.Type;

/**
 * What an action may bring back beyond the page's address, title, and what
 * changed. Each costs the model tokens, so an action returns none of them
 * unless the call asks.
 */
export const BrowserObservationPart = Schema.Literal("text", "screenshot", "snapshot");
export type BrowserObservationPart = typeof BrowserObservationPart.Type;

/** One tab of a browsing context, named for the agent as `t1`, `t2`, ... */
export const BrowserTabId = Schema.String.pipe(Schema.pattern(/^t[1-9][0-9]{0,3}$/));
export type BrowserTabId = typeof BrowserTabId.Type;

/** How many files one upload may send. */
export const MAX_BROWSER_UPLOAD_FILES = 5;
/** The largest file an upload may send. */
export const MAX_BROWSER_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

/** How many downloads one browsing context holds at once; the oldest is discarded. */
export const MAX_BROWSER_HELD_DOWNLOADS = 5;

/** The longest any wait may last; a wait names its own limit up to this. */
export const MAX_BROWSER_WAIT_MS = 30_000;
/** How long a wait lasts when it names no limit. */
export const DEFAULT_BROWSER_WAIT_MS = 10_000;

/**
 * One thing a `wait` waits for. Text is the page's visible text, not a field's
 * value; an address matches when it contains `contains`; an element is named
 * by a CSS selector the host resolved from a selector or a snapshot ref.
 */
export const BrowserWaitCondition = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
    present: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("url"),
    contains: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("load"),
    state: Schema.Literal("domcontentloaded", "load"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("element"),
    target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
    ref: Schema.optional(BrowserElementRef),
    state: Schema.Literal("attached", "detached", "visible", "hidden", "enabled", "disabled"),
  }).annotations(strict),
);
export type BrowserWaitCondition = typeof BrowserWaitCondition.Type;

export const BrowserWaitFor = Schema.Struct({
  conditions: Schema.Array(BrowserWaitCondition).pipe(Schema.minItems(1), Schema.maxItems(5)),
  match: Schema.Literal("all", "any"),
  timeoutMs: Schema.optional(
    Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(MAX_BROWSER_WAIT_MS)),
  ),
}).annotations(strict);
export type BrowserWaitFor = typeof BrowserWaitFor.Type;

/** The bounds a `resize` keeps the agent's page inside. */
export const BROWSER_RESIZE_BOUNDS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

/**
 * The device sizes a `resize` names. Each one fixes a size, a pixel ratio, and
 * a mobile flag; a mobile device also turns touch on unless the call says
 * otherwise. The set is small on purpose: the model picks a name, not numbers.
 */
export const BROWSER_DEVICE_PRESETS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  "phone-landscape": { width: 844, height: 390, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
} as const;
export type BrowserDevicePreset = keyof typeof BROWSER_DEVICE_PRESETS;

/** `default` returns the page to the color scheme its own browser reports. */
export const BrowserColorScheme = Schema.Literal("light", "dark", "default");
export type BrowserColorScheme = typeof BrowserColorScheme.Type;

/**
 * What the page itself reports after a `resize`, measured in the page rather
 * than assumed from the request, so the answer says what the page now sees.
 */
export const BrowserEmulationReport = Schema.Struct({
  width: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8192)),
  height: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8192)),
  deviceScaleFactor: Schema.Number.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8)),
  touch: Schema.Boolean,
  colorScheme: Schema.Literal("light", "dark"),
}).annotations(strict);
export type BrowserEmulationReport = typeof BrowserEmulationReport.Type;

/** How a page's own dialog was answered; see the fixed policy in the spec. */
export const BrowserDialogReport = Schema.Struct({
  type: Schema.Literal("alert", "confirm", "prompt", "beforeunload"),
  message: Schema.String.pipe(Schema.maxLength(512)),
  answer: Schema.Literal("accepted", "dismissed"),
}).annotations(strict);
export type BrowserDialogReport = typeof BrowserDialogReport.Type;

/**
 * A download a page started while the agent drove it, as the action's answer
 * reports it. A held download is in a private folder of the host, not in the
 * workspace; the agent saves it with `download-save` naming `downloadId`, and
 * the person is asked then. A refused one was cancelled and holds nothing.
 */
const DownloadHttpsOrigin = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
);
/** Host-observed complete redirect chain, reduced to HTTPS origins only. */
export const BrowserDownloadSource = Schema.Struct({
  kind: Schema.Literal("https-origin-chain"),
  origins: Schema.Array(DownloadHttpsOrigin).pipe(Schema.minItems(1), Schema.maxItems(32)),
}).annotations(strict);
export type BrowserDownloadSource = typeof BrowserDownloadSource.Type;

export const BrowserDownloadReport = Schema.Union(
  Schema.Struct({
    state: Schema.Literal("held"),
    downloadId: Schema.String.pipe(Schema.pattern(/^d[1-9][0-9]{0,5}$/)),
    name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
    sizeBytes: Schema.Int.pipe(Schema.nonNegative()),
    /** Sniffed from the file's first bytes, never from the page's header. */
    mediaType: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
    source: Schema.optional(BrowserDownloadSource),
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("refused"),
    name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
    reason: Schema.Literal("too-large", "unfinished", "failed"),
  }).annotations(strict),
);
export type BrowserDownloadReport = typeof BrowserDownloadReport.Type;

/** The longest page outline an observation carries, in characters. */
export const MAX_BROWSER_SNAPSHOT_OUTLINE_CHARACTERS = 32 * 1024;

/**
 * Bounds for a page audit's answer. A page can fail one rule on every element
 * it has, so findings are capped per rule and in total, and the counts say
 * how many there were: evidence the agent can act on, not a listing of the page.
 */
export const MAX_BROWSER_AUDIT_FINDINGS = 25;
export const MAX_BROWSER_AUDIT_FINDINGS_PER_RULE = 10;
export const MAX_BROWSER_AUDIT_LARGEST_RESOURCES = 5;

/** Which audit an `audit` reads: the page's accessibility, or its loading and responsiveness. */
export const BrowserAuditKind = Schema.Literal("accessibility", "performance");
export type BrowserAuditKind = typeof BrowserAuditKind.Type;

/** The accessibility checks an audit runs; each is described in the Browser spec. */
export const BrowserAccessibilityRule = Schema.Literal(
  "image-alt",
  "button-name",
  "link-name",
  "field-name",
  "document-title",
  "document-lang",
  "heading-order",
  "duplicate-id-aria",
  "color-contrast",
  "focusable-hidden",
  "target-size",
);
export type BrowserAccessibilityRule = typeof BrowserAccessibilityRule.Type;

const auditText = (maximum: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const auditCount = Schema.Int.pipe(Schema.nonNegative());

/**
 * One accessibility problem on the page. `ref` names the element when the
 * latest snapshot gave it one; otherwise `selector` does. The message is the
 * host's own words; `name` and `text` are what the snapshot would show.
 */
export const BrowserAccessibilityFinding = Schema.Struct({
  rule: BrowserAccessibilityRule,
  severity: Schema.Literal("serious", "moderate"),
  message: auditText(300),
  ref: Schema.optional(BrowserElementRef),
  selector: Schema.optional(auditText(256)),
  role: Schema.optional(auditText(64)),
  name: Schema.optional(auditText(120)),
  text: Schema.optional(auditText(80)),
}).annotations(strict);
export type BrowserAccessibilityFinding = typeof BrowserAccessibilityFinding.Type;

export const BrowserAccessibilityAudit = Schema.Struct({
  kind: Schema.Literal("accessibility"),
  findings: Schema.Array(BrowserAccessibilityFinding).pipe(
    Schema.maxItems(MAX_BROWSER_AUDIT_FINDINGS),
  ),
  /** How many each rule found, listed or not. A rule that found nothing is absent. */
  found: Schema.Array(
    Schema.Struct({
      rule: BrowserAccessibilityRule,
      count: Schema.Int.pipe(Schema.positive()),
    }).annotations(strict),
  ).pipe(Schema.maxItems(BrowserAccessibilityRule.literals.length)),
  /** The rules that did not run on this page, and why. */
  notRun: Schema.Array(
    Schema.Struct({ rule: BrowserAccessibilityRule, reason: auditText(300) }).annotations(strict),
  ).pipe(Schema.maxItems(BrowserAccessibilityRule.literals.length)),
  /** Text whose contrast was not judged: over an image, a gradient, or a layered element. */
  contrastNotMeasured: auditCount,
  /** Frames on the page; an audit reads the top document and its open shadow roots only. */
  framesNotAudited: auditCount,
  /** More findings than were listed, or a page larger than one audit reads. */
  truncated: Schema.Boolean,
}).annotations(strict);
export type BrowserAccessibilityAudit = typeof BrowserAccessibilityAudit.Type;

/** The web vitals boundaries a measured value falls between. */
export const BrowserAuditRating = Schema.Literal("good", "needs-improvement", "poor");
export type BrowserAuditRating = typeof BrowserAuditRating.Type;

export const BrowserPerformanceMetricName = Schema.Literal("ttfb", "fcp", "lcp", "cls", "tbt");
export type BrowserPerformanceMetricName = typeof BrowserPerformanceMetricName.Type;

export const BrowserResourceType = Schema.Literal(
  "document",
  "script",
  "stylesheet",
  "image",
  "font",
  "fetch",
  "media",
  "other",
);
export type BrowserResourceType = typeof BrowserResourceType.Type;

export const BrowserPerformanceAudit = Schema.Struct({
  kind: Schema.Literal("performance"),
  /**
   * How long ago this document began loading. Every timing is the browser's
   * own record of that load; a fresh load needs a navigation first.
   */
  documentAgeMs: auditCount,
  navigationType: Schema.optional(
    Schema.Literal("navigate", "reload", "back_forward", "prerender"),
  ),
  domContentLoadedMs: Schema.optional(auditCount),
  loadMs: Schema.optional(auditCount),
  vitals: Schema.Array(
    Schema.Struct({
      metric: BrowserPerformanceMetricName,
      /** Milliseconds, except `cls`, which is a unitless score. */
      value: Schema.Number.pipe(Schema.nonNegative()),
      rating: BrowserAuditRating,
    }).annotations(strict),
  ).pipe(Schema.maxItems(BrowserPerformanceMetricName.literals.length)),
  /** The element the largest contentful paint drew. */
  lcpElement: Schema.optional(
    Schema.Struct({
      ref: Schema.optional(BrowserElementRef),
      selector: Schema.optional(auditText(256)),
      url: Schema.optional(auditText(1024)),
    }).annotations(strict),
  ),
  longTasks: Schema.optional(
    Schema.Struct({ count: auditCount, totalMs: auditCount, longestMs: auditCount }).annotations(
      strict,
    ),
  ),
  requests: Schema.Struct({
    count: auditCount,
    transferBytes: auditCount,
    byType: Schema.Array(
      Schema.Struct({
        type: BrowserResourceType,
        count: auditCount,
        transferBytes: auditCount,
      }).annotations(strict),
    ).pipe(Schema.maxItems(BrowserResourceType.literals.length)),
    /** The browser keeps a bounded list of requests; more may have loaded. */
    listFull: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  largestResources: Schema.Array(
    Schema.Struct({
      url: auditText(1024),
      type: BrowserResourceType,
      transferBytes: auditCount,
    }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_BROWSER_AUDIT_LARGEST_RESOURCES)),
  /** What the page holds now, from the browser's own counters. */
  page: Schema.optional(
    Schema.Struct({
      domNodes: Schema.optional(auditCount),
      jsHeapUsedBytes: Schema.optional(auditCount),
      jsEventListeners: Schema.optional(auditCount),
    }).annotations(strict),
  ),
  /** What this audit could not measure, and why. */
  notMeasured: Schema.Array(
    Schema.Struct({ metric: auditText(32), reason: auditText(300) }).annotations(strict),
  ).pipe(Schema.maxItems(12)),
}).annotations(strict);
export type BrowserPerformanceAudit = typeof BrowserPerformanceAudit.Type;

export const BrowserPageAudit = Schema.Union(BrowserAccessibilityAudit, BrowserPerformanceAudit);
export type BrowserPageAudit = typeof BrowserPageAudit.Type;

export const BrowserActionRequest = Schema.Struct({
  actionId: ToolActionId,
  contextId: BrowserContextId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: BrowserActionKind,
  target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  /** An element of the latest snapshot, in place of a CSS selector `target`. */
  ref: Schema.optional(BrowserElementRef),
  /** Where a `drag` drops: a CSS selector, or a ref of the latest snapshot. */
  destination: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  destinationRef: Schema.optional(BrowserElementRef),
  /**
   * The files an `upload` sends, relative to the thread's workspace. They are
   * named here for the record only: the host resolves them itself, and a
   * caller cannot hand a runtime a path.
   */
  files: Schema.optional(
    Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_BROWSER_UPLOAD_FILES),
    ),
  ),
  /** The tab a `tab-select` or `tab-close` names. */
  tabId: Schema.optional(BrowserTabId),
  /** What a `wait` waits for, beyond a bare `target`. */
  waitFor: Schema.optional(BrowserWaitFor),
  /** The size a `resize` sets; absent, the page returns to its own size. */
  viewport: Schema.optional(BrowserViewportSize),
  /**
   * With a `viewport`, the pixel ratio and mobile flag of the device it stands
   * for; absent, 1 and false. Without a `viewport` they are not allowed.
   */
  deviceScaleFactor: Schema.optional(
    Schema.Number.pipe(Schema.positive(), Schema.lessThanOrEqualTo(4)),
  ),
  mobile: Schema.optional(Schema.Boolean),
  /** Touch on or off for the page; absent, the page keeps what it has. */
  touch: Schema.optional(Schema.Boolean),
  /** The color scheme the page prefers; absent, the page keeps what it has. */
  colorScheme: Schema.optional(BrowserColorScheme),
  /** For a diagnostics read: only entries after this cursor. Absent, all kept entries. */
  diagnosticsSince: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  /** For a diagnostics read: include console warnings. */
  diagnosticsWarnings: Schema.optional(Schema.Boolean),
  /** Which audit an `audit` action reads. */
  auditKind: Schema.optional(BrowserAuditKind),
  value: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536))),
  point: Schema.optional(BrowserViewportPoint),
  deltaX: Schema.optional(Schema.Number.pipe(Schema.between(-2000, 2000))),
  deltaY: Schema.optional(Schema.Number.pipe(Schema.between(-2000, 2000))),
  expectedObservationRevision: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  /** Parts of the page to bring back after the action, besides what changed. */
  include: Schema.optional(Schema.Array(BrowserObservationPart).pipe(Schema.maxItems(3))),
}).annotations(strict);
export type BrowserActionRequest = typeof BrowserActionRequest.Type;

/**
 * Where an entry sits in the context's diagnostics, counted from 1. A read
 * names the last one it saw as `since` and gets only what came after, so two
 * readers never clear each other's entries.
 */
const DiagnosticSeq = Schema.optional(Schema.Int.pipe(Schema.positive()));

/** One error or warning the page's own console reported, bounded like every other read. */
export const BrowserConsoleError = Schema.Struct({
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS)),
  /** The page's URL when the error was logged, so a navigation is not misread. */
  url: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  seq: DiagnosticSeq,
}).annotations(strict);
export type BrowserConsoleError = typeof BrowserConsoleError.Type;

/**
 * One request the page made and did not complete.
 *
 * The method and the failure are the actionable part; the URL is capped to the
 * same length as a navigation target because a page can put anything in a path.
 */
export const BrowserFailedRequest = Schema.Struct({
  url: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  method: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(16))),
  failure: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS),
  ),
  seq: DiagnosticSeq,
}).annotations(strict);
export type BrowserFailedRequest = typeof BrowserFailedRequest.Type;

/**
 * One request that completed with a 4xx or 5xx status. The address, method,
 * and status only: no body and no header is ever read or kept.
 */
export const BrowserHttpError = Schema.Struct({
  url: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  method: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(16))),
  status: Schema.Int.pipe(Schema.between(400, 599)),
  seq: DiagnosticSeq,
}).annotations(strict);
export type BrowserHttpError = typeof BrowserHttpError.Type;

/**
 * What happened to a screenshot the host was asked to keep as a thread capture.
 * Keeping is best effort: the screenshot itself succeeds either way, and a
 * capture that was not kept says why so the refusal is observable instead of
 * a picture that quietly never appears.
 */
export const BrowserCaptureNotKeptReason = Schema.Literal(
  "too-large",
  "not-an-image",
  "no-page-origin",
  // The runtime produced no picture at all, as it does on its own judgement
  // when a frame on the page holds a credential field.
  "no-picture",
  "unavailable",
);
export type BrowserCaptureNotKeptReason = typeof BrowserCaptureNotKeptReason.Type;

/**
 * The bounds of one Browser recording: a short moving picture of the agent's
 * page while one call it asked to record runs. Frames are sampled at most
 * every `BROWSER_RECORDING_FRAME_INTERVAL_MS`, scaled to fit
 * `MAX_BROWSER_RECORDING_EDGE` on their longer side, and an animation stops
 * taking frames at whichever bound it reaches first. The byte bound stays
 * below a Canvas design asset's, so a recording can be drawn wherever a
 * screenshot can.
 */
export const MAX_BROWSER_RECORDING_MS = 30_000;
export const BROWSER_RECORDING_FRAME_INTERVAL_MS = 250;
export const MAX_BROWSER_RECORDING_FRAMES =
  MAX_BROWSER_RECORDING_MS / BROWSER_RECORDING_FRAME_INTERVAL_MS;
export const MAX_BROWSER_RECORDING_EDGE = 800;
export const MAX_BROWSER_RECORDING_BYTES = 2 * 1024 * 1024;

/** Why a recording stopped taking frames before the call it covered ended. */
export const BrowserRecordingTruncation = Schema.Literal(
  "duration-limit",
  "frame-limit",
  "size-limit",
  // The page's picture changed size mid-recording (a resize); an animation
  // keeps one size, so it ends at the last frame of the old one.
  "viewport-changed",
  // Another tab came to the front: a recording belongs to the tab it started
  // on, so it ends there rather than mixing two tabs' pictures.
  "tab-changed",
);
export type BrowserRecordingTruncation = typeof BrowserRecordingTruncation.Type;

/** What a kept recording holds, as the capture and the tool result report it. */
export const BrowserRecordingFacts = Schema.Struct({
  frames: Schema.Int.pipe(Schema.between(1, MAX_BROWSER_RECORDING_FRAMES)),
  durationMs: Schema.Int.pipe(Schema.between(0, MAX_BROWSER_RECORDING_MS)),
  truncated: Schema.optional(BrowserRecordingTruncation),
}).annotations(strict);
export type BrowserRecordingFacts = typeof BrowserRecordingFacts.Type;

export const BrowserCaptureOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("kept"),
    captureId: BrowserCaptureId,
    /** Present when the capture is a recording rather than a screenshot. */
    recording: Schema.optional(BrowserRecordingFacts),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("not-kept"),
    reason: BrowserCaptureNotKeptReason,
  }).annotations(strict),
);
export type BrowserCaptureOutcome = typeof BrowserCaptureOutcome.Type;

export const BrowserObservation = Schema.Struct({
  contextId: BrowserContextId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  url: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  contentHash: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  extractedText: Schema.optional(Schema.String.pipe(Schema.maxLength(65_536))),
  /**
   * One short line on what the action changed: the address, the title, the
   * page's content, or nothing. It is how an agent learns the result without
   * reading the whole page again.
   */
  change: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  /**
   * The page outline a `snapshot` action read: one line per element, with a
   * reference on each one an action can name. A credential field is listed as
   * protected and never carries a value.
   */
  snapshot: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_BROWSER_SNAPSHOT_OUTLINE_CHARACTERS)),
  ),
  /**
   * What the page reported while the agent was driving it. Only the
   * `observe-diagnostics` action fills these: an agent that wants to know why a
   * page misbehaved asks for it, and every other action's payload stays the
   * shape it already had.
   */
  consoleErrors: Schema.optional(
    Schema.Array(BrowserConsoleError).pipe(Schema.maxItems(MAX_BROWSER_DIAGNOSTIC_ENTRIES)),
  ),
  failedRequests: Schema.optional(
    Schema.Array(BrowserFailedRequest).pipe(Schema.maxItems(MAX_BROWSER_DIAGNOSTIC_ENTRIES)),
  ),
  /** Console warnings, only when the diagnostics read asks for them. */
  consoleWarnings: Schema.optional(
    Schema.Array(BrowserConsoleError).pipe(Schema.maxItems(MAX_BROWSER_DIAGNOSTIC_ENTRIES)),
  ),
  /** Requests that completed with a 4xx or 5xx status. */
  httpErrors: Schema.optional(
    Schema.Array(BrowserHttpError).pipe(Schema.maxItems(MAX_BROWSER_DIAGNOSTIC_ENTRIES)),
  ),
  /** The last entry this read covers; the next read passes it as `since`. */
  diagnosticsCursor: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  /** Only an `audit` action fills this: what the audit found or measured. */
  audit: Schema.optional(BrowserPageAudit),
  screenshotDataUrl: Schema.optional(
    Schema.String.pipe(
      Schema.maxLength(MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS),
      Schema.pattern(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/),
    ),
  ),
  viewport: Schema.optional(BrowserViewportSize),
  /** Only a `resize` fills this: what the page reports about its device now. */
  emulation: Schema.optional(BrowserEmulationReport),
  /** The page's own dialogs since the last action, and how each was answered. */
  dialogs: Schema.optional(Schema.Array(BrowserDialogReport).pipe(Schema.maxItems(8))),
  /** Downloads the page started during this action; see the report. */
  downloads: Schema.optional(Schema.Array(BrowserDownloadReport).pipe(Schema.maxItems(16))),
  /** The context's tabs, after a tab action. */
  tabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tabId: BrowserTabId,
        url: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
        title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
        active: Schema.Boolean,
      }).annotations(strict),
    ).pipe(Schema.maxItems(16)),
  ),
  /**
   * Present only on an explicit `screenshot` action that the host was asked
   * to keep, and on the `record-stop` that ends an agent's recording.
   */
  capture: Schema.optional(BrowserCaptureOutcome),
  revision: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  observedAt: UtcTimestamp,
  stale: Schema.Boolean,
}).annotations(strict);
export type BrowserObservation = typeof BrowserObservation.Type;

export const BrowserAutomationFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
    reason: Schema.optional(BrowserProfileRefusalReason),
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("policy-denied"),
    message: Schema.NonEmptyTrimmedString,
    reason: Schema.optional(
      Schema.Union(BrowserProfileRefusalReason, Schema.Literal("origin-not-approved")),
    ),
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("context-expired"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("credential-protected"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("interrupted"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("failed"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("stale"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type BrowserAutomationFailure = typeof BrowserAutomationFailure.Type;

export const decodeBrowserContextId = Schema.decodeUnknownSync(BrowserContextId);
export const decodeBrowserThreadId = Schema.decodeUnknownSync(BrowserThreadId);
export const decodeBrowserCaptureId = Schema.decodeUnknownSync(BrowserCaptureId);
export const decodeBrowserProfileMode = Schema.decodeUnknownSync(BrowserProfileMode);
export const decodeBrowserProfile = Schema.decodeUnknownSync(BrowserProfile);
export const decodeBrowserContextPolicy = Schema.decodeUnknownSync(BrowserContextPolicy);
export const decodeBrowserContextState = Schema.decodeUnknownSync(BrowserContextState);
export const decodeBrowserPresentationKind = Schema.decodeUnknownSync(BrowserPresentationKind);
export const decodeBrowserContextRecord = Schema.decodeUnknownSync(BrowserContextRecord);
export const decodeBrowserActionKind = Schema.decodeUnknownSync(BrowserActionKind);
export const decodeBrowserActionRequest = Schema.decodeUnknownSync(BrowserActionRequest);
export const decodeBrowserWaitFor = Schema.decodeUnknownSync(BrowserWaitFor);
export const decodeBrowserObservation = Schema.decodeUnknownSync(BrowserObservation);
export const decodeBrowserAutomationFailure = Schema.decodeUnknownSync(BrowserAutomationFailure);
