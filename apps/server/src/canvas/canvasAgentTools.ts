import {
  CanvasBlock,
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  CANVAS_MAX_DESIGN_ASSETS,
  CANVAS_MAX_DESIGN_MARKUP_LENGTH,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasActor,
  decodeCanvasBlock,
  decodeCanvasId,
  type CanvasActor,
  type CanvasDesignBrand,
  type CanvasDocumentRecipe,
  type CanvasId,
  type CanvasPresentation,
  type CanvasProvenance,
  type ChatThread,
  type HostId,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type ProviderToolImage,
  type WindowId,
} from "@octant/contracts";
import { JSONSchema, Schema } from "effect";
import type { CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import type { ChildCanvasWorkspaceResolution } from "./childCanvasWorkspace";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ReaderMarking } from "../context/inheritedExternalContentMark";
import type { CanvasService } from "./canvasService";
import type { CanvasCommentAgentRequestView } from "./canvasCommentService";
import type {
  CanvasPreviewImageOmitted,
  CanvasPreviewOutcome,
  CanvasPreviewService,
  CanvasPreviewWidth,
} from "./canvasPreviewService";
import { inTreeCanvasDocumentRecipes } from "./canvasDocumentRecipes";
import {
  importCanvasMermaid,
  isCanvasMermaidLanguage,
  type CanvasMermaidRefusalReason,
} from "@octant/domain/canvas-mermaid-import";
import {
  loginSequenceExample,
  orderStateExample,
  orderSchemaExample,
  supportFlowExample,
  releaseMindmapExample,
  chartExamples,
  mockupExamples,
  appWindowPrototypeExample,
  cartPrototypeExample,
  onboardingFlowExample,
  launchDeckExample,
  searchSpecExample,
  treemapExamples,
  heatmapExamples,
  barListExamples,
  comparisonMatrixExamples,
  mathExamples,
  metricExamples,
  tabbedOverviewExample,
  designBriefExample,
  launchGanttExample,
  dashboardExamples,
  canvasInlineRefusal,
  effectiveCanvasPresentation,
} from "@octant/domain";

export const CANVAS_TOOL_NAME = "octant_canvas";

/**
 * Said back with every inline result. Agents read the guidance once and still
 * wrote "the chart above" in live runs, while the thread draws it after the reply.
 */
const INLINE_WHERE_SHOWN =
  "The thread draws this Canvas just below your reply, so refer to it as below.";

/**
 * How many blocks one authoring call may carry.
 *
 * The canvas budget already bounds a document; this bounds one tool call, so a
 * runaway author is refused before a definition is assembled rather than after.
 */
const MAX_AUTHORED_BLOCKS = 128;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIBED_BLOCK_KINDS = 3;
const MAX_DESIGN_EDITS = 16;

function memberKind(member: (typeof CanvasBlock.members)[number]): string {
  const struct = "fields" in member ? member : member.from;
  const kind = struct.fields.kind.literals[0];
  if (kind === undefined) {
    throw new Error("A Canvas block kind is missing from the catalogue.");
  }
  return kind;
}

// The kind catalogue derives one entry per union member; a heatmap has one
// member per layout, so the catalogue is deduped to keep the enum unique.
const blockKinds = [...new Set(CanvasBlock.members.map(memberKind))];

const canvasDefinitionSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["describe", "list", "read", "create", "revise", "preview"],
    },
    blockKinds: {
      type: "array",
      items: { type: "string", enum: blockKinds },
      minItems: 1,
      maxItems: MAX_DESCRIBED_BLOCK_KINDS,
      description:
        "For describe: up to three block kinds whose schemas to return, with guidance and examples for the kinds that have them. Omit to list every kind, the recipes, and a create example.",
    },
    title: { type: "string", maxLength: MAX_TITLE_CHARS, description: "Title of a new Canvas." },
    canvasId: {
      type: "string",
      description: "For read, revise, and preview: the id returned by create or list.",
    },
    version: {
      type: "integer",
      minimum: 1,
      description:
        "For preview: the version sequence to look at. Omit to preview the current version.",
    },
    width: {
      description:
        "For preview: where the Canvas is being shown. inline draws it at the thread width, sidebar at the card width, or give a width in pixels from 320 to 1200. Defaults to sidebar.",
      oneOf: [
        { type: "string", enum: ["inline", "sidebar"] },
        { type: "integer", minimum: 320, maximum: 1200 },
      ],
    },
    theme: {
      type: "string",
      enum: ["light", "dark"],
      description: "For preview: the theme to draw it on. Defaults to light.",
    },
    expectedSequence: {
      type: "integer",
      minimum: 1,
      description:
        "For revise: the last observed sequence. Creation starts at 1; use the sequence returned by each revision.",
    },
    prompt: {
      type: "string",
      description: "Optional provenance note. The blocks must contain the actual document.",
    },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_AUTHORED_BLOCKS,
      items: { type: "object" },
      description:
        "Required for create and revise (unless designEdits). Complete document blocks matching the schemas from describe; revise replaces the block list.",
    },
    designEdits: {
      type: "array",
      minItems: 1,
      maxItems: MAX_DESIGN_EDITS,
      items: { type: "object" },
      description:
        "For revise, instead of blocks: [{blockId, frames?, styles?, removeFrameIds?}] edits designs in place. See describe design.",
    },
    presentation: {
      type: "string",
      enum: ["inline", "sidebar"],
      description:
        "For create and revise: inline draws the Canvas in the conversation (a plan, mockup, or device-size design shows there as a preview card instead); sidebar, the default, shows a card that opens it beside the thread. Revise keeps the current choice when omitted.",
    },
  },
  required: ["operation"],
} as const;

/**
 * What this host lends a thread's agent for authoring a Canvas.
 *
 * The agent writes blocks, never markup: every block is decoded against the
 * closed catalog before it reaches a definition, so authorship cannot widen
 * what a Canvas may contain. Everything else a Canvas needs — which Project it
 * belongs to, which workspace bounds it, what authority it carries — is
 * resolved here from the thread, exactly as the route resolves it for the
 * person clicking New Canvas. The tool takes no shortcut that surface could
 * not take.
 */
export interface CanvasAgentToolPort {
  readonly activeContext: (
    windowId: WindowId,
  ) =>
    | { readonly mode: string; readonly projectId: string | null }
    | undefined
    | Promise<{ readonly mode: string; readonly projectId: string | null } | undefined>;
  readonly project: (
    windowId: WindowId,
    projectId: string,
  ) => Promise<
    { readonly id: string; readonly type: string; readonly lifecycle: string } | undefined
  >;
  /**
   * The brand kit of the thread's own Project, when the person defined one.
   * Keyed by the Project the host bound the thread to, never by anything the
   * model names, and read without a window so describe stays free of window
   * state. Absent on a host without Projects' kits.
   */
  readonly brandKit?: (projectId: string) => CanvasDesignBrand | undefined;
  readonly canvas: Pick<CanvasService, "create" | "revise" | "get" | "threadReferenceCards">;
  /**
   * The open comments a person sent to the agent about a Canvas. Absent on a
   * host without comments; the tool then shows no requests and checks no
   * revision against them.
   */
  readonly commentRequests?: (canvasId: CanvasId) => ReadonlyArray<CanvasCommentAgentRequestView>;
  /**
   * Marks the thread or managed child about to read a Canvas, when the
   * Canvas carries outside content (`markCanvasReader`). Called after a read or
   * a preview succeeds and before anything from it is returned; `refused`
   * withholds it, so a model never sees a marked Canvas on an unmarked thread.
   */
  readonly markReader: (input: {
    readonly readerId: string;
    readonly canvasId: CanvasId;
  }) => ReaderMarking;
  /**
   * Renders a shipped Canvas and reports its layout warnings. Absent on a host
   * that has not wired the preview service, so the tool refuses the operation
   * rather than inventing a picture or a warning list.
   */
  readonly preview?: CanvasPreviewService;
  /**
   * Whether a provider instance's model accepts images in a tool result.
   *
   * Reported per provider rather than assumed: a model that cannot take an
   * image is told the warnings and the reason, never handed a picture it would
   * drop on the floor. Absent means this host cannot vouch for the capability,
   * which reads as "no" — the same fail-closed answer the model would receive.
   */
  readonly imagesInToolResults?: (input: {
    readonly providerInstanceId: CanvasAuthoringThread["providerInstanceId"];
    readonly modelId: CanvasAuthoringThread["modelId"];
  }) => boolean;
  readonly uuid: () => string;
  readonly hostId: HostId;
  /**
   * The confined root or worktree a Work or Code thread is bound to now,
   * resolved from durable host state. Absent, or undefined for the thread,
   * refuses authoring: a document is never bound to a scope the host could
   * not name.
   */
  readonly resolveWorkspace?: (provenance: {
    readonly mode: "work" | "code";
    readonly threadId: string;
  }) => CanvasWorkspaceScope | undefined;
  /**
   * Document recipes describe may list. Absent means the in-tree catalog.
   * The host passes the offered set, which already drops a skill that is not
   * enabled. Describe does not read a Project to build this list.
   */
  readonly documentRecipes?: () => ReadonlyArray<CanvasDocumentRecipe>;
}

/** The Work or Code thread a Canvas tool authors for. */
export interface CanvasAuthoringThread {
  readonly id: string;
  readonly projectId: string;
  readonly providerInstanceId: ChatThread["providerInstanceId"];
  readonly modelId: ChatThread["modelId"];
}

type CanvasToolOwner =
  | {
      readonly mode: "chat";
      /** A Chat thread; `projectId` is absent when it is in no Chat Project. */
      readonly thread: Omit<CanvasAuthoringThread, "projectId"> & { readonly projectId?: string };
    }
  | { readonly mode: "work" | "code"; readonly thread: CanvasAuthoringThread };

