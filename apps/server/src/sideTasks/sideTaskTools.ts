import {
  MAX_SIDE_TASK_PROMPT_LENGTH,
  MAX_SIDE_TASK_REASON_LENGTH,
  MAX_SIDE_TASK_TITLE_LENGTH,
  SIDE_TASK_TOOL_NAME,
  decodeSideTaskId,
  decodeSideTaskOffer,
  type OctantMode,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { SideTaskStore } from "./sideTaskStore";

function definition(worktree: boolean): ProviderToolDefinition {
  return {
    name: SIDE_TASK_TOOL_NAME,
    description: [
      "Offer the person a separate task you noticed while working: a real bug, stale docs, missing tests, dead code, or a security problem that is out of scope for what you were asked and would bloat this change.",
      "The person sees a card with your title and reason and decides whether to start it in its own thread; nothing starts until they do, and you should not wait for an answer or do that work here.",
      "Do not offer vague style notes, work you can finish in a line or two now, or hunches you have not checked.",
      worktree
        ? 'The prompt must stand alone for a fresh thread with none of this conversation: name the files, what you saw, and what done looks like. Target "new-worktree" (default) gives it an isolated checkout; "new-thread" works in the current checkout.'
        : "The prompt must stand alone for a fresh thread with none of this conversation: name what you saw and what done looks like.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: MAX_SIDE_TASK_TITLE_LENGTH,
          description: 'A short imperative title, e.g. "Fix stale install docs".',
        },
        reason: {
          type: "string",
          maxLength: MAX_SIDE_TASK_REASON_LENGTH,
          description: "One sentence: what you noticed and why it belongs in its own thread.",
        },
        prompt: {
          type: "string",
          maxLength: MAX_SIDE_TASK_PROMPT_LENGTH,
          description: "The first message of the new thread, complete on its own.",
        },
        ...(worktree ? { target: { type: "string", enum: ["new-worktree", "new-thread"] } } : {}),
      },
      required: ["title", "reason", "prompt"],
      additionalProperties: false,
    },
  };
}

function refused(message: string) {
  return { result: { status: "refused", message }, isError: true } as const;
}

/**
 * The side-task tool for one thread's turn. Calling it only records an
 * offer; the answer tells the model so, and never reports what the person
 * later decides.
 */
export function createSideTaskTools(input: {
  readonly store: Pick<SideTaskStore, "offer">;
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly projectId?: string | undefined;
  /** The thread's own model; decoded with the offer. */
  readonly suggestedBy: { readonly providerInstanceId: string; readonly modelId: string };
  readonly uuid: () => string;
  readonly clock: () => string;
}): AppManagedToolSet {
  const worktree = input.mode === "code" && input.projectId !== undefined;
  return {
    definitions: [definition(worktree)],
    execute: async ({ inputJson, signal }) => {
      if (signal?.aborted) return refused("The turn was cancelled.");
      let raw: unknown;
      try {
        raw = JSON.parse(inputJson);
      } catch {
        return refused("The tool input is not valid JSON.");
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return refused("The tool input must be an object with a title, reason, and prompt.");
      }
      const parsed = new Map<string, unknown>(Object.entries(raw));
      const target = parsed.get("target") ?? (worktree ? "new-worktree" : "new-thread");
      if (target === "new-worktree" && !worktree) {
        return refused('A worktree is only available in a Code thread; use "new-thread".');
      }
      let offer;
      try {
        offer = decodeSideTaskOffer({
          id: decodeSideTaskId(input.uuid()),
          threadId: input.threadId,
          mode: input.mode,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          suggestedBy: {
            providerInstanceId: input.suggestedBy.providerInstanceId,
            modelId: input.suggestedBy.modelId,
          },
          title: stringField(parsed, "title"),
          reason: stringField(parsed, "reason"),
          prompt: stringField(parsed, "prompt"),
          target,
          offeredAt: input.clock(),
        });
      } catch {
        return refused(
          `A title (up to ${MAX_SIDE_TASK_TITLE_LENGTH} characters), a one-sentence reason, and a standalone prompt are required.`,
        );
      }
      const outcome = input.store.offer(offer);
      if (outcome === "too-many-open") {
        return refused(
          "This thread already has several side tasks waiting on the person; mention this one in your reply instead.",
        );
      }
      return {
        result: {
          status: "offered",
          message:
            "The person sees this as a card and decides whether to start it. Continue with your current task.",
        },
      };
    },
  };
}

function stringField(fields: ReadonlyMap<string, unknown>, key: string): string {
  const value = fields.get(key);
  return typeof value === "string" ? value.trim() : "";
}
