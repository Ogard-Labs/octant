import {
  decodeContextEntry,
  decodeContextManifest,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ContextManifest,
  type ContextSummaryId,
  type ProviderToolDefinition,
  type ProviderContextBlock,
  type ProviderInstanceId,
  type ProviderModelId,
  type WorkThreadId,
} from "@octant/contracts";
import { reduceContextToBudget } from "@octant/domain/context-policy";
import {
  CANVAS_DELIVERY_INSTRUCTIONS,
  offersCanvasTool,
} from "../canvas/canvasDeliveryInstructions";

/**
 * Conservative Work input budget used when the selected model has not
 * reported a window. File mentions are required entries, so exceeding this
 * refuses the turn instead of sending an unplanned 64k-character dump.
 */
export const WORK_TURN_SAFE_INPUT_TOKENS = 24_000;

const WORK_ARTIFACT_INSTRUCTIONS =
  "You are working in an Octant Work task. When a document belongs in the task folder (the user asked for a file, or no Canvas tool is offered), use your available file tools to create it inside the bound task folder and report its real relative paths. Octant's Files tool lets the user open those files; observed Markdown and plain-text documents can also appear in Document beside the conversation. Creating a file does not prove a preview opened. Use appropriate format-specific tooling for binary documents. Never invent download URLs or host artifact ids. Use only tools actually offered to this task; these instructions grant no additional access.";

export type WorkTurnContextPlan =
  | {
      readonly kind: "ok";
      readonly manifest: ContextManifest;
      readonly context: ReadonlyArray<ProviderContextBlock>;
    }
  | { readonly kind: "blocked"; readonly message: string };

export interface WorkTurnContextContribution {
  readonly text: string;
  readonly sourceKind: "message" | "file" | "instruction" | "summary";
  readonly referenceId: string;
  readonly category: "conversation" | "current-request" | "workspace-context" | "octant-policy";
  readonly posture: "required" | "compressible";
  readonly block: ProviderContextBlock;
  /**
   * The journaled summary that already stands for this message. The entry
   * stays in the manifest so the next turn still knows it is compacted, but it
   * costs nothing and is not sent: the summary carries it.
   */
  readonly summaryId?: ContextSummaryId;
}

/**
 * Attribute this Work turn's prompt, prior transcript, and mentioned files
 * as a ContextManifest and run the budget planner. Explicitly selected file
 * contents are required; if they cannot fit, the turn is refused.
 */
export function planWorkTurnContext(input: {
  readonly threadId: WorkThreadId;
  readonly providerInstanceId: ProviderInstanceId | string;
  readonly modelId: ProviderModelId | string;
  readonly uuid: () => string;
  readonly createdAt: string;
  readonly contributions: ReadonlyArray<WorkTurnContextContribution>;
  readonly safeInputBudget?: number;
}): WorkTurnContextPlan {
  const providerInstanceId = decodeProviderInstanceId(input.providerInstanceId);
  const modelId = decodeProviderModelId(input.modelId);
  const budget = input.safeInputBudget ?? WORK_TURN_SAFE_INPUT_TOKENS;
  const blocksByEntryId = new Map<string, ProviderContextBlock>();
  const contributions = [
    {
      text: WORK_ARTIFACT_INSTRUCTIONS,
      sourceKind: "instruction",
      referenceId: "octant-work-artifacts",
      category: "octant-policy",
      posture: "required",
      block: { kind: "instructions", text: WORK_ARTIFACT_INSTRUCTIONS },
    } as const,
    ...input.contributions,
  ];
  const entries = contributions.map((contribution: WorkTurnContextContribution) => {
    const tokens = Math.max(16, Math.ceil(contribution.text.length / 4));
    const summarized = contribution.summaryId !== undefined;
    const entry = decodeContextEntry({
      id: input.uuid(),
      source: { kind: contribution.sourceKind, referenceId: contribution.referenceId },
      category: contribution.category,
      label: {
        conversation: "Earlier conversation",
        "current-request": "Current request",
        "workspace-context": "Workspace context",
        "octant-policy": "Work instructions",
      }[contribution.category],
      eligibility: {
        providerInstanceId,
        status: "eligible",
        reason: "selected-provider",
      },
      posture: contribution.posture,
      retention: "active",
      priority: contribution.posture === "required" ? 100 : 20,
      originalSize: tokens,
      includedSize: summarized ? 0 : tokens,
      tokens: {
        kind: "known",
        tokens: summarized ? 0 : tokens,
        accuracy: "conservative-heuristic",
      },
      state: summarized ? "summarized" : "included",
      introducedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: `${contribution.category} hidden` },
      ...(contribution.summaryId === undefined ? {} : { summaryId: contribution.summaryId }),
    });
    if (!summarized) blocksByEntryId.set(String(entry.id), contribution.block);
    return entry;
  });
  const manifest = decodeContextManifest({
    id: input.uuid(),
    subject: decodeContextSubjectRef({
      aggregateType: "work-thread",
      aggregateId: String(input.threadId),
    }),
    providerInstanceId,
    modelId,
    entries,
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: input.createdAt,
  });
  return reduceWorkContext(manifest, blocksByEntryId, budget);
}