/** Which owner a Chat thread's Canvases have: its Chat Project, or the thread alone. */
type ChatCanvasOwner = "project" | "thread";

type ResolvedCanvasTarget =
  | {
      readonly kind: "ready";
      readonly mode: "chat" | "work" | "code";
      /** Echoed into the request, which the service decodes and reauthorizes. */
      readonly workspace:
        | CanvasWorkspaceScope
        | { readonly kind: "chat-virtual"; readonly projectId: string };
      readonly context: {
        readonly mode: "chat" | "work" | "code";
        /** Null for a Canvas owned by a Chat thread outside a Chat Project. */
        readonly projectId: string | null;
        readonly workspace?: CanvasWorkspaceScope;
        readonly originThreadId?: string;
      };
      /** Absent for a Canvas owned by its thread: there is no Project to name. */
      readonly project:
        | {
            readonly id: string;
            readonly type: "chat" | "work" | "code";
            readonly lifecycle: "active";
          }
        | undefined;
    }
  | { readonly kind: "refused"; readonly error: string };

const MODE_NAMES = { chat: "Chat", work: "Work", code: "Code" } as const;

function describedExamples(kinds: ReadonlyArray<string>): ReadonlyArray<unknown> {
  const examples: unknown[] = [];
  for (const kind of kinds) {
    if (kind === "sequence") examples.push(loginSequenceExample);
    if (kind === "state") examples.push(orderStateExample);
    if (kind === "er") examples.push(orderSchemaExample);
    if (kind === "swimlane") examples.push(supportFlowExample);
    if (kind === "mindmap") examples.push(releaseMindmapExample);
    if (kind === "chart") examples.push(...chartExamples);
    if (kind === "mockup") examples.push(...mockupExamples);
    if (kind === "design") {
      examples.push(
        onboardingFlowExample,
        launchDeckExample,
        searchSpecExample,
        cartPrototypeExample,
        appWindowPrototypeExample,
      );
    }
    if (kind === "treemap") examples.push(...treemapExamples);
    if (kind === "heatmap") examples.push(...heatmapExamples);
    if (kind === "bar-list") examples.push(...barListExamples);
    if (kind === "comparison-matrix") examples.push(...comparisonMatrixExamples);
    if (kind === "math") examples.push(...mathExamples);
    if (kind === "metric") examples.push(...metricExamples);
    if (kind === "tabs" || kind === "columns") examples.push(tabbedOverviewExample);
    if (kind === "diagram") {
      examples.push(
        ...designBriefExample.filter(
          (block) => block.blockId === "loop" || block.blockId === "zones",
        ),
      );
    }
    if (kind === "plan") examples.push(launchGanttExample);
    if (kind === "dashboard") examples.push(...dashboardExamples);
  }
  return examples;
}

/**
 * Where a thread's Canvas belongs, decided by the host rather than the agent.
 *
 * A Chat Canvas is bounded by virtual memory, so the window's active Chat
 * Project determines it; a Chat thread in no Chat Project owns its Canvas
 * itself, with no Project to name. A Work or Code Canvas is bounded by the
 * confined root or worktree the thread is bound to now; the thread's own
 * Project and the host's resolution of that binding decide it, so a turn
 * running while the window shows another mode still writes into its own
 * scope and never into whatever the window happens to show.
 */
async function resolveCanvasTarget(
  windowId: WindowId,
  owner: CanvasToolOwner,
  port: CanvasAgentToolPort,
): Promise<ResolvedCanvasTarget> {
  if (owner.mode === "chat" && owner.thread.projectId === undefined) {
    return {
      kind: "ready",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      context: { mode: "chat", projectId: null, originThreadId: owner.thread.id },
      project: undefined,
    };
  }
  if (owner.mode === "chat") {
    const active = await port.activeContext(windowId);
    if (active === undefined || active.projectId === null || active.mode !== "chat") {
      return {
        kind: "refused",
        error: "This window has no Chat Project a Canvas could belong to.",
      };
    }
    const project = await port.project(windowId, active.projectId);
    if (project === undefined || project.lifecycle !== "active" || project.type !== "chat") {
      return { kind: "refused", error: "The Canvas Project is unavailable." };
    }
    return {
      kind: "ready",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: active.projectId },
      // The thread names itself so a Canvas it owned before it was moved
      // into this Project still answers to it, and to no other thread.
      context: { mode: "chat", projectId: active.projectId, originThreadId: owner.thread.id },
      project: { id: project.id, type: "chat", lifecycle: "active" },
    };
  }
  const projectId = owner.thread.projectId;
  const project = await port.project(windowId, projectId);
  if (project === undefined || project.lifecycle !== "active" || project.type !== owner.mode) {
    return { kind: "refused", error: "The Canvas Project is unavailable." };
  }
  const workspace = port.resolveWorkspace?.({ mode: owner.mode, threadId: owner.thread.id });
  if (workspace === undefined || String(workspace.projectId) !== projectId) {
    return {
      kind: "refused",
      error: `This ${MODE_NAMES[owner.mode]} thread's workspace is unavailable, so no Canvas can be bound to it.`,
    };
  }
  return {
    kind: "ready",
    mode: owner.mode,
    workspace,
    context: {
      mode: owner.mode,
      projectId,
      workspace,
      originThreadId: owner.thread.id,
    },
    project: { id: project.id, type: owner.mode, lifecycle: "active" },
  };
}

const LAYOUT_GROUP_GUIDE =
  "To arrange a long document, use tabs or columns. Both name blocks the same document holds, by blockId, and the document draws each named block inside its tab or column instead of in the block list. tabs has 2 to 12 panes, each with a short label and the blockIds it shows; columns has 2 to 4 tracks, each with the blockIds it stacks, and folds to one column when the Canvas is narrow. A block sits in at most one tab, track, or dashboard cell; a tab or track may hold a dashboard but never another tabs or columns block or an action. Which tab is open is the reader's choice and is never saved.";

/**
 * How a design shows a real image, in the words of the thread's mode: a Chat
 * Project has no folder, so its designs reach only images generated in it,
 * and a Chat thread outside a Project reaches only its own.
 */
function designAssetGuidance(
  mode: "chat" | "work" | "code",
  chatOwner: ChatCanvasOwner = "project",
): string {
  const sources =
    mode === "chat"
      ? `Each asset is a generated image made in ${chatOwner === "thread" ? "this Chat thread" : "this Chat Project"}, {"kind": "generated-image", "imageId": "<attachment id of a completed image>"}; Chat has no folder, so a file path is refused.`
      : `Each asset is a generated image made in this Project, {"kind": "generated-image", "imageId": "<attachment id of a completed image>"}, a file in ${mode === "work" ? "this thread's folder" : "this thread's checkout"}, {"kind": "project-file", "path": "screens/home.png"} relative to its root (no .., no absolute path, no link that leaves it), or a screenshot this thread kept in its Browser, {"kind": "browser-capture", "captureId": "<captureId from the screenshot result>"}. To redesign an existing site, open it in the Browser, take a screenshot, declare the kept capture as an asset, show it in a before frame, and draw the after frame yourself in HTML and CSS; never copy the page's remote images, styles, or fonts into a frame. Only this thread's own captures resolve, the picture is the small one the Browser keeps (about 40 KB), and it is drawn in the preview but never carried in an export or share.`;
  return `To show a real screenshot, a generated image, or a Project image in a design, declare it in the design's assets as {"assetId": "home-shot", "source": ...} and name it in a frame or in styles as octant-asset:home-shot in src, srcset, url(), or image-set(), written exactly like that. ${sources} The host reads PNG, JPEG, GIF, or WebP (not SVG; draw vector art inline) up to ${String(CANVAS_DESIGN_ASSET_MAX_BYTES / (1024 * 1024))} MB each and ${String(CANVAS_DESIGN_ASSETS_MAX_BYTES / (1024 * 1024))} MB per design, at most ${String(CANVAS_MAX_DESIGN_ASSETS)} per design, and draws a placeholder for one it cannot read; preview names it. The frame itself still loads nothing.`;
}

/**
 * Which block kind fits a need, and how to author it.
 *
 * Decision 0067 keeps the always-visible tool prefix small, and this guidance
 * was more than half of every mode's prefix while it rode in the description.
 * Describe answers it instead: `use` for every listed kind when no kinds are
 * named, and `detail` for each kind an agent asks for, beside its schema.
 */
