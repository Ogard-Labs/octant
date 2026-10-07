import {
  CanvasBlock,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasActor,
  decodeCanvasBlock,
  decodeCanvasId,
  type CanvasActor,
  type CanvasDocumentRecipe,
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
import type { CanvasService } from "./canvasService";
import type {
  CanvasPreviewOutcome,
  CanvasPreviewService,
  CanvasPreviewWidth,
} from "./canvasPreviewService";
import { inTreeCanvasDocumentRecipes } from "./canvasDocumentRecipes";
import {
  loginSequenceExample,
  orderStateExample,
  orderSchemaExample,
  supportFlowExample,
  releaseMindmapExample,
  chartExamples,
  settingsScreenExample,
  treemapExamples,
  heatmapExamples,
  barListExamples,
  metricExamples,
  CANVAS_INLINE_MAX_BLOCKS,
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
        "For describe: request the schemas of up to three block kinds. Omit to list kinds and see a create example.",
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
      description: `For create and revise: inline draws a small Canvas (at most ${String(CANVAS_INLINE_MAX_BLOCKS)} blocks, no diagram board, plan, or mockup) inside the conversation; sidebar, the default, shows a card that opens it beside the thread. Revise keeps the current choice when omitted.`,
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
    if (kind === "mockup") examples.push(settingsScreenExample);
    if (kind === "treemap") examples.push(...treemapExamples);
    if (kind === "heatmap") examples.push(...heatmapExamples);
    if (kind === "bar-list") examples.push(...barListExamples);
    if (kind === "metric") examples.push(...metricExamples);
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
    "Start with describe to see the block kinds, the document recipes, and a create example, then describe the kinds you need for their exact schemas. Author the content in blocks, not in prompt. Use structured blocks rather than HTML, JavaScript, CSS, or Mermaid. Text renders as plain text, not Markdown: give each section its own heading block (the Canvas title is already shown, so do not repeat it), and use key-value, table, status, or callout blocks instead of Markdown lists, bold, or code spans.",
    'Match the request to a document recipe before inventing a shape: "write a plan" uses implementation-plan, "review this PR" uses code-review, and "summarise research" uses research-brief. Describe with no block kinds lists every offered recipe and its skeleton; fill those roles from block kinds that exist today, and do not invent a block kind the catalogue does not have.',
    "For a plan, use a plan block: phases, and tasks that name their phase, with a status (todo, doing, blocked, done), and optional owner, estimate, acceptance notes, dates, and dependsOn. The person can work the plan too, so read the Canvas before revising it and keep their progress.",
    "A login or request flow is a sequence block: participants, ordered messages, activations, and notes. A lifecycle such as an order is a state block: states that may nest, labeled transitions, and an initial and a final state. A data model is an er block: entities with named, typed attributes, and relationships with a cardinality at each end. A process handed between people or teams is a swimlane block: ordered lanes, the steps each lane owns (a decision step is flagged), and labeled connections. A topic and its branches is a mindmap block: one root topic, children that name their parent, and an optional note per topic. Use diagram for a generic graph of nodes and edges. Describe sequence, state, er, swimlane, or mindmap to get an example.",
    "A share of a whole is a pie or a donut: one series of labeled slices whose values are not negative. Comparing series across the same categories is a stacked-bar or a grouped-bar; every series lists those categories in the same order, and a stacked bar's values are not negative. A bar-line pairs bar series and line series on those categories, and each series names its mark. Describe chart to get an example of each.",
    "A screen is a mockup: a device of desktop, tablet, or phone, and a tree of window, header, sidebar, list, list row, form field, button, toggle, tabs, card, image placeholder, and text. Nodes name a parent rather than nesting. The controls are drawn, not live. Describe mockup to get a settings screen.",
    "A hierarchy is a treemap: nodes that name a parent (one root, no cycles), a list of measures with ids, labels, and optional number formats, a default sizeBy and colorBy, and a colour scale of sequential, diverging, or categorical by top-level group. Values sit on leaves; a group sums its children, so give values only to leaves and never to a group. A leaf may name a manifest source id, which offers Open file through the allowlisted open-source action. The person can switch size and colour and zoom into a group without revising the Canvas; use startNodeId to open a static export at a chosen node. Describe treemap to get a repository map sized by lines of code and coloured by recent edits.",
    "A grid coloured by value is a heatmap with a layout of matrix or calendar. A matrix names its rows and columns and carries a cell per coordinate with a value and an optional short note; a coordinate you do not list reads as missing, not as zero, and the person can sort the rows by their total without revising the Canvas. A calendar carries one reading per date and reads as a week grid. Both take an optional format and a scale of sequential or diverging. Describe heatmap to get commits by weekday and hour, and test failures per day.",
    "A ranking is a bar list: rows with a label, a value, an optional second value, and an optional manifest source id. It sorts largest first by default, shows the top rows with Show all up to 500, and a row that names a source offers Open file through the allowlisted open-source action. Give each row a unique label, a value that is not negative, and a path-like label when it names a file (the renderer draws the directory dimmed). Bars use neutral ink, or the sequential scale when the magnitude matters. Describe bar-list to get hottest files and slowest tests.",
    "A table is columns of a declared type (text, number, boolean, date, status) and rows that list one value per column in the same order. A column may take an optional format and an optional display: text (the plain reading), bar (an in-cell bar whose length is the value's share of the column's largest reading), heat (a tint on the shared sequential scale), or status (the value shown as a badge). The value is always shown, so bar and heat add a mark without replacing the reading; the person can sort, filter, and hide columns without revising the Canvas. A text column whose values read as a path is drawn with the shared path style.",
    "Headline numbers are metric blocks. Give each a label and a value, and add an optional format, unit, delta, a goodDirection of up, down, or neutral so a delta's tone is never guessed, a caption, and a sparkline of at most 256 recent readings. Consecutive metric blocks are gathered into a responsive tile row of two to four tiles. Describe metric to get a repo-stats tile row.",
    "A Canvas is a document: it grants no file, shell, Git, or network access. Creation adds a card to this thread and offers the Canvas in the thread's dock the first time it appears; the user can also select Open Canvas. Do not claim the user has read it or invent a download URL.",
    `Choose where the thread shows it. Use presentation inline for one small visual that answers the question, such as a chart, a few metrics, a short table, or a sequence or state diagram; it is drawn in the conversation just below your reply to this turn, so refer to it as below, and the user can still open it in the sidebar. Leave presentation out (sidebar) for reports, plans, boards, mockups, and anything the user will keep working on. Inline holds at most ${String(CANVAS_INLINE_MAX_BLOCKS)} blocks; when the host shows a card instead, the result says so in presentationNote.`,
    "Revise with the canvasId, the last observed expectedSequence, and the complete replacement blocks. Reference blocks require source ids already in the Canvas source manifest; create attaches no sources. Never invent file or artifact references.",
    "Preview once after you create or revise a chart, treemap, or inline Canvas: preview returns the same picture the person will see and the layout warnings for it (clipped labels, legend overflow, empty series, an inline document past its height cap, or ink below its contrast target). Fix what the warnings name with a revise, then reply. Previewing again before you change the document only spends the host's browser and your context, so look once per change.",
  ].join(" ");
}

