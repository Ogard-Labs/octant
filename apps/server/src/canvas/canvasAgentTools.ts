import {
  CanvasBlock,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasOriginThreadId,
  type CanvasWorkspaceScope,
  type HostId,
  type OctantMode,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import { JSONSchema, Schema } from "effect";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { CanvasService } from "./canvasService";

export const CANVAS_TOOL_NAME = "octant_canvas";

/**
 * How many blocks one authoring call may carry.
 *
 * The canvas budget already bounds a document; this bounds one tool call, so a
 * runaway author is refused before a definition is assembled rather than after.
 */
const MAX_AUTHORED_BLOCKS = 128;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIBED_BLOCK_KINDS = 3;
const MAX_LISTED_CANVASES = 64;
const blockKinds = CanvasBlock.members.map((block) => block.fields.kind.literals[0]);
const operations = ["describe", "list", "read", "create", "revise", "open"] as const;

const canvasDefinitionSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: operations },
    blockKinds: {
      type: "array",
      items: { type: "string", enum: blockKinds },
      minItems: 1,
      maxItems: MAX_DESCRIBED_BLOCK_KINDS,
      description:
        "For describe: request the schemas of up to three block kinds. Omit to list kinds and see a create example.",
    },
    title: { type: "string", maxLength: MAX_TITLE_CHARS, description: "Title of a new Canvas." },
    canvasId: { type: "string", description: "For read, revise, and open: the Canvas id." },
    expectedSequence: {
      type: "integer",
      minimum: 1,
      description:
        "For revise: the last observed sequence. Creation starts at 1; use the sequence returned by each revision or the sequence listed by list and read.",
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
  /**
   * The bounded scope a Canvas authored by this thread must stay inside —
   * the same scope the person's create path resolves for the same thread.
   * Chat scopes are virtual memory; Work scopes the confined root; Code
   * scopes the thread's checkout worktree.
   */
  readonly workspace: (
    mode: OctantMode,
    threadId: string,
  ) => CanvasWorkspaceScope | undefined | Promise<CanvasWorkspaceScope | undefined>;
  /**
   * The Project a Canvas would belong to. `windowId` is absent when the
   * author is a delegated run rather than a windowed thread turn.
   */
  readonly project: (
    windowId: WindowId | undefined,
    projectId: string,
  ) => Promise<
    { readonly id: string; readonly type: string; readonly lifecycle: string } | undefined
  >;
  /** Canvases belonging to one Project, newest last. */
  readonly listCanvases: (
    mode: OctantMode,
    projectId: string,
  ) => ReadonlyArray<{
    readonly canvasId: string;
    readonly title: string;
    readonly sequence: number;
  }>;
  /** One Canvas's current document and provenance, for reading before a revise. */
  readonly readCanvas: (canvasId: string) =>
    | {
        readonly title: string;
        readonly sequence: number;
        readonly blocks: ReadonlyArray<CanvasBlock>;
        readonly mode: OctantMode;
        readonly projectId: string;
      }
    | undefined;
  /**
   * Surface an existing Canvas in the window's sidebar through the journaled
   * workspace operation a person triggers with Open Canvas. Absent for
   * delegated runs, which have no window to surface to.
   */
  readonly openSurface?: (input: {
    readonly windowId: WindowId;
    readonly mode: OctantMode;
    readonly title: string;
    readonly canvasId: string;
    readonly projectId: string;
  }) =>
    | { readonly kind: "opened" }
    | { readonly kind: "refused"; readonly message: string }
    | Promise<{ readonly kind: "opened" } | { readonly kind: "refused"; readonly message: string }>;
  readonly canvas: Pick<CanvasService, "create" | "revise">;
  readonly uuid: () => string;
  readonly hostId: HostId;
}

interface CanvasAuthoringInput {
  readonly operation: "create" | "revise";
  readonly title?: string;
  readonly canvasId?: string;
  readonly expectedSequence?: number;
  readonly prompt?: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
}