const BLOCK_GUIDANCE: Readonly<Record<string, { readonly use: string; readonly detail: string }>> =
  {
    plan: {
      use: "A plan: phases and tasks with a status.",
      detail:
        "For a plan, use a plan block: phases, and tasks that name their phase, with a status (todo, doing, blocked, done), and optional owner, estimate, acceptance notes, dates, and dependsOn. Give tasks startAt and dueAt and set view to gantt to open the plan as bars on days with its dependency arrows; a task without dates is listed under the chart. The person can work the plan too, so read the Canvas before revising it and keep their progress.",
    },
    sequence: {
      use: "A login or request flow between participants.",
      detail:
        "A login or request flow is a sequence block: participants, ordered messages, activations, and notes.",
    },
    state: {
      use: "A lifecycle, such as an order's states and transitions.",
      detail:
        "A lifecycle such as an order is a state block: states that may nest, labeled transitions, and an initial and a final state.",
    },
    er: {
      use: "A data model of entities and relationships.",
      detail:
        "A data model is an er block: entities with named, typed attributes, and relationships with a cardinality at each end.",
    },
    swimlane: {
      use: "A process handed between people or teams.",
      detail:
        "A process handed between people or teams is a swimlane block: ordered lanes, the steps each lane owns (a decision step is flagged), and labeled connections.",
    },
    mindmap: {
      use: "A topic and its branches.",
      detail:
        "A topic and its branches is a mindmap block: one root topic, children that name their parent, and an optional note per topic.",
    },
    diagram: {
      use: "A generic graph of nodes and edges.",
      detail:
        "Use diagram for a generic graph of nodes and edges, such as a flowchart or a zone map: a node's role is process (a box), decision (a diamond), or terminator (a pill), or left out for a plain box; an edge's style is line, arrow, or dashed (a dashed arrow, for an optional or asynchronous step); an edge or a group may take a tone of neutral, accent, success, warning, or danger, and a toned group reads as a region. Tones are theme roles, never colours, and a label still says what the tone means. Lay out a system or architecture diagram by tier: one group per tier (clients, services, data), the flow left to right, node labels of a few words, and the protocol or data on each edge label. For an architecture diagram give each node an icon (client, browser, mobile, server, service, database, cache, queue, storage, cdn, gateway, auth, function, external, user, or analytics) and a short detail such as a technology or port, and nest a group inside another with parentGroupId (up to three levels) for a region that holds zones. Prefer sequence, state, er, swimlane, or mindmap when the drawing is one of those.",
    },
    deck: {
      use: "A presentation that mixes screens with data blocks, as slides.",
      detail:
        "A deck presents the document's own blocks as one ordered set of slides: a design's frame (with its frameId), a mockup's screen (with its variantId when it declares variants), or a chart, table, metric, progress, status, or dashboard block. Each slide may carry presenter notes (never carried by a share). A block is placed once in the whole Canvas, so a slide is never also a dashboard cell or a flow screen; Present walks the set across blocks, and a plain design block keeps its own Present.",
    },
    flow: {
      use: "An app or site's screens connected by their transitions, on a board.",
      detail:
        "An app or site flow is a flow block: it places screens the same Canvas already holds and connects them. Each screen names a mockup block (with its variantId when the mockup declares variants) or one frame of a design that runs no script (with its frameId); a screen never copies its block, so revise the mockup or design and the board follows. An edge names fromScreenId and toScreenId, an optional label and tone, and optionally fromNodeId: the control a person taps, a node of the from-screen's mockup that is a button, list-row, nav, tabs, select, checkbox, or toggle. A block is placed once in the whole Canvas, so a screen is never also a dashboard cell or a tab child. People drag screens on the board and walk the flow with Play, so read the Canvas before revising and keep their placements.",
    },
    chart: {
      use: "A pie, donut, stacked or grouped bar, bar-line, funnel, radar, or sankey chart, or a line or bar chart that calls out its finding.",
      detail:
        "A share of a whole is a pie or a donut: one series of labeled slices whose values are not negative. Comparing series across the same categories is a stacked-bar or a grouped-bar; every series lists those categories in the same order, and a stacked bar's values are not negative. A bar-line pairs bar series and line series on those categories, and each series names its mark. Drop-off through ordered stages is a funnel: one series of up to 16 labeled stages, each no larger than the one before. Comparing a few things on the same 3 to 16 qualities is a radar: every series lists the same labeled axes in the same order, with readings that are not negative. Where a quantity goes is a sankey: series is empty and links lists flows of { source, target, value } between node names (at most 80 characters, 64 nodes, 256 flows), each value positive, no flow listed twice, and no flow returning to a node it left. Any chart may take a title that states its finding as a sentence and a subtitle that says what was measured and over which span. On a line, area, scatter, bar, or distribution chart, a point may carry a note of up to 40 characters, drawn beside it (such as +344 on a jump; at most 12 per chart), and emphasis: true on the reading the chart is about, which leaves that bar in the series colour and the others in neutral ink.",
    },
    mockup: {
      use: "A wireframe or UI mockup of a screen, with states or alternatives.",
      detail:
        "A wireframe or UI mockup of a screen is a mockup block, built only from its closed catalog; it holds no HTML, CSS, or images. Pick a device (desktop window, browser, phone, tablet, dock-panel, or custom with a size) and a fidelity (wireframe, the default, or styled to draw with the person's theme). Nodes name a parent rather than nesting: window, header, sidebar, nav, stack, row, grid, card, tabs (the first child is the shown tab), list, list-row, heading, text, form-field and select (with a value), button, toggle, checkbox, badge, avatar, icon (from the bundled set), image-placeholder, table (columns and rows), modal, and toast, plus the library wave: search (with a value), breadcrumb, pagination, stepper, progress and slider (with progress, 0 to 100), menu, footer, hero (its value is the lede), media and map (placeholder boxes; a mockup holds no image), chat with chat-message, and instance (places a reusable definition by defId and holds no children). A button, badge, or toast may take a tone; on draws a toggle or checkbox as set, or a list row as current. For states (loading, empty, error) or alternatives (A and B), declare variants and give each top-level node a variantId. Pin numbered callouts to nodes with annotations to explain behaviour; people comment on those callouts. To reuse a subtree (a repeated row or card), declare definitions (each with exactly one top-level node and node ids unused anywhere else in the block) and place each copy as an instance naming its defId; a definition holds a plain subtree, never an instance, and callouts and hotspots name screen nodes, not a definition's. The controls are drawn, not live.",
    },
    treemap: {
      use: "A hierarchy sized and coloured by measures, such as a repository map.",
      detail:
        "A hierarchy is a treemap: nodes that name a parent (one root, no cycles), a list of measures with ids, labels, and optional number formats, a default sizeBy and colorBy, and a colour scale of sequential, diverging, or categorical by top-level group. Values sit on leaves; a group sums its children, so give values only to leaves and never to a group. A leaf may name a manifest source id, which offers Open file through the allowlisted open-source action. The person can switch size and colour and zoom into a group without revising the Canvas; use startNodeId to open a static export at a chosen node.",
    },
    heatmap: {
      use: "A grid coloured by value: a matrix, or a calendar of daily readings.",
      detail:
        "A grid coloured by value is a heatmap with a layout of matrix or calendar. A matrix names its rows and columns and carries a cell per coordinate with a value and an optional short note; a coordinate you do not list reads as missing, not as zero, and the person can sort the rows by their total without revising the Canvas. A calendar carries one reading per date and reads as a week grid. Both take an optional format and a scale of sequential or diverging.",
    },
    design: {
      use: "Finished-looking app screens, a website or landing page, or a slide deck.",
      detail:
        "A finished-looking design is a design block: app screens, a website or landing page, a slide deck, or a document such as an article, spec, or design system. Pick one size for the block (phone 390x844, tablet 820x1180, desktop 1440x900, slide 1920x1080, or document, as wide as the Canvas and as tall as its content), put shared CSS in styles, and write each screen, slide, or document section as a frame of static HTML. Link frames with href=\"#frameId\"; a link may only name a frame or a section. Frames run no JavaScript and load nothing: no script, event handlers, external links, remote images, fonts, or imports. Draw images with inline SVG, CSS gradients, or data:image URLs. A document is drawn in the workspace theme (theme workspace, its default; a device size defaults to none and keeps its own palette): it gets Octant's fonts and --oct-* colour tokens and the kit classes oct-article, oct-eyebrow, oct-lede, oct-grid, oct-card, oct-metrics with oct-metric (__label, __value, __delta--good or --bad), oct-badge (--accent, --success, --warn, --danger), oct-callout (--success, --warn, --danger), oct-table in oct-table-wrap, oct-code, and oct-tabs (radio inputs with labels, then one div.oct-tab-panel per tab, at most eight tabs). In a document, use the kit and tokens rather than your own colours or fonts, and never size anything with vh. Make a device design look finished: real copy, a clear type scale, and a deliberate palette. Lay a slide out in fixed pixels at its 1920x1080 size, never in vh or vw: body text at or above 32px, titles 64 to 96px, one idea per slide, and the same header and footer in the same place on every slide. A website or landing page is a desktop design whose page has its real sections in order (header, hero, features, proof, call to action, footer) in real copy. A UI kit's component sheet is a document with theme none that shows each control in its rest, hover, focus, disabled, and error states, each labelled. Describe design to get a phone flow, a deck, a themed spec, and a running cart. For a slide deck, put the speaker notes in each frame's notes field: short plain text, a sentence or two per slide. The presenter reads them in Present, and a share, a public link, and an export drop them.",
    },
    "bar-list": {
      use: "A ranking, such as hottest files or slowest tests.",
      detail:
        "A ranking is a bar list: rows with a label, a value, an optional second value, and an optional manifest source id. It sorts largest first by default, shows the top rows with Show all up to 500, and a row that names a source offers Open file through the allowlisted open-source action. Give each row a unique label, a value that is not negative, and a path-like label when it names a file (the renderer draws the directory dimmed). Bars use neutral ink, or the sequential scale when the magnitude matters.",
    },
    "comparison-matrix": {
      use: "Options compared against criteria, such as an architecture or vendor decision.",
      detail:
        "Comparing options against criteria, such as an architecture decision, a vendor or library choice, or a feature comparison, is a comparison-matrix: options (columns) and criteria (rows) with unique ids, and one cell per criterion and option holding a score, a short text, or a glyph of yes, partial, or no, with an optional note that explains it. A criterion takes an optional weight (absent counts once, 0 keeps it out of the score) and prefer lower when a low reading is good, such as cost. Declare a scoreRange such as 1 to 5 when you score. The host computes each option's weighted score from scores and glyphs, never text; do not write totals yourself. Name the option you recommend with recommendedOptionId and say why in recommendation; it may differ from the highest score.",
    },
    math: {
      use: "Mathematics: display formulas or prose with inline formulas, in LaTeX.",
      detail:
        "Mathematics is a math block written in LaTeX math markup, never in a text block or between dollar signs. A formula on its own line is layout display with a source and an optional caption that names it, such as Bayes' theorem; a sentence that carries formulas is layout inline with runs, each either prose (text, keep the spaces next to a formula) or a formula (math). A source is at most 1000 characters. Use standard commands, environments such as aligned, pmatrix, and cases, and \\text for words inside a formula. Macro definitions (\\def, \\newcommand), links and images (\\href, \\url, \\includegraphics, \\html...), and colour (\\color, \\textcolor) are refused: formulas take the reader's theme.",
    },
    table: {
      use: "Typed columns and rows the person can sort and filter.",
      detail:
        "A table is columns of a declared type (text, number, boolean, date, status) and rows that list one value per column in the same order. A column may take an optional format and an optional display: text (the plain reading), bar (an in-cell bar whose length is the value's share of the column's largest reading), heat (a tint on the shared sequential scale), or status (the value shown as a badge). The value is always shown, so bar and heat add a mark without replacing the reading; the person can sort, filter, and hide columns without revising the Canvas. A text column whose values read as a path is drawn with the shared path style. A row may instead be { id, cells } with a short id unique in the table; people can comment on a row only when it has an id, and the comment stays on that id, so keep a row's id when you revise it and give a new row a new id.",
    },
    metric: {
      use: "Headline numbers, gathered into a tile row.",
      detail:
        "Headline numbers are metric blocks. Give each a label and a value, and add an optional format, unit, delta, a goodDirection of up, down, or neutral so a delta's tone is never guessed, a caption, and a sparkline of at most 256 recent readings. Consecutive metric blocks are gathered into a responsive tile row of two to four tiles.",
    },
    "code-excerpt": {
      use: "Code, or a Mermaid diagram you already have, which the host imports as a typed diagram.",
      detail:
        "A Mermaid diagram you already have may be passed as a code-excerpt block with language mermaid: the host translates a flowchart or graph (TD or LR; [ ] process, { } decision, ([ ]) terminator, ( ) plain; -->, ---, and -.-> links with labels; one level of subgraph), a sequenceDiagram (participants, actors, messages, notes, activate and deactivate), a stateDiagram (transitions, [*] start and end, aliases, composite states), an erDiagram (relationships with cardinalities, attributes, PK), or a mindmap into the matching typed block under the same blockId. Anything else, such as styling, click, loops, or another diagram type, keeps the code block, and the result's mermaid list says which blocks were imported and why any were not. Mermaid itself is never drawn.",
    },
    tabs: {
      use: "A long document arranged in labelled tabs.",
      detail: LAYOUT_GROUP_GUIDE,
    },
    columns: {
      use: "Blocks side by side in two to four columns.",
      detail: LAYOUT_GROUP_GUIDE,
    },
    dashboard: {
      use: "A KPI dashboard grid that places metric, progress, status, chart, and table blocks.",
      detail:
        "A KPI dashboard is a dashboard block: a title that names the region, an optional number of columns from 1 to 4 (four when absent), and up to 24 cells, each naming the blockId of a metric, progress, status, chart, or table block elsewhere in the same Canvas, with an optional span of columns. Write the placed blocks as ordinary blocks and list them in reading order; each block sits in at most one cell, tab, or track, and a dashboard never places another dashboard, tabs, or columns. A tile takes one column and a chart or table two unless you give a span no wider than the grid. The grid is drawn where the dashboard sits and collapses to one column in a narrow dock or on a phone, in cell order.",
    },
  };

