import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  BrowserContextId,
  BrowserContextState,
  BrowserPresentationKind,
  BrowserThreadId,
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
} from "./browserAutomation";
import { ProjectId } from "./projects";

/** Which Project mode a Project browser belongs to. Chat Projects have none. */
export const ProjectBrowserMode = Schema.Literals(["work", "code"]);
export type ProjectBrowserMode = typeof ProjectBrowserMode.Type;

const PageAddress = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));

/** The profile a person picks for a page; the host adds the Project it belongs to. */
export const BrowserAccountProfileChoice = Schema.TemplateLiteral([
  "account:",
  Schema.String,
]).check(
  Schema.isPattern(
    /^account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ),
);
export const BrowserProfileChoice = Schema.Union([
  Schema.Literals(["private", "project", "personal"]),
  BrowserAccountProfileChoice,
]);
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
export const ProjectBrowserCommand = Schema.Union([
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
  }),
  Schema.Struct({ kind: Schema.Literal("current"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("stop"), projectId: ProjectId }),
]);
export type ProjectBrowserCommand = typeof ProjectBrowserCommand.Type;

export const ProjectBrowserPage = Schema.Struct({
  url: Schema.optional(PageAddress),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  screenshotDataUrl: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS)),
  ),
});
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
    }),
  ),
  page: Schema.optional(ProjectBrowserPage),
});
export type ProjectBrowserView = typeof ProjectBrowserView.Type;

/**
 * Why the host would not act: `unauthorized` is not this window's Project or
 * not a local window, `unavailable` is a Project, page, or browser runtime
 * that is not there, `invalid` is an address the browser will not open, and
 * `authority-revoked` is a page the host closed because its Project was
 * archived or rebound.
 */
export const ProjectBrowserRefusalReason = Schema.Literals([
  "unauthorized",
  "unavailable",
  "invalid",
  "authority-revoked",
  "profile-unavailable",
]);
export type ProjectBrowserRefusalReason = typeof ProjectBrowserRefusalReason.Type;

export const ProjectBrowserResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-browser"),
    browser: ProjectBrowserView,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-browser-refused"),
    reason: ProjectBrowserRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type ProjectBrowserResult = typeof ProjectBrowserResult.Type;

export const decodeProjectBrowserCommand = Schema.decodeUnknownSync(
  ProjectBrowserCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectBrowserResult = Schema.decodeUnknownSync(
  ProjectBrowserResult,
  STRICT_DECODE_OPTIONS,
);

/** The most live agent pages a Project's tab strip lists, one per thread context. */
export const MAX_PROJECT_AGENT_PAGES = 64;

/** A window's request to list the live agent pages of one Project's threads. */
export const ProjectAgentPagesCommand = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectBrowserMode,
});
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
  threadTitle: Schema.String.check(Schema.isMaxLength(512)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  host: Schema.optional(Schema.String.check(Schema.isMaxLength(253))),
  /** An agent action is running on the page, or ran moments ago. */
  agentActive: Schema.Boolean,
  signedIn: Schema.optional(Schema.Literal(true)),
});
export type ProjectAgentPage = typeof ProjectAgentPage.Type;

export const ProjectAgentPages = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectBrowserMode,
  pages: Schema.Array(ProjectAgentPage).check(Schema.isMaxLength(MAX_PROJECT_AGENT_PAGES)),
});
export type ProjectAgentPages = typeof ProjectAgentPages.Type;

export const decodeProjectAgentPagesCommand = Schema.decodeUnknownSync(
  ProjectAgentPagesCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectAgentPages = Schema.decodeUnknownSync(
  ProjectAgentPages,
  STRICT_DECODE_OPTIONS,
);

export const decodeBrowserProfileChoice = Schema.decodeUnknownSync(
  BrowserProfileChoice,
  STRICT_DECODE_OPTIONS,
);
