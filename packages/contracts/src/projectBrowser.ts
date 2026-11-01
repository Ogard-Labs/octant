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

/** The profile a person picks for a page; the host adds the Project it belongs to. */
export const BrowserProfileChoice = Schema.Literal("private", "project", "personal");
export type BrowserProfileChoice = typeof BrowserProfileChoice.Type;

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
    /**
     * Which store the page keeps its site data in. The host turns "project"
     * into this Project's own profile, so a caller cannot name another
     * Project's. Absent means Private.
     */
    profile: Schema.optional(BrowserProfileChoice),
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
      profile: Schema.optional(BrowserProfileChoice),
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
  // The page asked for a profile the host cannot open: a Browser that is not
  // the desktop app's own, or a Project whose store is locked.
  "profile-unavailable",
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

/** The most live agent pages a Project's tab strip lists, one per thread context. */
export const MAX_PROJECT_AGENT_PAGES = 64;

/** A window's request to list the live agent pages of one Project's threads. */
export const ProjectAgentPagesCommand = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectBrowserMode,
}).annotations(strict);
export type ProjectAgentPagesCommand = typeof ProjectAgentPagesCommand.Type;

/**
 * One thread's live page, named and nothing more: no text, no picture, no
 * address beyond its host. The strip shows the picture the floating preview
 * already shows by asking the thread's own route for it.
 *
 * `signedIn` stands in for `title` and `host` when a paired device asks about a
 * page in a stored profile, which carries the person's account.
 */
export const ProjectAgentPage = Schema.Struct({
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
  threadTitle: Schema.String.pipe(Schema.maxLength(512)),
  title: Schema.optional(Schema.String.pipe(Schema.maxLength(1024))),
  host: Schema.optional(Schema.String.pipe(Schema.maxLength(253))),
  /** An agent action is running on the page, or ran moments ago. */
  agentActive: Schema.Boolean,
  signedIn: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type ProjectAgentPage = typeof ProjectAgentPage.Type;

export const ProjectAgentPages = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectBrowserMode,
  pages: Schema.Array(ProjectAgentPage).pipe(Schema.maxItems(MAX_PROJECT_AGENT_PAGES)),
}).annotations(strict);
export type ProjectAgentPages = typeof ProjectAgentPages.Type;

export const decodeProjectAgentPagesCommand = Schema.decodeUnknownSync(ProjectAgentPagesCommand);
export const decodeProjectAgentPages = Schema.decodeUnknownSync(ProjectAgentPages);