/**
 * The three ways a Canvas carries work, lowest first. Stated once, unscoped,
 * so an agent chooses a tier before it chooses a block kind.
 */
const TIER_GUIDE =
  'A Canvas carries work in three tiers; use the lowest tier that delivers the result, and mix them in one Canvas when the work needs it. 1. Typed blocks (headings, text, tables, metrics, charts, plans, the diagram kinds, and tabs and columns to arrange them) carry data: people comment on them, a revision edits them, and a share keeps their structure. 2. A static design frame carries the look: a design block of HTML and CSS that runs nothing, either a document in the workspace theme (an article, a spec, a design system) or screens and slides at a device size. 3. A running design frame carries behaviour: a design with "runsScript": true, for a prototype whose state changes as the person uses it. Describe design for the frame kit classes, how a frame shows real images, the limits a running frame keeps, and a finished example of each frame tier.';

const RECIPE_GUIDE =
  'Match the request to a document recipe before inventing a shape: "write a plan" uses implementation-plan, "write a memo or a one-page report" uses memo, "review this PR" uses code-review, "summarise research" uses research-brief, "decide between designs" uses architecture-review, "write an article" uses article, "make slides" uses slide-deck, "show the key numbers" uses dashboard, "design or redesign a website or landing page" uses design-prototype at desktop size with the page\'s real sections, "redesign an existing website" uses website-redesign, "pitch a product or a game" uses design-brief, "show the design system" uses design-system, "a UI kit or component sheet" uses ui-kit, "diagram the architecture or how the system fits together" uses architecture-diagram, "a prototype I can try" uses clickable-prototype, and "redesign the whole app window" uses app-redesign-prototype. A design slot names the size it is drawn at. Fill a recipe\'s roles from block kinds that exist today, and do not invent a block kind the catalogue does not have.';

const PREVIEW_GUIDE =
  "Preview returns the same picture the person will see and the warnings it can measure: an inline document past its height cap, and on a chart clipped labels, legend overflow, empty series, or ink below its contrast target, on a bar list clipped labels or empty series, and on a design each declared image the host could not draw, with the frames that name it, a frame whose content is wider than its page, text below its contrast target, and each script error a running design threw as it loaded. Every other block kind gets no warnings, so read its picture yourself.";

/** When a design should run script, and what a running one still may not do. */
const DESIGN_PROTOTYPE_GUIDANCE =
  'When the person asks for a working prototype (state that changes as they click, such as a cart that fills or a form that validates), set "runsScript": true on the design. Its frames may then use inline <script> elements and event handlers (onclick and the like); keep everything in the design. Still refused: <script src>, remote images, fonts, stylesheets, and imports, <meta>, <base>, <link>, iframes and other embedded documents, links that leave the design, and theme workspace (style a prototype yourself). Fetch, XHR, WebSocket, forms, and new windows are blocked, so put its data in the script. That is not a promise of privacy: a script can still open a direct connection to another computer, which Octant does not block yet, so keep secrets and private data out of a prototype and never tell the person it cannot reach the network. The person starts it with Run in the thread, and Octant stops a prototype that stops responding or loads another page. Use it only when interaction needs state; a clickable flow between screens is a static design with href="#frameId" links. Octant\'s bridge runs first in the page and reports its height, its uncaught errors (the first 280 characters of each), and a heartbeat every second; a page silent for 5 seconds, posting more than 250 messages a second, or loading another page is stopped, and preview returns the errors it threw as it loaded.';

/**
 * How to build a whole app window as a running prototype without one giant
 * call. The numbers come from the contract so the guidance cannot drift from
 * what the host accepts.
 */
const DESIGN_APP_WINDOW_GUIDANCE = `For a whole app window (sidebar, threads, panes, tabs, settings), use size desktop (1440x900) with "runsScript": true, and build it in steps instead of one huge call. First create the Canvas with the shell: the shared styles (put colours on :root as CSS variables such as --accent, so changing one variable recolours everything) and one frame holding the window's layout and its script. Then add each screen or pane with a revise that sends designEdits instead of blocks: [{"blockId": "...", "frames": [a complete frame to add, or to replace the frame with the same frameId], "styles": "the whole stylesheet, only if it changed", "removeFrameIds": []}] with the expectedSequence you last saw. Every other block and frame stays as it is. A frame and the stylesheet each hold at most ${String(CANVAS_MAX_DESIGN_MARKUP_LENGTH)} characters, and all the text in a Canvas at most 256 KiB, so give each large screen its own frame. Keep state without a framework: one state object, one render() that writes the state to the page (set aria-current, aria-selected, or hidden on elements, and set CSS variables on document.documentElement), and one click listener on document that reads data-* attributes, updates state, and calls render(); a colour picker is an input type=color whose input event sets state.accent and calls render(). A script in any frame runs once when the page loads, and every frame is in the page, so the script can reach elements in all of them. Move between whole screens with href="#frameId". Describe design returns a working window to start from. Preview after the first step, then after the last.`;

function blockGuide(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(BLOCK_GUIDANCE).map(([kind, guidance]) => [kind, guidance.use]),
  );
}

/**
 * Written only when the Project has a brand kit, so a thread without one is
 * never told to look for it.
 */
const BRAND_KIT_GUIDANCE =
  'This Project has a brand kit, returned as brandKit. A design that should look like the person\'s product or company sets "theme": "brand" and "brand" to those tokens unchanged (copy the whole object; do not invent colours or fonts). Frames then read --brand-<token> custom properties (for example var(--brand-color-primary) and var(--brand-font-heading)) and the kit classes pick up the colour, font, and radius roles. Without "theme": "brand" the design keeps the workspace theme or its own palette. A brand design cannot run script.';

function describedGuidance(
  kinds: ReadonlyArray<string>,
  mode: "chat" | "work" | "code",
  chatOwner: ChatCanvasOwner = "project",
  brandKit?: CanvasDesignBrand,
): Readonly<Record<string, string>> {
  const guidance: Record<string, string> = {};
  for (const kind of kinds) {
    const detail = BLOCK_GUIDANCE[kind]?.detail;
    if (detail === undefined) continue;
    // Which images a design can reach depends on the thread's mode, so that
    // part is written per describe rather than stored with the kind.
    guidance[kind] =
      kind === "design"
        ? [
            detail,
            designAssetGuidance(mode, chatOwner),
            DESIGN_PROTOTYPE_GUIDANCE,
            DESIGN_APP_WINDOW_GUIDANCE,
            ...(brandKit === undefined ? [] : [BRAND_KIT_GUIDANCE]),
          ].join(" ")
        : detail;
  }
  return guidance;
}

