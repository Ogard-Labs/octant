import {
  MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH,
  MAX_CODE_PLANNER_PROPOSAL_RATIONALE_LENGTH,
  MAX_CODE_THREAD_TITLE_LENGTH,
  MAX_PENDING_CODE_PLANNER_PROPOSALS,
  MAX_SIDE_TASK_PROMPT_LENGTH,
  MAX_SIDE_TASK_REASON_LENGTH,
  MAX_SIDE_TASK_TITLE_LENGTH,
  SIDE_TASK_BOARD_ALLOWLIST_ENTRY,
  SIDE_TASK_TOOL_NAME,
  decodeCodePlannerProposalDraft,
  decodeCodeThreadId,
  decodeSideTaskId,
  decodeSideTaskOffer,
  type OctantMode,
  type ProviderToolDefinition,
  type WindowId,
} from "@octant/contracts";
import { decideProfileToolConstraint, isToolAllowedByAllowlist } from "@octant/domain";
import type { CodePlannerToolPort } from "../code/codePlannerTools";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { SideTaskStore } from "./sideTaskStore";

/**
 * A board offer's fields carry both bounds at once: the side task's, which the
 * schema always states, and the planner proposal's, which the host checks on
 * the way in. The schema states the tighter of each so a model meets neither
 * as a surprise refusal.
 */
const BOARD_TITLE_LENGTH = Math.min(MAX_SIDE_TASK_TITLE_LENGTH, MAX_CODE_THREAD_TITLE_LENGTH);
const BOARD_REASON_LENGTH = Math.min(
  MAX_SIDE_TASK_REASON_LENGTH,
  MAX_CODE_PLANNER_PROPOSAL_RATIONALE_LENGTH,
);
const BOARD_PROMPT_LENGTH = Math.min(
  MAX_SIDE_TASK_PROMPT_LENGTH,
  MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH,
);