type CanvasToolInput =
  | CanvasAuthoringInput
  | { readonly operation: "describe"; readonly blockKinds?: ReadonlyArray<string> }
  | { readonly operation: "list" }
  | { readonly operation: "read"; readonly canvasId: string }
  | { readonly operation: "open"; readonly canvasId: string };

/**
 * The authority a Canvas an agent wrote carries: none.
 *
 * A drawing is a document. It reads nothing and runs nothing, so it asks for
 * no filesystem, shell, Git, network, tool, or subagent authority, the way the
 * person's own Canvas asks for none.
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
  if (operation === "read" || operation === "open") {
    const canvasId = record["canvasId"];
    if (typeof canvasId !== "string" || canvasId.trim() === "") {
      return { error: "The operation needs the Canvas id." };
    }
    return { operation, canvasId };
  }
  if (operation !== "create" && operation !== "revise") {
    return {
      error: "Canvas tool operation must be describe, list, read, create, revise, or open.",
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
  const title = record["title"];
  const canvasId = record["canvasId"];
  const expectedSequence = record["expectedSequence"];
  const prompt = record["prompt"];
  return {
    operation,
    blocks: decoded,
    ...(typeof title === "string" ? { title: title.slice(0, MAX_TITLE_CHARS) } : {}),
    ...(typeof canvasId === "string" ? { canvasId } : {}),
    ...(typeof expectedSequence === "number" ? { expectedSequence } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
  };
}

const MODE_LABEL: Record<OctantMode, string> = {
  chat: "Chat Project",
  work: "Work Project",
  code: "Code Project",
};

/**
 * Lend one thread's agent the ability to author a Canvas.
 *
 * The bounded workspace is resolved from the thread itself — the confined
 * root a Work thread is bound to, the checkout worktree a Code thread runs
 * in, the virtual memory a Chat thread shares — so a steered or queued turn
 * cannot write a document into whatever the window happens to be looking at.
 * A delegated child run binds to its parent thread's scope and gets no way
 * to open a surface, since it owns no window.
 */