function toolDescription(
  mode: "chat" | "work" | "code",
  scope: "thread" | "run" = "thread",
  chatOwner: ChatCanvasOwner = "project",
): string {
  const where =
    mode === "chat"
      ? scope === "run"
        ? "this run"
        : chatOwner === "thread"
          ? "this Chat thread"
          : "this Chat Project"
      : mode === "work"
        ? scope === "run"
          ? "this run's folder"
          : "this Work thread's folder"
        : scope === "run"
          ? "this run's checkout"
          : "this Code thread's checkout";
  return [
    `Create, read, or revise an Octant Canvas: a structured, revisable document bound to ${where}.`,
    "Deliver work as a Canvas rather than as a long reply whenever the answer is something the user will keep, share, present, or come back to: a report, memo, plan, spec, review, audit, comparison, article, slide deck, dashboard, web page, design or mockup, diagram, or prototype, and any reply that needs headings, tables, or charts, or runs past a few paragraphs. Author it here, then reply with one or two sentences saying what it holds, without repeating its content.",
    "Keep in the reply what is read once: short answers, a one-off snippet or command, clarifying questions, and conversation. When in doubt, make the Canvas; the user can ask for plain text instead.",
    scope === "run"
      ? "When the request iterates on earlier work, revise the existing Canvas instead of creating another: list returns this run's Canvases, and read returns one's current blocks and sequence."
      : "When the request iterates on earlier work, revise the thread's existing Canvas instead of creating another: list returns this thread's Canvases, and read returns one's current blocks and sequence.",
    "Operations: describe, list, read, create, revise, preview. Before you author, call describe: with no block kinds it lists every kind, when to use the structured ones, the document recipes to start from, and a create example; with up to three blockKinds it returns their exact schemas, guidance, and examples. Start from a document recipe before inventing a shape, and make it look finished: typed blocks for data, a design frame only for the look.",
    "Author the content in blocks, not in prompt. Use structured blocks rather than HTML, JavaScript, or CSS; only a design block's frames are HTML and CSS; they load nothing, and run script only in a design that declares it. Mermaid is never drawn; describe code-excerpt for how a Mermaid diagram you already have becomes a typed diagram. Text renders as plain text, not Markdown: give each section its own heading block (the Canvas title is already shown, so do not repeat it), and use key-value, table, status, or callout blocks instead of Markdown lists, bold, or code spans.",
    "A Canvas is a document: it grants no file, shell, Git, or network access. Creation adds a card to this thread and offers the Canvas in its dock; the user can also select Open Canvas. Do not claim the user has read it or invent a download URL.",
    "Choose where the thread shows it. A visualization that answers the current question (a chart, a few metrics, a small dashboard, a short table, a diagram, or an interactive visual as a document-size design) goes inline: it is drawn just below your reply to this turn, so refer to it as below. Longer documents, plans, mockups, device-size designs, and work the user will keep editing stay in the sidebar (leave presentation out); when the host shows a card instead, the result says why in presentationNote.",
    "Revise with the canvasId, the last observed expectedSequence, and the complete replacement blocks; people edit Canvases too, so read before revising and keep their changes. Reference blocks require source ids already in the Canvas source manifest; create attaches no sources. Never invent file or artifact references.",
    "Preview once after you create or revise a chart, treemap, design, or inline Canvas, revise to fix what its warnings or picture show, then reply. An unchanged document previews the same.",
  ].join(" ");
}

/** What became of each Mermaid code block an authoring call carried. */
type CanvasMermaidOutcome =
  | { readonly blockId: string; readonly status: "imported"; readonly kind: string }
  | {
      readonly blockId: string;
      readonly status: "kept-as-code";
      readonly reason: CanvasMermaidRefusalReason;
      readonly line?: number;
      readonly detail: string;
    };

/**
 * A change to one design, applied to the version the author read. Frames are
 * kept loose here: the merged block is decoded whole, so the block schema is
 * the one place that says what a frame is.
 */
interface CanvasDesignEdit {
  readonly blockId: string;
  readonly styles?: string;
  readonly frames?: ReadonlyArray<unknown>;
  readonly removeFrameIds?: ReadonlyArray<string>;
}

interface CanvasAuthoringInput {
  readonly operation: "create" | "revise";
  readonly mermaid?: ReadonlyArray<CanvasMermaidOutcome>;
  readonly title?: string;
  readonly canvasId?: string;
  readonly expectedSequence?: number;
  readonly prompt?: string;
  /** Empty when `designEdits` is set; the edits are applied to the current blocks. */
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly designEdits?: ReadonlyArray<CanvasDesignEdit>;
  readonly presentation?: CanvasPresentation;
}

function parseDesignEdits(raw: unknown): ReadonlyArray<CanvasDesignEdit> | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DESIGN_EDITS) {
    return { error: `designEdits carries one to ${String(MAX_DESIGN_EDITS)} design changes.` };
  }
  const edits: CanvasDesignEdit[] = [];
  for (const [index, entry] of raw.entries()) {
    const at = `Design edit ${String(index + 1)}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { error: `${at} is not an object.` };
    }
    const record = entry as Record<string, unknown>;
    const unknownKey = Object.keys(record).find(
      (key) => !["blockId", "styles", "frames", "removeFrameIds"].includes(key),
    );
    if (unknownKey !== undefined) {
      return { error: `${at} has a field this host does not know: ${unknownKey}.` };
    }
    const { blockId, styles, frames, removeFrameIds } = record;
    if (typeof blockId !== "string") return { error: `${at} needs the blockId of a design.` };
    if (styles !== undefined && typeof styles !== "string") {
      return { error: `${at} styles must be text.` };
    }
    if (frames !== undefined && !Array.isArray(frames)) {
      return { error: `${at} frames must be a list.` };
    }
    if (
      removeFrameIds !== undefined &&
      (!Array.isArray(removeFrameIds) || !removeFrameIds.every((id) => typeof id === "string"))
    ) {
      return { error: `${at} removeFrameIds must be a list of frame ids.` };
    }
    if (styles === undefined && frames === undefined && removeFrameIds === undefined) {
      return { error: `${at} changes nothing: give styles, frames, or removeFrameIds.` };
    }
    edits.push({
      blockId,
      ...(styles === undefined ? {} : { styles }),
      ...(frames === undefined ? {} : { frames }),
      ...(removeFrameIds === undefined ? {} : { removeFrameIds }),
    });
  }
  return edits;
}

/**
 * The blocks with each edit applied: styles replaced, frames added or replaced
 * by frameId, frames removed. Every block the edits do not name is kept as
 * read, so a person's changes and the other blocks survive an incremental
 * build. The edited design is decoded again as a whole.
 */
function applyDesignEdits(
  blocks: ReadonlyArray<CanvasBlock>,
  edits: ReadonlyArray<CanvasDesignEdit>,
): { readonly blocks: ReadonlyArray<CanvasBlock> } | { readonly error: string } {
  const next = [...blocks];
  for (const edit of edits) {
    const index = next.findIndex((block) => String(block.blockId) === edit.blockId);
    const design = next[index];
    if (design === undefined || design.kind !== "design") {
      return { error: `${edit.blockId} is not a design in this Canvas.` };
    }
    const frames: unknown[] = [...design.frames];
    for (const frameId of edit.removeFrameIds ?? []) {
      const at = frames.findIndex(
        (frame) => String((frame as { frameId: unknown }).frameId) === frameId,
      );
      if (at === -1) return { error: `${edit.blockId} has no frame ${frameId} to remove.` };
      frames.splice(at, 1);
    }
    for (const frame of edit.frames ?? []) {
      const frameId =
        typeof frame === "object" && frame !== null
          ? String((frame as { frameId?: unknown }).frameId)
          : "";
      const at = frames.findIndex(
        (kept) => String((kept as { frameId: unknown }).frameId) === frameId,
      );
      if (at === -1) frames.push(frame);
      else frames[at] = frame;
    }
    try {
      next[index] = decodeCanvasBlock({
        ...design,
        ...(edit.styles === undefined ? {} : { styles: edit.styles }),
        frames,
      });
    } catch {
      return {
        error: `${edit.blockId} is not a valid design after that edit: check each frame's frameId, title, and html.`,
      };
    }
  }
  return { blocks: next };
}

type CanvasToolInput =
  | CanvasAuthoringInput
  | {
      readonly operation: "describe";
      readonly blockKinds?: ReadonlyArray<string>;
    }
  | { readonly operation: "list" }
  | { readonly operation: "read"; readonly canvasId: string }
  | {
      readonly operation: "preview";
      readonly canvasId: string;
      readonly version?: number;
      readonly width?: CanvasPreviewWidth;
      readonly theme?: "light" | "dark";
    };

function listedDocumentRecipes(recipes: ReadonlyArray<CanvasDocumentRecipe>): ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly skeleton: ReadonlyArray<{
    readonly kind: string;
    readonly role: string;
    readonly size?: string;
  }>;
}> {
  return recipes.map((recipe) => ({
    id: String(recipe.id),
    title: recipe.title,
    whenToUse: recipe.whenToUse,
    skeleton: recipe.skeleton.map((block) => ({
      kind: block.kind,
      role: block.role,
      ...(block.size === undefined ? {} : { size: block.size }),
    })),
  }));
}

/**
 * The authority a Canvas an agent wrote carries: none.
 *
 * A drawing is a document. It reads nothing and runs nothing, so it asks for
 * no filesystem, shell, Git, network, tool, or subagent authority, and the
 * chat-virtual clamp would refuse it if it did.
 */
function documentAuthority(): {
  readonly filesystem: false;
  readonly shell: false;
  readonly git: false;
  readonly network: false;
  readonly tools: false;
  readonly subagents: false;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly permissionPersistence: PermissionPersistence;
} {
  return {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: false,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  };
}