interface CanvasAuthoringInput {
  readonly operation: "create" | "revise";
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
  readonly skeleton: ReadonlyArray<{ readonly kind: string; readonly role: string }>;
}> {
  return recipes.map((recipe) => ({
    id: String(recipe.id),
    title: recipe.title,
    whenToUse: recipe.whenToUse,
    skeleton: recipe.skeleton.map((block) => ({ kind: block.kind, role: block.role })),
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
  for (const [index, block] of blocks.entries()) {
    try {
      decoded.push(decodeCanvasBlock(block));
    } catch {
      // Naming the block that failed is what lets an author fix it; the
      // catalog itself is what refuses anything outside it.
      return { error: `Block ${String(index + 1)} is not a Canvas block this host accepts.` };
    }
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
  return canvasToolSet({
    mode: owner.mode,
    scope: "thread",
    port: options.port,
    originThreadId: owner.thread.id,
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
  const author = childAuthor(options.run.id);
  return canvasToolSet({
    mode: options.run.mode,
    scope: "run",
    port: options.port,
    originThreadId: options.run.parentThreadId,
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
          ...(effective === undefined ? {} : { presentation: effective }),
          ...(note === undefined ? {} : { presentationNote: note }),
          ...(effective === "inline" ? { whereShown: INLINE_WHERE_SHOWN } : {}),
        },
      };
    },
  };
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
            ? { imageIncluded: false, imageOmitted: outcome.imageOmitted }
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