function definition(worktree: boolean, board: boolean): ProviderToolDefinition {
  const targets = [
    ...(worktree ? ["new-worktree", "new-thread"] : []),
    ...(board ? ["board"] : []),
  ];
  return {
    name: SIDE_TASK_TOOL_NAME,
    description: [
      "Offer the person a separate task you noticed while working: a real bug, stale docs, missing tests, dead code, or a security problem that is out of scope for what you were asked and would bloat this change.",
      "The person sees a card with your title and reason and decides whether to start it in its own thread; nothing starts until they do, and you should not wait for an answer or do that work here.",
      "Do not offer vague style notes, work you can finish in a line or two now, or hunches you have not checked.",
      worktree
        ? 'The prompt must stand alone for a fresh thread with none of this conversation: name the files, what you saw, and what done looks like. Target "new-worktree" (default) gives it an isolated checkout; "new-thread" works in the current checkout.'
        : "The prompt must stand alone for a fresh thread with none of this conversation: name what you saw and what done looks like.",
      ...(board
        ? [
            `As this Project's designated planner, use target "board" to propose a new task on the Project board instead: the title, the reason as its rationale, and the prompt as its intent (at most ${String(BOARD_PROMPT_LENGTH)} characters). The person reviews it in the Project planner and only they create and start it; at most ${String(MAX_PENDING_CODE_PLANNER_PROPOSALS)} proposals wait at once. Report it as proposed, never as running or done.`,
          ]
        : []),
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: board ? BOARD_TITLE_LENGTH : MAX_SIDE_TASK_TITLE_LENGTH,
          description: 'A short imperative title, e.g. "Fix stale install docs".',
        },
        reason: {
          type: "string",
          maxLength: board ? BOARD_REASON_LENGTH : MAX_SIDE_TASK_REASON_LENGTH,
          description: "One sentence: what you noticed and why it belongs in its own thread.",
        },
        prompt: {
          type: "string",
          maxLength: board ? BOARD_PROMPT_LENGTH : MAX_SIDE_TASK_PROMPT_LENGTH,
          description: "The first message of the new thread, complete on its own.",
        },
        ...(targets.length === 0 ? {} : { target: { type: "string", enum: targets } }),
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
 *
 * In a Code Project's designated planner thread it also takes target
 * `board`, which records a pending planner proposal instead of a side-task
 * card. That proposal is still only an offer: only a person confirms it in the
 * Project planner, and the planner has no creation authority of its own. The
 * designation is re-resolved on every call, so an undesignation takes effect
 * mid-turn, and the target follows its own profile allowlist entry
 * ({@link SIDE_TASK_BOARD_ALLOWLIST_ENTRY}) because proposing used to be a
 * separate tool a profile could leave out.
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
  /** The Code planner capability and the window the turn runs for; absent elsewhere. */
  readonly planner?: { readonly port: CodePlannerToolPort; readonly windowId: WindowId };
  /** The thread's snapshotted profile allowlist; empty permits every tool. */
  readonly toolConstraints?: ReadonlyArray<string>;
  readonly profileDisplayName?: string;
}): AppManagedToolSet {
  const worktree = input.mode === "code" && input.projectId !== undefined;
  const allowlist = input.toolConstraints ?? [];
  const plannerThread = () =>
    input.mode === "code" &&
    input.planner !== undefined &&
    input.planner.port.isPlannerThread(decodeCodeThreadId(input.threadId));
  const board =
    plannerThread() && isToolAllowedByAllowlist(allowlist, SIDE_TASK_BOARD_ALLOWLIST_ENTRY);
  return {
    definitions: [definition(worktree, board)],
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
      if (target === "board") {
        if (input.planner === undefined || !plannerThread()) {
          return refused(
            "Only the Project's designated planner thread may offer a task to the board.",
          );
        }
        const profile = decideProfileToolConstraint({
          toolId: SIDE_TASK_BOARD_ALLOWLIST_ENTRY,
          toolConstraints: allowlist,
          profileDisplayName: input.profileDisplayName ?? "the bound profile",
        });
        if (profile.status === "refused") return refused(profile.reason);
        return await offerToBoard(input.planner, input.threadId, parsed);
      }
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

/**
 * Records the planner's offer as a pending proposal on its Project board. The
 * proposal's own bounds and its cap on waiting proposals are the planner
 * service's to decide; this only maps the side task's fields onto it.
 */
async function offerToBoard(
  planner: { readonly port: CodePlannerToolPort; readonly windowId: WindowId },
  threadId: string,
  fields: ReadonlyMap<string, unknown>,
) {
  if ([...fields.keys()].some((key) => !["title", "reason", "prompt", "target"].includes(key))) {
    return refused("A board offer takes only a title, a reason, a prompt, and its target.");
  }
  let draft;
  try {
    draft = decodeCodePlannerProposalDraft({
      title: stringField(fields, "title"),
      intent: stringField(fields, "prompt"),
      rationale: stringField(fields, "reason"),
    });
  } catch {
    return refused(
      `A board offer needs a title (up to ${String(BOARD_TITLE_LENGTH)} characters), a one-sentence reason, and a standalone prompt of at most ${String(BOARD_PROMPT_LENGTH)} characters.`,
    );
  }
  if (draft.title.length > BOARD_TITLE_LENGTH || draft.intent.length > BOARD_PROMPT_LENGTH) {
    return refused(
      `A board offer needs a title (up to ${String(BOARD_TITLE_LENGTH)} characters), a one-sentence reason, and a standalone prompt of at most ${String(BOARD_PROMPT_LENGTH)} characters.`,
    );
  }
  let outcome: Awaited<ReturnType<CodePlannerToolPort["propose"]>>;
  try {
    outcome = await planner.port.propose(planner.windowId, decodeCodeThreadId(threadId), {
      title: draft.title,
      intent: draft.intent,
      ...(draft.rationale === undefined ? {} : { rationale: draft.rationale }),
    });
  } catch {
    return refused("The Project planner is unavailable on this host.");
  }
  if (outcome.status === "refused") return refused(outcome.message);
  return {
    result: {
      status: "pending-user-confirmation",
      proposalId: String(outcome.proposal.id),
      title: outcome.proposal.title,
      // The proposal executes nothing; only the person's explicit
      // confirmation creates the thread, through the ordinary creation command.
      message:
        "Proposed on the Project board. The person decides whether this task is created; continue with your current work.",
    },
  };
}

function stringField(fields: ReadonlyMap<string, unknown>, key: string): string {
  const value = fields.get(key);
  return typeof value === "string" ? value.trim() : "";
}
