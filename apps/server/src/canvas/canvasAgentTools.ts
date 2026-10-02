import {
  CanvasBlock,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  decodeCanvasId,
  type ChatThread,
  type HostId,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type WindowId,
} from "@octant/contracts";
import { JSONSchema, Schema } from "effect";
import type { CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
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
const blockKinds = CanvasBlock.members.map((block) => block.fields.kind.literals[0]);

const canvasDefinitionSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["describe", "list", "read", "create", "revise"] },
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
      description: "For read and revise: the id returned by create or list.",
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

function toolDescription(mode: "chat" | "work" | "code"): string {
  const where =
    mode === "chat"
      ? "this Chat Project"
      : mode === "work"
        ? "this Work thread's folder"
        : "this Code thread's checkout";
  return [
    `Create, read, or revise an Octant Canvas: a structured, revisable document bound to ${where}.`,
    "When the user asks you to make, draft, write, design, plan, draw, compare, summarize, review, or audit something substantial (a plan, design or mockup, diagram, report, review, audit, comparison, table, chart, or dashboard), deliver it as a Canvas rather than as a long reply: author it here, then reply with one or two sentences saying what the Canvas contains. Do not repeat its content in the conversation.",
    "Keep short answers, clarifying questions, and conversation in the reply. If it is unclear whether the user wants a document, you may ask whether they want it as a Canvas.",
    "When the request iterates on earlier work, revise the thread's existing Canvas instead of creating another: list returns this thread's Canvases, and read returns one's current blocks and sequence.",
    "Start with describe to see the block kinds and a create example, then describe the kinds you need for their exact schemas. Author the content in blocks, not in prompt. Use structured blocks rather than HTML, JavaScript, CSS, or Mermaid. Text renders as plain text, not Markdown: give each section its own heading block (the Canvas title is already shown, so do not repeat it), and use key-value, table, status, or callout blocks instead of Markdown lists, bold, or code spans.",
    "A Canvas is a document: it grants no file, shell, Git, or network access. Creation adds a card to this thread and offers the Canvas in the thread's dock the first time it appears; the user can also select Open Canvas. Do not claim the user has read it or invent a download URL.",
    "Revise with the canvasId, the last observed expectedSequence, and the complete replacement blocks. Reference blocks require source ids already in the Canvas source manifest; create attaches no sources. Never invent file or artifact references.",
  ].join(" ");
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
  | {
      readonly operation: "describe";
      readonly blockKinds?: ReadonlyArray<string>;
    }
  | { readonly operation: "list" }
  | { readonly operation: "read"; readonly canvasId: string };

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
  if (operation !== "create" && operation !== "revise") {
    return { error: "Canvas tool operation must be describe, list, read, create, or revise." };
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
  return {
    definitions: [
      {
        name: CANVAS_TOOL_NAME,
        description: toolDescription(owner.mode),
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

      const target = await resolveCanvasTarget(options.windowId, owner, options.port);
      if (target.kind === "refused") {
        return { result: { error: target.error }, isError: true };
      }

      if (input.operation === "list") {
        const canvases = options.port.canvas
          .threadReferenceCards({
            mode: target.mode,
            threadId: owner.thread.id,
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

      if (input.operation === "create") {
        const result = options.port.canvas.create(
          {
            schemaVersion: 1,
            kind: "canvas-create",
            requestId: options.port.uuid(),
            intent: input.prompt === undefined ? "blank" : "prompt",
            hostId: options.port.hostId,
            mode: target.mode,
            workspace: target.workspace,
            originThreadId: owner.thread.id,
            title: input.title ?? "Canvas",
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            sourceManifest: [],
            requestedAuthority: documentAuthority(),
          },
          target.context,
          target.project,
          input.blocks,
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
          },
        };
      }

      if (input.canvasId === undefined || input.expectedSequence === undefined) {
        return {
          result: { error: "Revising a Canvas needs its id and the version being revised." },
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
          mode: target.mode,
          workspace: target.workspace,
          originThreadId: owner.thread.id,
          prompt: input.prompt ?? "Authored revision",
          actor: { kind: "agent", actorId: options.port.uuid() },
          providerInstanceId: owner.thread.providerInstanceId,
          modelId: owner.thread.modelId,
          requestedAuthority: documentAuthority(),
        },
        target.context,
        target.project,
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