export function createCanvasAgentTools(options: {
  readonly windowId: WindowId | undefined;
  readonly mode: OctantMode;
  readonly threadId: CanvasOriginThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly allowOpen: boolean;
  readonly port: CanvasAgentToolPort;
}): AppManagedToolSet {
  const modeLabel = MODE_LABEL[options.mode];
  return {
    definitions: [
      {
        name: CANVAS_TOOL_NAME,
        description: `Create, revise, list, read, or open an Octant Canvas in this ${modeLabel}: the preferred surface for a substantial plan, review, audit, report, diagram, table, or dashboard — leave brief answers in the conversation. Start with describe to see the operations, block kinds, and a create example, then describe the kinds you need for their exact schemas. Author the content in blocks, not in prompt. Use structured blocks rather than HTML, JavaScript, CSS, or Mermaid. Creation adds a card to this thread; call open with the canvasId to surface the Canvas in the sidebar for the user. list shows the Canvases already in this Project with their sequences; read returns a Canvas's current blocks and sequence for a revise. Revise the returned canvasId with the last observed expectedSequence and the complete replacement blocks. Reference blocks require source ids already in the Canvas source manifest; create attaches no sources. Never invent file or artifact references, and do not claim a pane opened without a successful open call.`,
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
              operations,
              blockKinds,
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
          input.blockKinds?.includes(block.fields.kind.literals[0]),
        );
        return { result: { blockSchema: JSONSchema.make(Schema.Union(...selected)) } };
      }

      const workspace = await options.port.workspace(options.mode, String(options.threadId));
      if (workspace === undefined) {
        return {
          result: {
            error: `This ${modeLabel} thread has no bounded workspace a Canvas could belong to.`,
          },
          isError: true,
        };
      }
      const context = {
        mode: options.mode,
        projectId: workspace.projectId === null ? null : String(workspace.projectId),
      };
      if (input.operation === "list") {
        const entries = options.port
          .listCanvases(options.mode, String(workspace.projectId ?? ""))
          .slice(0, MAX_LISTED_CANVASES);
        return {
          result: {
            canvases: entries,
            ...(entries.length === 0
              ? { note: "No Canvases in this Project yet. create starts one." }
              : {}),
          },
        };
      }
      if (input.operation === "read" || input.operation === "open") {
        const canvas = options.port.readCanvas(input.canvasId);
        if (
          canvas === undefined ||
          canvas.mode !== options.mode ||
          String(canvas.projectId) !== String(workspace.projectId ?? "")
        ) {
          return {
            result: { error: "That Canvas is not part of this thread's workspace." },
            isError: true,
          };
        }
        if (input.operation === "read") {
          return {
            result: {
              canvasId: input.canvasId,
              title: canvas.title,
              sequence: canvas.sequence,
              blocks: canvas.blocks,
            },
          };
        }
        if (
          !options.allowOpen ||
          options.windowId === undefined ||
          options.port.openSurface === undefined
        ) {
          return {
            result: {
              error: "A delegated run cannot open surfaces. Name the Canvas for the user instead.",
            },
            isError: true,
          };
        }
        const opened = await options.port.openSurface({
          windowId: options.windowId,
          mode: options.mode,
          title: canvas.title,
          canvasId: input.canvasId,
          projectId: String(canvas.projectId),
        });
        if (opened.kind !== "opened") {
          return { result: { error: opened.message }, isError: true };
        }
        return { result: { canvasId: input.canvasId, opened: true } };
      }

      const project = await options.port.project(
        options.windowId,
        String(workspace.projectId ?? ""),
      );
      if (
        project === undefined ||
        project.lifecycle !== "active" ||
        project.type !== options.mode
      ) {
        return { result: { error: "The Canvas Project is unavailable." }, isError: true };
      }
      const canvasProject = {
        id: project.id,
        type: options.mode,
        lifecycle: "active" as const,
      };

      if (input.operation === "create") {
        const result = options.port.canvas.create(
          {
            schemaVersion: 1,
            kind: "canvas-create",
            requestId: options.port.uuid(),
            intent: input.prompt === undefined ? "blank" : "prompt",
            hostId: options.port.hostId,
            mode: options.mode,
            workspace,
            originThreadId: options.threadId,
            title: input.title ?? "Canvas",
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            sourceManifest: [],
            requestedAuthority: documentAuthority(),
          },
          context,
          canvasProject,
          input.blocks,
        );
        if (result.kind !== "accepted") {
          return { result: { error: result.message }, isError: true };
        }
        return {
          result: {
            canvasId: result.card.canvasId,
            versionId: result.card.versionId,
            blocks: input.blocks.length,
            hint: "Call open with the canvasId to show this Canvas in the sidebar.",
          },
        };
      }

      if (input.canvasId === undefined || input.expectedSequence === undefined) {
        return {
          result: {
            error:
              "Revising a Canvas needs its id and the version being revised; read or list returns the current sequence.",
          },
          isError: true,
        };
      }
      const existing = options.port.readCanvas(input.canvasId);
      if (
        existing === undefined ||
        existing.mode !== options.mode ||
        String(existing.projectId) !== String(workspace.projectId ?? "")
      ) {
        return {
          result: { error: "That Canvas is not part of this thread's workspace." },
          isError: true,
        };
      }
      const result = options.port.canvas.revise(
        {
          schemaVersion: 1,
          kind: "canvas-revise",
          requestId: options.port.uuid(),
          canvasId: input.canvasId,
          expectedSequence: input.expectedSequence,
          hostId: options.port.hostId,
          mode: options.mode,
          workspace,
          originThreadId: options.threadId,
          prompt: input.prompt ?? "Authored revision",
          actor: { kind: "agent", actorId: options.port.uuid() },
          providerInstanceId: options.providerInstanceId,
          modelId: options.modelId,
          requestedAuthority: documentAuthority(),
        },
        context,
        canvasProject,
        input.blocks,
      );
      if (result.kind !== "accepted") {
        return { result: { error: result.message }, isError: true };
      }
      return {
        result: {
          canvasId: input.canvasId,
          versionId: result.receipt.versionId,
          sequence: result.receipt.sequence,
        },
      };
    },
  };
}