export function includeWorkToolDefinitions(input: {
  readonly plan: Extract<WorkTurnContextPlan, { readonly kind: "ok" }>;
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
  readonly uuid: () => string;
  readonly safeInputBudget: number;
}): WorkTurnContextPlan {
  const blocks = new Map<string, ProviderContextBlock>();
  let blockIndex = 0;
  for (const entry of input.plan.manifest.entries) {
    if (!sendsWorkBlock(entry)) continue;
    const block = input.plan.context[blockIndex++];
    if (block !== undefined) blocks.set(String(entry.id), block);
  }
  const toolEntries = input.tools.map((tool) => {
    const tokens = Math.max(16, Math.ceil(JSON.stringify(tool).length / 4));
    return decodeContextEntry({
      id: input.uuid(),
      source: { kind: "tool", referenceId: tool.name },
      category: "octant-tools",
      label: tool.name,
      eligibility: {
        providerInstanceId: input.plan.manifest.providerInstanceId,
        status: "eligible",
        reason: "selected-provider",
      },
      posture: "required",
      retention: "active",
      priority: 100,
      originalSize: tokens,
      includedSize: tokens,
      tokens: { kind: "known", tokens, accuracy: "conservative-heuristic" },
      state: "included",
      introducedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: "Tool definition hidden" },
    });
  });
  // The Canvas tool is known only here, so its delivery rule joins the plan
  // with the tools and leads the context like the other Work instructions.
  const canvasEntries = offersCanvasTool(input.tools)
    ? [
        decodeContextEntry({
          id: input.uuid(),
          source: { kind: "instruction", referenceId: "octant-canvas-delivery" },
          category: "octant-policy",
          label: "Work instructions",
          eligibility: {
            providerInstanceId: input.plan.manifest.providerInstanceId,
            status: "eligible",
            reason: "selected-provider",
          },
          posture: "required",
          retention: "active",
          priority: 100,
          originalSize: canvasInstructionTokens,
          includedSize: canvasInstructionTokens,
          tokens: {
            kind: "known",
            tokens: canvasInstructionTokens,
            accuracy: "conservative-heuristic",
          },
          state: "included",
          introducedAtTurn: 1,
          reuseCount: 0,
          preview: { redacted: true, label: "octant-policy hidden" },
        }),
      ]
    : [];
  for (const entry of canvasEntries) {
    blocks.set(String(entry.id), { kind: "instructions", text: CANVAS_DELIVERY_INSTRUCTIONS });
  }
  return reduceWorkContext(
    decodeContextManifest({
      ...input.plan.manifest,
      entries: [...canvasEntries, ...input.plan.manifest.entries, ...toolEntries],
    }),
    blocks,
    input.safeInputBudget,
  );
}

const canvasInstructionTokens = Math.max(16, Math.ceil(CANVAS_DELIVERY_INSTRUCTIONS.length / 4));

/**
 * Whether a planned entry has a block in the plan's `context`, which lists
 * blocks in manifest order without naming their entries. The current prompt
 * is sent as the turn prompt, and a summarized message is carried by its
 * summary, so neither has a block.
 */
export function sendsWorkBlock(entry: ContextManifest["entries"][number]): boolean {
  return (
    entry.state !== "omitted" &&
    entry.state !== "summarized" &&
    entry.category !== "current-request"
  );
}

function reduceWorkContext(
  manifest: ContextManifest,
  blocksByEntryId: ReadonlyMap<string, ProviderContextBlock>,
  budget: number,
): WorkTurnContextPlan {
  const entries = manifest.entries;
  const reduction = reduceContextToBudget(manifest, budget);
  if (reduction.blocked) {
    return {
      kind: "blocked",
      message:
        "Work instructions, mentioned files, and prior context exceed the model's input budget. Remove a file mention or start a new thread.",
    };
  }
  const included = new Set(reduction.includedEntryIds.map((id) => String(id)));
  return {
    kind: "ok",
    manifest: decodeContextManifest({
      ...manifest,
      entries: entries.map((entry) =>
        included.has(String(entry.id))
          ? entry
          : {
              ...entry,
              state: "omitted",
              includedSize: 0,
            },
      ),
    }),
    context: entries.flatMap((entry) => {
      if (!included.has(String(entry.id))) return [];
      // The current prompt is sent as the turn prompt, not as extra context.
      if (entry.category === "current-request") return [];
      const block = blocksByEntryId.get(String(entry.id));
      return block === undefined ? [] : [block];
    }),
  };
}
