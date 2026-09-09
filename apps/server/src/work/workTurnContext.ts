import {
  decodeContextEntry,
  decodeContextManifest,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderContextBlock,
  type ProviderInstanceId,
  type ProviderModelId,
  type WorkThreadId,
} from "@octant/contracts";
import { reduceContextToBudget } from "@octant/domain/context-policy";

/**
 * Conservative Work input budget used when the selected model has not
 * reported a window. File mentions are required entries, so exceeding this
 * refuses the turn instead of sending an unplanned 64k-character dump.
 */
export const WORK_TURN_SAFE_INPUT_TOKENS = 24_000;

const WORK_ARTIFACT_INSTRUCTIONS =
  "You are working in an Octant Work task. When the user requests a document or artifact, use your available file tools to create it inside the bound task folder and report its real relative paths. Octant's Files tool lets the user open those files; observed Markdown and plain-text documents can also appear in Document beside the conversation. Creating a file does not prove a preview opened. Use appropriate format-specific tooling for binary documents. Never invent download URLs or host artifact ids. Use only tools actually offered to this task; these instructions grant no additional access.";

export type WorkTurnContextPlan =
  | { readonly kind: "ok"; readonly context: ReadonlyArray<ProviderContextBlock> }
  | { readonly kind: "blocked"; readonly message: string };

export interface WorkTurnContextContribution {
  readonly text: string;
  readonly sourceKind: "message" | "file";
  readonly referenceId: string;
  readonly category: "conversation" | "current-request" | "workspace-context";
  readonly posture: "required" | "compressible";
  readonly block: ProviderContextBlock;
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
  const entries = contributions.map((contribution) => {
    const tokens = Math.max(16, Math.ceil(contribution.text.length / 4));
    const entry = decodeContextEntry({
      id: input.uuid(),
      source: { kind: contribution.sourceKind, referenceId: contribution.referenceId },
      category: contribution.category,
      label: contribution.text.slice(0, 64).trim() || contribution.category,
      eligibility: {
        providerInstanceId,
        status: "eligible",
        reason: "selected-provider",
      },
      posture: contribution.posture,
      retention: "active",
      priority: contribution.posture === "required" ? 100 : 20,
      originalSize: tokens,
      includedSize: tokens,
      tokens: { kind: "known", tokens, accuracy: "conservative-heuristic" },
      state: "included",
      introducedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: `${contribution.category} hidden` },
    });
    blocksByEntryId.set(String(entry.id), contribution.block);
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
    context: entries.flatMap((entry) => {
      if (!included.has(String(entry.id))) return [];
      // The current prompt is sent as the turn prompt, not as extra context.
      if (entry.category === "current-request") return [];
      const block = blocksByEntryId.get(String(entry.id));
      return block === undefined ? [] : [block];
    }),
  };
}
