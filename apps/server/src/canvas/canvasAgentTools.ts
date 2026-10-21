import {
  CanvasBlock,
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  CANVAS_MAX_DESIGN_ASSETS,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasActor,
  decodeCanvasBlock,
  decodeCanvasId,
  type CanvasActor,
  type CanvasDocumentRecipe,
  type CanvasId,
  type CanvasPresentation,
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
        "Required for create and revise. Complete document blocks matching the schemas from describe; revise replaces the block list.",
    },
    presentation: {
      type: "string",
      enum: ["inline", "sidebar"],
      description:
        "For create and revise: inline draws the Canvas inside the conversation (any reading blocks, or one document-size design without script; no diagram board, plan, mockup, or other design); sidebar, the default, shows a card that opens it beside the thread. Revise keeps the current choice when omitted.",
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
  readonly canvas: Pick<CanvasService, "create" | "revise" | "get" | "threadReferenceCards">;
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
  | { readonly mode: "chat"; readonly thread: Omit<CanvasAuthoringThread, "projectId"> }
  | { readonly mode: "work" | "code"; readonly thread: CanvasAuthoringThread };

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
        readonly projectId: string;
        readonly workspace?: CanvasWorkspaceScope;
        readonly originThreadId?: string;
      };
      readonly project: {
        readonly id: string;
        readonly type: "chat" | "work" | "code";
        readonly lifecycle: "active";
      };
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
 * Project determines it. A Work or Code Canvas is bounded by the confined root
 * or worktree the thread is bound to now; the thread's own Project and the
 * host's resolution of that binding decide it, so a turn running while the
 * window shows another mode still writes into its own scope and never into
 * whatever the window happens to show.
 */
