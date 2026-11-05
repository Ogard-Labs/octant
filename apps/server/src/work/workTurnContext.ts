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
  documentDeliveryInstructions,
  offersCanvasTool,
} from "../canvas/canvasDeliveryInstructions";
import { appToolHostLines } from "../providers/appToolHostLines";

/**
 * Conservative Work input budget used when the selected model has not
 * reported a window. File mentions are required entries, so exceeding this
 * refuses the turn instead of sending an unplanned 64k-character dump.
 */
export const WORK_TURN_SAFE_INPUT_TOKENS = 24_000;

/**
 * Where a Work turn's files go. Whether a document becomes a file at all is
 * the delivery rule's call (Canvas, the person's artifact tool, or none), so
 * this names no delivery choice: an earlier text restated the Canvas rule here
 * and left the model to reconcile two blocks that said the same thing.
 */
const WORK_ARTIFACT_REFERENCE = "octant-work-artifacts";
const WORK_ARTIFACT_INSTRUCTIONS =
  "Files you write for the person go inside this task's folder; report their real relative paths. Use format-specific tooling for binary documents. Do not claim a file opened in a preview, and never invent download URLs or artifact ids.";

export type WorkTurnContextPlan =
  | {
      readonly kind: "ok";
      readonly manifest: ContextManifest;
      readonly context: ReadonlyArray<ProviderContextBlock>;
    }
  | { readonly kind: "blocked"; readonly message: string };

export interface WorkTurnContextContribution {
  readonly text: string;
  readonly sourceKind: "message" | "file" | "instruction" | "summary" | "memory";
  readonly referenceId: string;
  readonly category:
    | "conversation"
    | "current-request"
    | "workspace-context"
    | "octant-policy"
    | "person-memory";
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
  /**
   * Instructions that come before Work's own, such as Octant's orientation and
   * reply formats, so every mode opens its instructions the same way.
   */
  readonly leading?: ReadonlyArray<WorkTurnContextContribution>;
  readonly contributions: ReadonlyArray<WorkTurnContextContribution>;
  readonly safeInputBudget?: number;
}): WorkTurnContextPlan {
  const providerInstanceId = decodeProviderInstanceId(input.providerInstanceId);
  const modelId = decodeProviderModelId(input.modelId);
  const budget = input.safeInputBudget ?? WORK_TURN_SAFE_INPUT_TOKENS;
  const blocksByEntryId = new Map<string, ProviderContextBlock>();
  const contributions = [
    ...(input.leading ?? []),
    {
      text: WORK_ARTIFACT_INSTRUCTIONS,
      sourceKind: "instruction",
      referenceId: WORK_ARTIFACT_REFERENCE,
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
        "person-memory": "Person memory",
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
  /** The runtime's own artifact tool, when the driver offers it to this turn. */
  readonly artifactToolName?: string;
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
  // with the tools, right after Work's folder rule: orientation and reply
  // formats first, then this mode's rules, then the tool notes. The person's
  // artifact switch puts the artifact rule in its place.
  const deliveryText = documentDeliveryInstructions({
    artifactToolName: input.artifactToolName,
    canvasOffered: offersCanvasTool(input.tools),
  });
  // Each offered app tool's host line joins the plan the same way, so a
  // Browser the turn carries is named without a composer selection.
  const policyTexts = [
    ...(deliveryText === undefined
      ? []
      : [
          {
            text: deliveryText,
            referenceId:
              input.artifactToolName === undefined
                ? "octant-canvas-delivery"
                : "octant-artifact-delivery",
          },
        ]),
    ...appToolHostLines(input.tools).map((text, index) => ({
      text,
      referenceId: `octant-tool-host-line:${index}`,
    })),
  ];
  const ruleEntries: Array<ContextManifest["entries"][number]> = [];
  const noteEntries: Array<ContextManifest["entries"][number]> = [];
  for (const policy of policyTexts) {
    const deliveryTokens = Math.max(16, Math.ceil(policy.text.length / 4));
    const entry = decodeContextEntry({
      id: input.uuid(),
      source: {
        kind: "instruction",
        referenceId: policy.referenceId,
      },
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
      originalSize: deliveryTokens,
      includedSize: deliveryTokens,
      tokens: { kind: "known", tokens: deliveryTokens, accuracy: "conservative-heuristic" },
      state: "included",
      introducedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: "octant-policy hidden" },
    });
    (policy.referenceId.startsWith("octant-tool-host-line:") ? noteEntries : ruleEntries).push(
      entry,
    );
    blocks.set(String(entry.id), { kind: "instructions", text: policy.text });
  }
  return reduceWorkContext(
    decodeContextManifest({
      ...input.plan.manifest,
      entries: [
        ...placeWorkInstructions(input.plan.manifest.entries, ruleEntries, noteEntries, blocks),
        ...toolEntries,
      ],
    }),
    blocks,
    input.safeInputBudget,
  );
}

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

/**
 * The delivery rule right after Work's folder rule, and the tool notes after
 * the last standing instruction, so the notes follow every rule of the mode and
 * only the current turn's instructions come after them.
 */
function placeWorkInstructions(
  entries: ReadonlyArray<ContextManifest["entries"][number]>,
  rules: ReadonlyArray<ContextManifest["entries"][number]>,
  notes: ReadonlyArray<ContextManifest["entries"][number]>,
  blocks: ReadonlyMap<string, ProviderContextBlock>,
): ReadonlyArray<ContextManifest["entries"][number]> {
  const folderRule = entries.findIndex(
    (entry) => entry.source.referenceId === WORK_ARTIFACT_REFERENCE,
  );
  const withRules =
    folderRule === -1
      ? [...rules, ...entries]
      : [...entries.slice(0, folderRule + 1), ...rules, ...entries.slice(folderRule + 1)];
  let lastRule = -1;
  withRules.forEach((entry, index) => {
    if (blocks.get(String(entry.id))?.kind === "instructions") lastRule = index;
  });
  return [...withRules.slice(0, lastRule + 1), ...notes, ...withRules.slice(lastRule + 1)];
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
