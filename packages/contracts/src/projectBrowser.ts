import { Schema } from "effect";
import {
  BrowserContextId,
  BrowserContextState,
  BrowserPresentationKind,
  BrowserThreadId,
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
} from "./browserAutomation";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Which Project mode a Project browser belongs to. Chat Projects have none. */
export const ProjectBrowserMode = Schema.Literal("work", "code");
export type ProjectBrowserMode = typeof ProjectBrowserMode.Type;

const PageAddress = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096));

/**
 * A person's command to the browser a Work or Code Project owns without a
 * thread.
 *
 * It names the Project and, to open a page, the address. The host decides
 * the rest — whether this window holds the Project, which isolated context the
 * page lives in — so a caller cannot describe its way into a thread's
 * browsing context or its origin approval.
 */
export const ProjectBrowserCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("open"),
    projectId: ProjectId,
    url: PageAddress,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("current"), projectId: ProjectId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("stop"), projectId: ProjectId }).annotations(strict),
);
export type ProjectBrowserCommand = typeof ProjectBrowserCommand.Type;

export const ProjectBrowserPage = Schema.Struct({
  url: Schema.optional(PageAddress),
  title: Schema.optional(Schema.String.pipe(Schema.maxLength(1024))),
  screenshotDataUrl: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS)),
  ),
}).annotations(strict);
export type ProjectBrowserPage = typeof ProjectBrowserPage.Type;

/**
 * The Project's browser as the host holds it for this window.
 *
 * `subjectId` is the owner the host registered the page under. A native view
 * attaches only when the window and this owner both match, so the renderer
 * needs it to show the page; it is derived from the Project, and it is never
 * the id of any thread.
 */
export const ProjectBrowserView = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectBrowserMode,
  subjectId: BrowserThreadId,
  context: Schema.optional(
    Schema.Struct({
      contextId: BrowserContextId,
      state: BrowserContextState,
      presentation: Schema.optional(BrowserPresentationKind),
    }).annotations(strict),
  ),
  page: Schema.optional(ProjectBrowserPage),
}).annotations(strict);
export type ProjectBrowserView = typeof ProjectBrowserView.Type;

/**
 * Why the host would not act: `unauthorized` is not this window's Project or
 * not a local window, `unavailable` is a Project, page, or browser runtime
 * that is not there, `invalid` is an address the browser will not open, and
 * `authority-revoked` is a page the host closed because its Project was
 * archived or rebound.
 */
export const ProjectBrowserRefusalReason = Schema.Literal(
  "unauthorized",
  "unavailable",
  "invalid",
  "authority-revoked",
);
export type ProjectBrowserRefusalReason = typeof ProjectBrowserRefusalReason.Type;

export const ProjectBrowserResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("project-browser"),
    browser: ProjectBrowserView,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-browser-refused"),
    reason: ProjectBrowserRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ProjectBrowserResult = typeof ProjectBrowserResult.Type;

export const decodeProjectBrowserCommand = Schema.decodeUnknownSync(ProjectBrowserCommand);
export const decodeProjectBrowserResult = Schema.decodeUnknownSync(ProjectBrowserResult);
