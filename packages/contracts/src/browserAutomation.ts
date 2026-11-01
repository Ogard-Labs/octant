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
export const BrowserProfile = Schema.Union(
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

/** The longest page outline an observation carries, in characters. */
export const MAX_BROWSER_SNAPSHOT_OUTLINE_CHARACTERS = 32 * 1024;

export const BrowserActionRequest = Schema.Struct({
  actionId: ToolActionId,
  contextId: BrowserContextId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: BrowserActionKind,
  target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  /** An element of the latest snapshot, in place of a CSS selector `target`. */
  ref: Schema.optional(BrowserElementRef),
  value: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536))),
  point: Schema.optional(BrowserViewportPoint),
  deltaX: Schema.optional(Schema.Number.pipe(Schema.between(-2000, 2000))),
  deltaY: Schema.optional(Schema.Number.pipe(Schema.between(-2000, 2000))),
  expectedObservationRevision: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
}).annotations(strict);
export type BrowserActionRequest = typeof BrowserActionRequest.Type;

/** One error the page's own console reported, bounded like every other read. */
export const BrowserConsoleError = Schema.Struct({
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_BROWSER_DIAGNOSTIC_TEXT_CHARACTERS)),
  /** The page's URL when the error was logged, so a navigation is not misread. */
  url: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
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
}).annotations(strict);
export type BrowserFailedRequest = typeof BrowserFailedRequest.Type;

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

export const BrowserCaptureOutcome = Schema.Union(
  Schema.Struct({ status: Schema.Literal("kept"), captureId: BrowserCaptureId }).annotations(
    strict,
  ),
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
  screenshotDataUrl: Schema.optional(
    Schema.String.pipe(
      Schema.maxLength(MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS),
      Schema.pattern(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/),
    ),
  ),
  viewport: Schema.optional(BrowserViewportSize),
  /** Present only on an explicit `screenshot` action that the host was asked to keep. */
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
    reason: Schema.optional(BrowserProfileRefusalReason),
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
export const decodeBrowserObservation = Schema.decodeUnknownSync(BrowserObservation);
export const decodeBrowserAutomationFailure = Schema.decodeUnknownSync(BrowserAutomationFailure);