function parseInput(inputJson: string): CanvasToolInput | { readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { error: "Canvas tool input is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null) return { error: "Canvas tool input is invalid." };
  const record = raw as Record<string, unknown>;
  const operation = record["operation"];
  if (operation === "describe") {
    const requested = record["blockKinds"];
    if (requested === undefined) return { operation };
    if (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      requested.length > MAX_DESCRIBED_BLOCK_KINDS ||
      !requested.every(
        (kind): kind is string =>
          typeof kind === "string" && blockKinds.some((known) => known === kind),
      )
    )
      return {
        error: "Describe needs one to three known block kinds, or no blockKinds to list them.",
      };
    return { operation, blockKinds: requested };
  }
  if (operation === "list") return { operation };
  if (operation === "read") {
    const canvasId = record["canvasId"];
    return typeof canvasId === "string"
      ? { operation, canvasId }
      : { error: "Reading a Canvas needs its canvasId." };
  }
  if (operation === "preview") {
    const canvasId = record["canvasId"];
    if (typeof canvasId !== "string") {
      return { error: "A preview needs the canvasId of the Canvas to look at." };
    }
    const version = record["version"];
    if (
      version !== undefined &&
      (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    ) {
      return { error: "A preview version is a whole number from 1." };
    }
    const width = record["width"];
    let previewWidth: CanvasPreviewWidth | undefined;
    if (width !== undefined) {
      if (width === "inline" || width === "sidebar") previewWidth = width;
      else if (
        typeof width === "number" &&
        Number.isInteger(width) &&
        width >= 320 &&
        width <= 1200
      )
        previewWidth = width;
      else
        return {
          error:
            "A preview width is inline, sidebar, or a whole number of pixels from 320 to 1200.",
        };
    }
    const theme = record["theme"];
    if (theme !== undefined && theme !== "light" && theme !== "dark") {
      return { error: "A preview theme is light or dark." };
    }
    return {
      operation,
      canvasId,
      ...(version === undefined ? {} : { version }),
      ...(previewWidth === undefined ? {} : { width: previewWidth }),
      ...(theme === undefined ? {} : { theme }),
    };
  }
  if (operation !== "create" && operation !== "revise") {
    return {
      error: "Canvas tool operation must be describe, list, read, create, revise, or preview.",
    };
  }
  let designEdits: ReadonlyArray<CanvasDesignEdit> | undefined;
  if (record["designEdits"] !== undefined) {
    if (operation !== "revise")
      return { error: "designEdits change a Canvas, so they belong to revise." };
    if (record["blocks"] !== undefined) {
      return { error: "Send blocks or designEdits to revise, not both." };
    }
    const parsed = parseDesignEdits(record["designEdits"]);
    if ("error" in parsed) return parsed;
    designEdits = parsed;
  }
  const blocks: unknown = designEdits === undefined ? record["blocks"] : [];
  if (!Array.isArray(blocks) || (blocks.length === 0 && designEdits === undefined)) {
    return { error: "A Canvas needs at least one block." };
  }
  if (blocks.length > MAX_AUTHORED_BLOCKS) {
    return {
      error: `A Canvas authoring call carries at most ${String(MAX_AUTHORED_BLOCKS)} blocks.`,
    };
  }
  const decoded: CanvasBlock[] = [];
  const mermaid: CanvasMermaidOutcome[] = [];
  for (const [index, block] of blocks.entries()) {
    let typed: CanvasBlock;
    try {
      typed = decodeCanvasBlock(block);
    } catch {
      // Naming the block that failed is what lets an author fix it; the
      // catalog itself is what refuses anything outside it.
      return { error: `Block ${String(index + 1)} is not a Canvas block this host accepts.` };
    }
    // A Mermaid code block is translated into the typed diagram it describes,
    // under the same block id, when it stays inside the imported subset. A
    // source that does not keeps its code block, and the author is told why.
    // Mermaid itself is never drawn.
    if (
      typed.kind === "code-excerpt" &&
      typed.sourceId === undefined &&
      isCanvasMermaidLanguage(typed.language)
    ) {
      const outcome = importCanvasMermaid(typed.code, typed.blockId);
      if (outcome.status === "imported") {
        typed = outcome.block;
        mermaid.push({ blockId: String(typed.blockId), status: "imported", kind: typed.kind });
      } else {
        mermaid.push({
          blockId: String(typed.blockId),
          status: "kept-as-code",
          reason: outcome.reason,
          ...(outcome.line === undefined ? {} : { line: outcome.line }),
          detail: outcome.detail,
        });
      }
    }
    decoded.push(typed);
  }
  const presentation = record["presentation"];
  if (presentation !== undefined && presentation !== "inline" && presentation !== "sidebar") {
    return { error: "A Canvas presentation is inline or sidebar." };
  }
  const title = record["title"];
  const canvasId = record["canvasId"];
  const expectedSequence = record["expectedSequence"];
  const prompt = record["prompt"];
  return {
    operation,
    blocks: decoded,
    ...(designEdits === undefined ? {} : { designEdits }),
    ...(mermaid.length === 0 ? {} : { mermaid }),
    ...(presentation === undefined ? {} : { presentation }),
    ...(typeof title === "string" ? { title: title.slice(0, MAX_TITLE_CHARS) } : {}),
    ...(typeof canvasId === "string" ? { canvasId } : {}),
    ...(typeof expectedSequence === "number" ? { expectedSequence } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
  };
}

/**
 * Lend one thread's agent the ability to author a Canvas in its own scope.
 *
 * The scope is never the agent's choice: a Chat Canvas belongs to the window's
 * Chat Project, or to the thread itself when the thread is in no Chat
 * Project, and a Work or Code Canvas to the root or worktree the host
 * resolves for that thread now. A thread whose binding the host cannot resolve
 * is refused rather than given an assumed one.
 */
export function createCanvasAgentTools(
  options: {
    readonly windowId: WindowId;
    readonly port: CanvasAgentToolPort;
  } & (
    | { readonly mode?: "chat"; readonly thread: ChatThread }
    | { readonly mode: "work" | "code"; readonly thread: CanvasAuthoringThread }
  ),
): AppManagedToolSet {
  const owner: CanvasToolOwner =
    options.mode === "work" || options.mode === "code"
      ? { mode: options.mode, thread: options.thread }
      : {
          mode: "chat",
          thread: {
            id: options.thread.id,
            providerInstanceId: options.thread.providerInstanceId,
            modelId: options.thread.modelId,
            ...(options.thread.projectId === undefined
              ? {}
              : { projectId: String(options.thread.projectId) }),
          },
        };
  return canvasToolSet({
    mode: owner.mode,
    scope: "thread",
    ...(owner.mode === "chat" && owner.thread.projectId === undefined
      ? { chatOwner: "thread" }
      : {}),
    port: options.port,
    originThreadId: owner.thread.id,
    readerId: owner.thread.id,
    providerInstanceId: owner.thread.providerInstanceId,
    modelId: owner.thread.modelId,
    brandKit: () =>
      owner.thread.projectId === undefined
        ? undefined
        : options.port.brandKit?.(owner.thread.projectId),
    resolveTarget: () => resolveCanvasTarget(options.windowId, owner, options.port),
  });
}

/**
 * Lend one managed child the Canvas tool, bound to the workspace the host
 * resolved for that run.
 *
 * The model cannot name a path or a Project. Discovery still lists the tool
 * when the workspace cannot be resolved; create and revise then refuse. The
 * child run is the author. The parent thread is the origin, so the document
 * appears in that thread's dock.
 */
export function createChildCanvasAgentTools(options: {
  readonly port: CanvasAgentToolPort & {
    readonly resolveChildWorkspace: (input: {
      readonly runId: string;
    }) => ChildCanvasWorkspaceResolution | Promise<ChildCanvasWorkspaceResolution>;
  };
  readonly run: {
    readonly id: string;
    readonly parentThreadId: string;
    readonly mode: "chat" | "work" | "code";
    readonly projectId?: string;
    readonly providerInstanceId: CanvasAuthoringThread["providerInstanceId"];
    readonly modelId: CanvasAuthoringThread["modelId"];
  };
}): AppManagedToolSet {
  // A Chat run has no workspace to bind a Canvas to, and a run with no Project
  // has none either, so every call would be refused. Offer nothing; the refusal
  // in `resolveChildCanvasTarget` stays as the backstop.
  if (options.run.mode === "chat" || options.run.projectId === undefined) {
    return {
      definitions: [],
      execute: async () => ({ result: { error: "tool-unavailable" }, isError: true }),
    };
  }
  const author = childAuthor(options.run.id);
  const projectId = options.run.projectId;
  return canvasToolSet({
    mode: options.run.mode,
    scope: "run",
    port: options.port,
    originThreadId: options.run.parentThreadId,
    // A child's own mark is kept under its run, as every tool it calls keeps it.
    readerId: options.run.id,
    providerInstanceId: options.run.providerInstanceId,
    modelId: options.run.modelId,
    ...(author === undefined ? {} : { author }),
    brandKit: () => options.port.brandKit?.(projectId),
    resolveTarget: () => resolveChildCanvasTarget(options),
  });
}

function childAuthor(runId: string): CanvasActor | undefined {
  try {
    return decodeCanvasActor({ kind: "agent", actorId: runId });
  } catch {
    return undefined;
  }
}

async function resolveChildCanvasTarget(options: {
  readonly port: {
    readonly resolveChildWorkspace: (input: {
      readonly runId: string;
    }) => ChildCanvasWorkspaceResolution | Promise<ChildCanvasWorkspaceResolution>;
  };
  readonly run: {
    readonly id: string;
    readonly mode: "chat" | "work" | "code";
    readonly projectId?: string;
    readonly parentThreadId: string;
  };
}): Promise<ResolvedCanvasTarget> {
  if (options.run.mode === "chat" || options.run.projectId === undefined) {
    return {
      kind: "refused",
      error: "This run's workspace is unavailable, so no Canvas can be bound to it.",
    };
  }
  const resolved = await options.port.resolveChildWorkspace({ runId: options.run.id });
  if (resolved.status === "refused") {
    return {
      kind: "refused",
      error:
        resolved.reason === "foreign-project"
          ? "The Canvas Project is unavailable."
          : "This run's workspace is unavailable, so no Canvas can be bound to it.",
    };
  }
  const binding = resolved.binding;
  if (
    binding.mode !== options.run.mode ||
    binding.projectId !== options.run.projectId ||
    String(binding.workspace.projectId) !== options.run.projectId
  ) {
    return { kind: "refused", error: "The Canvas Project is unavailable." };
  }
  return {
    kind: "ready",
    mode: binding.mode,
    workspace: binding.workspace,
    context: {
      mode: binding.mode,
      projectId: binding.projectId,
      workspace: binding.workspace,
      originThreadId: options.run.parentThreadId,
    },
    project: binding.project,
  };
}

function canvasToolSet(options: {
  readonly mode: "chat" | "work" | "code";
  readonly scope: "thread" | "run";
  /** Who owns a Chat thread's Canvases; a Chat Project unless said otherwise. */
  readonly chatOwner?: ChatCanvasOwner;
  readonly port: CanvasAgentToolPort;
  readonly originThreadId: string;
  /** The thread or run whose model reads what this tool returns. */
  readonly readerId: string;
  readonly providerInstanceId: CanvasAuthoringThread["providerInstanceId"];
  readonly modelId: CanvasAuthoringThread["modelId"];
  readonly author?: CanvasActor;
  /** The thread's Project's brand kit, when it has one; read by describe alone. */
  readonly brandKit?: () => CanvasDesignBrand | undefined;
  readonly resolveTarget: () => Promise<ResolvedCanvasTarget>;
}): AppManagedToolSet {
  return {
    definitions: [
      {
        name: CANVAS_TOOL_NAME,
        description: toolDescription(options.mode, options.scope, options.chatOwner),
        inputSchema: canvasDefinitionSchema,
      },
    ],
    execute: async ({ name, inputJson }) => {
      if (name !== CANVAS_TOOL_NAME)
        return { result: { error: "tool-unavailable" }, isError: true };
      let input = parseInput(inputJson);
      if ("error" in input) return { result: { error: input.error }, isError: true };
      if (input.operation === "describe") {
        const brandKit = options.brandKit?.();
        const brand = brandKit === undefined ? {} : { brandKit };
        if (input.blockKinds === undefined) {
          return {
            result: {
              ...brand,
              ...(brandKit === undefined ? {} : { brandKitGuidance: BRAND_KIT_GUIDANCE }),
              blockKinds,
              blockGuide: blockGuide(),
              tierGuide: TIER_GUIDE,
              recipeGuide: RECIPE_GUIDE,
              previewGuide: PREVIEW_GUIDE,
              recipes: listedDocumentRecipes(
                options.port.documentRecipes?.() ?? inTreeCanvasDocumentRecipes(),
              ),
              example: {
                operation: "create",
                title: "Report",
                blocks: [
                  {
                    blockId: "summary",
                    schemaVersion: CANVAS_SCHEMA_VERSION,
                    kind: "rich-text",
                    text: "The report goes here.",
                  },
                ],
              },
            },
          };
        }
        const requested = input.blockKinds;
        const selected = CanvasBlock.members.filter((block) =>
          requested.includes(memberKind(block)),
        );
        const examples = describedExamples(requested);
        return {
          result: {
            blockSchema: JSONSchema.make(Schema.Union(...selected)),
            guidance: describedGuidance(requested, options.mode, options.chatOwner, brandKit),
            ...(input.blockKinds?.includes("design") === true ? brand : {}),
            ...(examples.length === 0 ? {} : { examples }),
          },
        };
      }

      const target = await options.resolveTarget();
      if (target.kind === "refused") {
        return { result: { error: target.error }, isError: true };
      }
      if (options.scope === "run" && options.author === undefined) {
        return {
          result: { error: "This run cannot be recorded as a Canvas author." },
          isError: true,
        };
      }

      if (input.operation === "list") {
        const canvases = options.port.canvas
          .threadReferenceCards({
            mode: target.mode,
            threadId: options.originThreadId,
            projectId: target.context.projectId,
          })
          .flatMap((card) => {
            const outcome = options.port.canvas.get(card.canvasId, target.context, target.project);
            return outcome.kind === "ready"
              ? [
                  {
                    canvasId: String(card.canvasId),
                    title: card.title,
                    sequence: outcome.version.sequence,
                  },
                ]
              : [];
          });
        return { result: { canvases } };
      }

      if (input.operation === "read") {
        let canvasId;
        try {
          canvasId = decodeCanvasId(input.canvasId);
        } catch {
          return { result: { error: "That Canvas is unavailable." }, isError: true };
        }
        const outcome = options.port.canvas.get(canvasId, target.context, target.project);
        if (outcome.kind !== "ready") {
          return { result: { error: "That Canvas is unavailable." }, isError: true };
        }
        if (!readerMarked(options, canvasId)) {
          return { result: { error: CANVAS_READER_UNMARKED }, isError: true };
        }
        const requested = pendingCommentRequests(
          options.port,
          canvasId,
          outcome.version.definition.provenance,
          options.originThreadId,
        );
        return {
          result: {
            canvasId: input.canvasId,
            title: outcome.version.definition.title,
            sequence: outcome.version.sequence,
            blocks: outcome.version.definition.blocks,
            ...(requested.length === 0
              ? {}
              : {
                  requestedChanges: requested.map((request) => ({
                    commentId: request.commentId,
                    anchor: request.anchor,
                    comment: request.body,
                    ...(request.replies.length === 0 ? {} : { replies: request.replies }),
                  })),
                  requestedChangesGuidance: REQUESTED_CHANGES_GUIDANCE,
                }),
          },
        };
      }

      if (input.operation === "preview") {
        const service = options.port.preview;
        if (service === undefined) {
          return {
            result: { error: "Preview is unavailable on this host." },
            isError: true,
          };
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(input.canvasId);
        } catch {
          return { result: { error: "That Canvas is unavailable." }, isError: true };
        }
        const imagesInToolResults =
          options.port.imagesInToolResults?.({
            providerInstanceId: options.providerInstanceId,
            modelId: options.modelId,
          }) === true;
        const outcome = await service.preview(
          {
            canvasId,
            threadKey: options.originThreadId,
            ...(input.version === undefined ? {} : { version: input.version }),
            width: input.width ?? "sidebar",
            theme: input.theme ?? "light",
            imagesInToolResults,
          },
          target.context,
          target.project,
        );
        if (outcome.kind === "preview" && !readerMarked(options, canvasId)) {
          return { result: { error: CANVAS_READER_UNMARKED }, isError: true };
        }
        return previewToolResult(outcome, imagesInToolResults);
      }

      if (input.operation === "revise" && input.designEdits !== undefined) {
        if (input.canvasId === undefined || input.expectedSequence === undefined) {
          return {
            result: { error: "Revising a Canvas needs its id and the version being revised." },
            isError: true,
          };
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(input.canvasId);
        } catch {
          return { result: { error: "That Canvas is unavailable." }, isError: true };
        }
        const current = options.port.canvas.get(canvasId, target.context, target.project);
        if (current.kind !== "ready") {
          return { result: { error: "That Canvas is unavailable." }, isError: true };
        }
        // The edits land on the blocks as they stand, so they must be the
        // version the author meant; a person's change in between is theirs.
        if (current.version.sequence !== input.expectedSequence) {
          return {
            result: {
              error: `That Canvas is at sequence ${String(current.version.sequence)}, not ${String(input.expectedSequence)}. Read it and send the edits against its current sequence.`,
            },
            isError: true,
          };
        }
        // The merged version keeps blocks the author never read, so the
        // thread is marked as it is for a read.
        if (!readerMarked(options, canvasId)) {
          return { result: { error: CANVAS_READER_UNMARKED }, isError: true };
        }
        const edited = applyDesignEdits(current.version.definition.blocks, input.designEdits);
        if ("error" in edited) return { result: { error: edited.error }, isError: true };
        input = { ...input, blocks: edited.blocks };
      }

      if (input.operation === "create") {
        const request = {
          schemaVersion: 1 as const,
          kind: "canvas-create" as const,
          requestId: options.port.uuid(),
          intent: input.prompt === undefined ? ("blank" as const) : ("prompt" as const),
          hostId: options.port.hostId,
          mode: target.mode,
          workspace: target.workspace,
          originThreadId: options.originThreadId,
          title: input.title ?? "Canvas",
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          sourceManifest: [],
          requestedAuthority: documentAuthority(),
        };
        const placed = placement(input);
        const result =
          placed.presentation !== undefined
            ? options.port.canvas.create(
                request,
                target.context,
                target.project,
                input.blocks,
                options.author,
                placed.presentation,
              )
            : options.author === undefined
              ? options.port.canvas.create(request, target.context, target.project, input.blocks)
              : options.port.canvas.create(
                  request,
                  target.context,
                  target.project,
                  input.blocks,
                  options.author,
                );
        if (result.kind !== "accepted") {
          return { result: { error: result.message }, isError: true };
        }
        return {
          result: {
            canvasId: result.card.canvasId,
            versionId: result.card.versionId,
            sequence: 1,
            blocks: input.blocks.length,
            presentation: result.card.presentation ?? "sidebar",
            ...(input.mermaid === undefined ? {} : { mermaid: input.mermaid }),
            ...(placed.note === undefined ? {} : { presentationNote: placed.note }),
            ...(result.card.presentation === "inline" ? { whereShown: INLINE_WHERE_SHOWN } : {}),
          },
        };
      }

      if (input.canvasId === undefined || input.expectedSequence === undefined) {
        return {
          result: { error: "Revising a Canvas needs its id and the version being revised." },
          isError: true,
        };
      }
      const placed = placement(input);
      const actor =
        options.author ?? decodeCanvasActor({ kind: "agent", actorId: options.port.uuid() });
      // What the person asked to change, and the blocks as they stand, read
      // before the revision so the result can say whether it stayed inside.
      const focus = revisionFocus(options.port, input, target, options.originThreadId);
      const revision = {
        schemaVersion: 1,
        kind: "canvas-revise",
        requestId: options.port.uuid(),
        canvasId: input.canvasId,
        expectedSequence: input.expectedSequence,
        hostId: options.port.hostId,
        mode: target.mode,
        workspace: target.workspace,
        originThreadId: options.originThreadId,
        prompt: input.prompt ?? "Authored revision",
        actor,
        providerInstanceId: options.providerInstanceId,
        modelId: options.modelId,
        requestedAuthority: documentAuthority(),
      };
      const result =
        placed.presentation === undefined
          ? options.port.canvas.revise(revision, target.context, target.project, input.blocks)
          : options.port.canvas.revise(
              revision,
              target.context,
              target.project,
              input.blocks,
              placed.presentation,
            );
      if (result.kind !== "accepted") {
        return { result: { error: result.message }, isError: true };
      }
      // A revision without a choice keeps the current one, which these blocks
      // may have outgrown; say so rather than let the agent assume inline.
      const revised = options.port.canvas.get(
        result.receipt.canvasId,
        target.context,
        target.project,
      );
      const effective =
        revised.kind === "ready"
          ? effectiveCanvasPresentation(revised.version.definition)
          : undefined;
      const note =
        placed.note ??
        (revised.kind === "ready" &&
        revised.version.definition.presentation === "inline" &&
        effective === "sidebar"
          ? canvasInlineRefusal(input.blocks)
          : undefined);
      const strayed = focus === undefined ? [] : blocksChangedOutsideRequests(focus, input.blocks);
      return {
        result: {
          canvasId: input.canvasId,
          versionId: result.receipt.versionId,
          sequence: result.receipt.sequence,
          ...(input.mermaid === undefined ? {} : { mermaid: input.mermaid }),
          ...(effective === undefined ? {} : { presentation: effective }),
          ...(note === undefined ? {} : { presentationNote: note }),
          ...(effective === "inline" ? { whereShown: INLINE_WHERE_SHOWN } : {}),
          ...(strayed.length === 0 ? {} : { warning: outsideRequestWarning(strayed) }),
        },
      };
    },
  };
}

/**
 * One plain sentence beside the omission code. The code alone was not enough:
 * with a bare `no-renderer`, a live model reported the preview "returned no
 * picture" in one turn and described the picture it never saw in the next, so
 * the sentence says what did not happen, why, and what to go on instead.
 */
function noPictureSentence(reason: CanvasPreviewImageOmitted | undefined): string {
  const because =
    reason === "no-browser"
      ? "this host has no browser to draw the Canvas"
      : reason === "no-renderer"
        ? "this build carries no Canvas preview page"
        : reason === "render-failed"
          ? "the preview page did not settle or the screenshot failed"
          : reason === "provider-cannot-take-images"
            ? "the model driving this turn cannot be shown images in a tool result"
            : "the preview could not draw it";
  return `No picture was taken because ${because}, so rely on the listed warnings only.`;
}

// Carried on the read that shows the requests rather than in the tool's
// always-visible definition, which is kept under a size budget.
const REQUESTED_CHANGES_GUIDANCE =
  "A person sent these comments to you. Revise only the block each anchor names (and within it only the named node, edge, row, or region) and keep every other block identical, including block ids and order; the revise result warns when other blocks changed.";

/**
 * The comments a person sent to the agent that no agent version has answered
 * yet (the port drops an answered one), and only to the Canvas's owning
 * thread. Another thread's agent can read the same Canvas under the Project's
 * authorization, but the request was sent to the owner, so it neither sees it
 * nor is held to it.
 */
function pendingCommentRequests(
  port: CanvasAgentToolPort,
  canvasId: CanvasId,
  provenance: CanvasProvenance,
  originThreadId: string,
): ReadonlyArray<CanvasCommentAgentRequestView> {
  const requests = port.commentRequests?.(canvasId) ?? [];
  return requests.length > 0 && String(provenance.threadId) === originThreadId ? requests : [];
}

interface RevisionFocus {
  readonly requests: ReadonlyArray<CanvasCommentAgentRequestView>;
  readonly before: ReadonlyArray<CanvasBlock>;
}

/** The pending requests and the blocks they were made against, or nothing when none are pending. */
function revisionFocus(
  port: CanvasAgentToolPort,
  input: { readonly canvasId?: string; readonly expectedSequence?: number },
  target: Extract<ResolvedCanvasTarget, { readonly kind: "ready" }>,
  originThreadId: string,
): RevisionFocus | undefined {
  if (input.canvasId === undefined || input.expectedSequence === undefined) return undefined;
  let canvasId: CanvasId;
  try {
    canvasId = decodeCanvasId(input.canvasId);
  } catch {
    return undefined;
  }
  const current = port.canvas.get(canvasId, target.context, target.project);
  if (current.kind !== "ready" || current.version.sequence !== input.expectedSequence) {
    return undefined;
  }
  const requests = pendingCommentRequests(
    port,
    canvasId,
    current.version.definition.provenance,
    originThreadId,
  );
  if (requests.length === 0) return undefined;
  return { requests, before: current.version.definition.blocks };
}

/**
 * The ids of blocks this revision changed, added, removed, or moved that no
 * pending request names. Blocks are compared with their keys in one order,
 * because the agent's JSON and the stored definition spell the same block in
 * different orders.
 */
function blocksChangedOutsideRequests(
  focus: RevisionFocus,
  after: ReadonlyArray<CanvasBlock>,
): ReadonlyArray<string> {
  const named = new Set(focus.requests.map((request) => String(request.anchor.blockId)));
  const previous = new Map(
    focus.before.map((block, index) => [String(block.blockId), { index, text: canonical(block) }]),
  );
  const changed: string[] = [];
  after.forEach((block, index) => {
    const id = String(block.blockId);
    const was = previous.get(id);
    previous.delete(id);
    if (was !== undefined && was.index === index && was.text === canonical(block)) return;
    if (!named.has(id)) changed.push(id);
  });
  for (const id of previous.keys()) if (!named.has(id)) changed.push(id);
  return changed;
}

function outsideRequestWarning(blockIds: ReadonlyArray<string>): string {
  return `This revision changed, moved, or removed blocks the person did not ask about: ${blockIds.join(", ")}. The request was to change only the anchored block and keep the rest identical; revise again if that was not intended.`;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );
}

const CANVAS_READER_UNMARKED =
  "That Canvas carries outside content, and this thread could not be marked with it, so it was not read. Try again.";

/** Whether the reader may be handed the Canvas: marked when it must be, or nothing to mark. */
function readerMarked(
  options: { readonly port: CanvasAgentToolPort; readonly readerId: string },
  canvasId: CanvasId,
): boolean {
  return options.port.markReader({ readerId: options.readerId, canvasId }).status !== "refused";
}

/**
 * The presentation to record for an authoring call, and why an inline request
 * is not drawn in the thread. The request is recorded as asked: a Canvas whose
 * blocks the thread cannot draw is still a sidebar Canvas
 * (`effectiveCanvasPresentation`), and the recorded request is what lets the
 * thread show it as a preview card rather than a row. The agent is told, so it
 * never believes a document sits in the conversation when the person sees a
 * card.
 */
function placement(input: CanvasAuthoringInput): {
  readonly presentation?: CanvasPresentation;
  readonly note?: string;
} {
  if (input.presentation !== "inline") {
    return input.presentation === undefined ? {} : { presentation: input.presentation };
  }
  const refusal = canvasInlineRefusal(input.blocks);
  return refusal === undefined
    ? { presentation: "inline" }
    : { presentation: "inline", note: refusal };
}

/**
 * How a preview reads back to the agent.
 *
 * A picture and the warnings travel separately: the warnings are the honest
 * layout reading and arrive whether or not a picture could be taken, and the
 * image rides in the tool result's own image channel. When no picture is
 * attached the result names the reason — no browser on this host, no preview
 * page in this build, a look that failed to render, or a model that cannot take
 * images — so the agent reports the warnings rather than believing it saw the
 * Canvas.
 */
function previewToolResult(
  outcome: CanvasPreviewOutcome,
  imagesInToolResults: boolean,
): {
  readonly result: unknown;
  readonly isError?: boolean;
  readonly images?: ReadonlyArray<ProviderToolImage>;
} {
  switch (outcome.kind) {
    case "preview":
      return {
        ...(outcome.image === undefined ? {} : { images: [outcome.image] }),
        result: {
          canvasId: outcome.canvasId,
          sequence: outcome.sequence,
          width: outcome.width,
          ...(outcome.height === undefined ? {} : { height: outcome.height }),
          warnings: outcome.warnings,
          imagesInToolResults,
          ...(outcome.image === undefined
            ? {
                imageIncluded: false,
                imageOmitted: outcome.imageOmitted,
                imageOmittedNote: noPictureSentence(outcome.imageOmitted),
              }
            : { imageIncluded: true }),
        },
      };
    case "busy":
      return {
        result: {
          error:
            "A preview is already running for this thread. Wait for it to finish, then preview again.",
        },
        isError: true,
      };
    case "rate-limited":
      return {
        result: {
          error:
            "Too many previews for this thread just now. Change the Canvas, then preview again.",
        },
        isError: true,
      };
    case "unavailable":
      return { result: { error: outcome.message }, isError: true };
  }
}