async function resolveCanvasTarget(
  windowId: WindowId,
  owner: CanvasToolOwner,
  port: CanvasAgentToolPort,
): Promise<ResolvedCanvasTarget> {
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
      context: { mode: "chat", projectId: active.projectId },
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
 * Project has no folder, so its designs reach only images generated in it.
 */
function designAssetGuidance(mode: "chat" | "work" | "code"): string {
  const sources =
    mode === "chat"
      ? 'Each asset is a generated image made in this Chat Project, {"kind": "generated-image", "imageId": "<attachment id of a completed image>"}; a Chat Project has no folder, so a file path is refused.'
      : `Each asset is a generated image made in this Project, {"kind": "generated-image", "imageId": "<attachment id of a completed image>"}, or a file in ${mode === "work" ? "this thread's folder" : "this thread's checkout"}, {"kind": "project-file", "path": "screens/home.png"} relative to its root (no .., no absolute path, no link that leaves it).`;
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
        "Use diagram for a generic graph of nodes and edges, such as a flowchart or a zone map: a node's role is process (a box), decision (a diamond), or terminator (a pill), or left out for a plain box; an edge's style is line, arrow, or dashed (a dashed arrow, for an optional or asynchronous step); an edge or a group may take a tone of neutral, accent, success, warning, or danger, and a toned group reads as a region. Tones are theme roles, never colours, and a label still says what the tone means. Prefer sequence, state, er, swimlane, or mindmap when the drawing is one of those.",
    },
    chart: {
      use: "A pie, donut, stacked or grouped bar, bar-line, funnel, radar, or sankey chart.",
      detail:
        "A share of a whole is a pie or a donut: one series of labeled slices whose values are not negative. Comparing series across the same categories is a stacked-bar or a grouped-bar; every series lists those categories in the same order, and a stacked bar's values are not negative. A bar-line pairs bar series and line series on those categories, and each series names its mark. Drop-off through ordered stages is a funnel: one series of up to 16 labeled stages, each no larger than the one before. Comparing a few things on the same 3 to 16 qualities is a radar: every series lists the same labeled axes in the same order, with readings that are not negative. Where a quantity goes is a sankey: series is empty and links lists flows of { source, target, value } between node names (at most 80 characters, 64 nodes, 256 flows), each value positive, no flow listed twice, and no flow returning to a node it left.",
    },
    mockup: {
      use: "A wireframe or UI mockup of a screen, with states or alternatives.",
      detail:
        "A wireframe or UI mockup of a screen is a mockup block, built only from its closed catalog; it holds no HTML, CSS, or images. Pick a device (desktop window, browser, phone, tablet, dock-panel, or custom with a size) and a fidelity (wireframe, the default, or styled to draw with the person's theme). Nodes name a parent rather than nesting: window, header, sidebar, nav, stack, row, grid, card, tabs (the first child is the shown tab), list, list-row, heading, text, form-field and select (with a value), button, toggle, checkbox, badge, avatar, icon (from the bundled set), image-placeholder, table (columns and rows), modal, and toast. A button, badge, or toast may take a tone; on draws a toggle or checkbox as set, or a list row as current. For states (loading, empty, error) or alternatives (A and B), declare variants and give each top-level node a variantId. Pin numbered callouts to nodes with annotations to explain behaviour; people comment on those callouts. The controls are drawn, not live.",
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
        'A finished-looking design is a design block: app screens, a website or landing page, a slide deck, or a document such as an article, spec, or design system. Pick one size for the block (phone 390x844, tablet 820x1180, desktop 1440x900, slide 1920x1080, or document, as wide as the Canvas and as tall as its content), put shared CSS in styles, and write each screen, slide, or document section as a frame of static HTML. Link frames with href="#frameId"; a link may only name a frame or a section. Frames run no JavaScript and load nothing: no script, event handlers, external links, remote images, fonts, or imports. Draw images with inline SVG, CSS gradients, or data:image URLs. A document is drawn in the workspace theme (theme workspace, its default; a device size defaults to none and keeps its own palette): it gets Octant\'s fonts and --oct-* colour tokens and the kit classes oct-article, oct-eyebrow, oct-lede, oct-grid, oct-card, oct-metrics with oct-metric (__label, __value, __delta--good or --bad), oct-badge (--accent, --success, --warn, --danger), oct-callout (--success, --warn, --danger), oct-table in oct-table-wrap, oct-code, and oct-tabs (radio inputs with labels, then one div.oct-tab-panel per tab, at most eight tabs). In a document, use the kit and tokens rather than your own colours or fonts, and never size anything with vh. Make a device design look finished: real copy, a clear type scale, and a deliberate palette. Describe design to get a phone flow, a deck, a themed spec, and a running cart.',
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
  'Match the request to a document recipe before inventing a shape: "write a plan" uses implementation-plan, "review this PR" uses code-review, "summarise research" uses research-brief, and "decide between designs" uses architecture-review, "write an article" uses article, "pitch a product or a game" uses design-brief, "show the design system" uses design-system, and "a prototype I can try" uses clickable-prototype. A design slot names the size it is drawn at. Fill a recipe\'s roles from block kinds that exist today, and do not invent a block kind the catalogue does not have.';

const PREVIEW_GUIDE =
  "Preview returns the same picture the person will see and the warnings it can measure: an inline document past its height cap, and on a chart clipped labels, legend overflow, empty series, or ink below its contrast target, on a bar list clipped labels or empty series, and on a design each declared image the host could not draw, with the frames that name it, a frame whose content is wider than its page, text below its contrast target, and each script error a running design threw as it loaded. Every other block kind gets no warnings, so read its picture yourself.";

/** When a design should run script, and what a running one still may not do. */
const DESIGN_PROTOTYPE_GUIDANCE =
  'When the person asks for a working prototype (state that changes as they click, such as a cart that fills or a form that validates), set "runsScript": true on the design. Its frames may then use inline <script> elements and event handlers (onclick and the like); keep everything in the design. Still refused: <script src>, remote images, fonts, stylesheets, and imports, <meta>, <base>, <link>, iframes and other embedded documents, links that leave the design, and theme workspace (style a prototype yourself). Fetch, XHR, WebSocket, forms, and new windows are blocked, so put its data in the script. That is not a promise of privacy: a script can still open a direct connection to another computer, which Octant does not block yet, so keep secrets and private data out of a prototype and never tell the person it cannot reach the network. The person starts it with Run in the thread, and Octant stops a prototype that stops responding or loads another page. Use it only when interaction needs state; a clickable flow between screens is a static design with href="#frameId" links. Octant\'s bridge runs first in the page and reports its height, its uncaught errors (the first 280 characters of each), and a heartbeat every second; a page silent for 5 seconds, posting more than 250 messages a second, or loading another page is stopped, and preview returns the errors it threw as it loaded.';

function blockGuide(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(BLOCK_GUIDANCE).map(([kind, guidance]) => [kind, guidance.use]),
  );
}

function describedGuidance(
  kinds: ReadonlyArray<string>,
  mode: "chat" | "work" | "code",
): Readonly<Record<string, string>> {
  const guidance: Record<string, string> = {};
  for (const kind of kinds) {
    const detail = BLOCK_GUIDANCE[kind]?.detail;
    if (detail === undefined) continue;
    // Which images a design can reach depends on the thread's mode, so that
    // part is written per describe rather than stored with the kind.
    guidance[kind] =
      kind === "design"
        ? `${detail} ${designAssetGuidance(mode)} ${DESIGN_PROTOTYPE_GUIDANCE}`
        : detail;
  }
  return guidance;
}

function toolDescription(
  mode: "chat" | "work" | "code",
  scope: "thread" | "run" = "thread",
): string {
  const where =
    mode === "chat"
      ? scope === "run"
        ? "this run"
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
    "When the user asks you to make, draft, write, design, plan, draw, compare, summarize, review, or audit something substantial (a plan, design or mockup, diagram, report, review, audit, comparison, table, chart, or dashboard), deliver it as a Canvas rather than as a long reply: author it here, then reply with one or two sentences saying what the Canvas contains. Do not repeat its content in the conversation.",
    "Keep short answers, clarifying questions, and conversation in the reply. If it is unclear whether the user wants a document, you may ask whether they want it as a Canvas.",
    scope === "run"
      ? "When the request iterates on earlier work, revise the existing Canvas instead of creating another: list returns this run's Canvases, and read returns one's current blocks and sequence."
      : "When the request iterates on earlier work, revise the thread's existing Canvas instead of creating another: list returns this thread's Canvases, and read returns one's current blocks and sequence.",
    "Operations: describe, list, read, create, revise, preview. Before you author, call describe: with no block kinds it lists every kind, when to use the structured ones, the document recipes to start from, and a create example; with up to three blockKinds it returns their exact schemas, plus authoring guidance and examples for the kinds that have them. Start from a document recipe before inventing a shape.",
    "Author the content in blocks, not in prompt. Use structured blocks rather than HTML, JavaScript, or CSS; only a design block's frames are HTML and CSS; they load nothing, and run script only in a design that declares it. Mermaid is never drawn; describe code-excerpt for how a Mermaid diagram you already have becomes a typed diagram. Text renders as plain text, not Markdown: give each section its own heading block (the Canvas title is already shown, so do not repeat it), and use key-value, table, status, or callout blocks instead of Markdown lists, bold, or code spans.",
    "A Canvas is a document: it grants no file, shell, Git, or network access. Creation adds a card to this thread and offers the Canvas in the thread's dock the first time it appears; the user can also select Open Canvas. Do not claim the user has read it or invent a download URL.",
    "Choose where the thread shows it. Use presentation inline for a visual or a reading document that answers the question in place, such as a chart, a few metrics, a short table, a sequence or state diagram, or an article or brief made of reading blocks or one document-size design; it is drawn in the conversation just below your reply to this turn, so refer to it as below. A long one starts as a faded teaser the user can expand in place, and the user can still open it in the sidebar. Leave presentation out (sidebar) for plans, boards, mockups, other designs, and anything the user will keep working on; inline never holds those, and when the host shows a card instead, the result says so in presentationNote.",
    "Revise with the canvasId, the last observed expectedSequence, and the complete replacement blocks; people edit Canvases too, so read before revising and keep their changes. Reference blocks require source ids already in the Canvas source manifest; create attaches no sources. Never invent file or artifact references.",
    "Preview once after you create or revise a chart, treemap, design, or inline Canvas, revise to fix what its warnings or picture show, then reply. Look once per change: an unchanged document previews the same.",
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

interface CanvasAuthoringInput {
  readonly operation: "create" | "revise";
  readonly mermaid?: ReadonlyArray<CanvasMermaidOutcome>;
  readonly title?: string;
  readonly canvasId?: string;
  readonly expectedSequence?: number;
  readonly prompt?: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  readonly presentation?: CanvasPresentation;
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
  const blocks = record["blocks"];
  if (!Array.isArray(blocks) || blocks.length === 0) {
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
 * Chat Project, and a Work or Code Canvas to the root or worktree the host
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
      : { mode: "chat", thread: options.thread };
  // A Chat thread outside a Chat Project has nowhere for a Canvas to live, so
  // every call would be refused. Offer nothing rather than a tool that cannot
  // succeed; the refusal in `resolveCanvasTarget` stays as the backstop.
  if (
    options.mode !== "work" &&
    options.mode !== "code" &&
    options.thread.projectId === undefined
  ) {
    return {
      definitions: [],
      execute: async () => ({ result: { error: "tool-unavailable" }, isError: true }),
    };
  }
  return canvasToolSet({
    mode: owner.mode,
    scope: "thread",
    port: options.port,
    originThreadId: owner.thread.id,
    readerId: owner.thread.id,
    providerInstanceId: owner.thread.providerInstanceId,
    modelId: owner.thread.modelId,
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
  readonly port: CanvasAgentToolPort;
  readonly originThreadId: string;
  /** The thread or run whose model reads what this tool returns. */
  readonly readerId: string;
  readonly providerInstanceId: CanvasAuthoringThread["providerInstanceId"];
  readonly modelId: CanvasAuthoringThread["modelId"];
  readonly author?: CanvasActor;
  readonly resolveTarget: () => Promise<ResolvedCanvasTarget>;
}): AppManagedToolSet {
  return {
    definitions: [
      {
        name: CANVAS_TOOL_NAME,
        description: toolDescription(options.mode, options.scope),
        inputSchema: canvasDefinitionSchema,
      },
    ],
    execute: async ({ name, inputJson }) => {
      if (name !== CANVAS_TOOL_NAME)
        return { result: { error: "tool-unavailable" }, isError: true };
      const input = parseInput(inputJson);
      if ("error" in input) return { result: { error: input.error }, isError: true };
      if (input.operation === "describe") {
        if (input.blockKinds === undefined) {
          return {
            result: {
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
        const selected = CanvasBlock.members.filter((block) =>
          input.blockKinds?.includes(memberKind(block)),
        );
        const examples = describedExamples(input.blockKinds ?? []);
        return {
          result: {
            blockSchema: JSONSchema.make(Schema.Union(...selected)),
            guidance: describedGuidance(input.blockKinds ?? [], options.mode),
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
        return {
          result: {
            canvasId: input.canvasId,
            title: outcome.version.definition.title,
            sequence: outcome.version.sequence,
            blocks: outcome.version.definition.blocks,
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
      return {
        result: {
          canvasId: input.canvasId,
          versionId: result.receipt.versionId,
          sequence: result.receipt.sequence,
          ...(input.mermaid === undefined ? {} : { mermaid: input.mermaid }),
          ...(effective === undefined ? {} : { presentation: effective }),
          ...(note === undefined ? {} : { presentationNote: note }),
          ...(effective === "inline" ? { whereShown: INLINE_WHERE_SHOWN } : {}),
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
 * The presentation to record for an authoring call. Inline is recorded only
 * when the host would draw these blocks in the thread; otherwise the Canvas
 * is recorded as sidebar and the agent is told why, so it never believes a
 * document sits in the conversation when the person sees a card.
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
    : { presentation: "sidebar", note: refusal };
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
