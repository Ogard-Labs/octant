import {
  decodeCanvasBlock,
  type CanvasBlock,
  type ChatThread,
  type HostId,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type WindowId,
} from "@octant/contracts";
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

const canvasDefinitionSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["create", "revise"] },
    title: { type: "string" },
    canvasId: { type: "string" },
    expectedSequence: { type: "number" },
    prompt: { type: "string" },
    blocks: { type: "array", items: { type: "object" } },
  },
  required: ["operation", "blocks"],
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
  readonly canvas: Pick<CanvasService, "create" | "revise">;
  readonly uuid: () => string;
  readonly hostId: HostId;
}

interface CanvasToolInput {
  readonly operation: "create" | "revise";
  readonly title?: string;
  readonly canvasId?: string;
  readonly expectedSequence?: number;
  readonly prompt?: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
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
  if (operation !== "create" && operation !== "revise") {
    return { error: "Canvas tool operation must be create or revise." };
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
 * Lend one Chat thread's agent the ability to author a Canvas.
 *
 * Chat only for now: a Chat Canvas is bounded by virtual memory alone, so the
 * workspace it belongs to is fully determined by the thread. Work and Code
 * canvases are bounded by a confined root and a worktree, which the tool would
 * have to resolve rather than assume, and assuming one is how a document ends
 * up outside the scope it was supposed to stay in.
 */
export function createCanvasAgentTools(options: {
  readonly windowId: WindowId;
  readonly thread: ChatThread;
  readonly port: CanvasAgentToolPort;
}): AppManagedToolSet {
  return {
    definitions: [{ name: CANVAS_TOOL_NAME, inputSchema: canvasDefinitionSchema }],
    execute: async ({ inputJson }) => {
      const input = parseInput(inputJson);
      if ("error" in input) return { result: { error: input.error }, isError: true };

      const active = await options.port.activeContext(options.windowId);
      if (active === undefined || active.projectId === null || active.mode !== "chat") {
        return {
          result: { error: "This window has no Chat Project a Canvas could belong to." },
          isError: true,
        };
      }
      const project = await options.port.project(options.windowId, active.projectId);
      if (project === undefined || project.lifecycle !== "active" || project.type !== "chat") {
        return { result: { error: "The Canvas Project is unavailable." }, isError: true };
      }
      // Narrowed above: only an active Chat Project reaches here.
      const context = { mode: "chat" as const, projectId: active.projectId };
      const canvasProject = {
        id: project.id,
        type: "chat" as const,
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
            mode: "chat",
            workspace: { kind: "chat-virtual", projectId: active.projectId },
            originThreadId: options.thread.id,
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
          mode: "chat",
          workspace: { kind: "chat-virtual", projectId: active.projectId },
          originThreadId: options.thread.id,
          prompt: input.prompt ?? "Authored revision",
          actor: { kind: "agent", actorId: options.port.uuid() },
          providerInstanceId: options.thread.providerInstanceId,
          modelId: options.thread.modelId,
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
