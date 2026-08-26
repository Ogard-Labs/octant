import {
  decodeContextEntry,
  decodeProviderInstanceId,
  type CodeThread,
  type ContextEntry,
  type ProviderContextBlock,
} from "@octant/contracts";
import {
  attributeProfileInstructions,
  attributeProfileSkillInstructions,
  type ProfileContextAttribution,
} from "@octant/domain/agent-profile-policy";

export interface CodeProfileSkillContribution {
  readonly qualifiedId: string;
  readonly displayName: string;
  readonly text: string;
}

export interface ComposedCodeProfileContext {
  readonly entries: ReadonlyArray<ContextEntry>;
  readonly blocks: ReadonlyArray<ProviderContextBlock>;
}

/**
 * Compose snapshotted profile instructions and admitted skills as attributed
 * Code context. A thread without a snapshot contributes nothing, so a thread
 * that never bound a profile is unchanged.
 */
export function composeCodeProfileContext(input: {
  readonly thread: Pick<CodeThread, "id" | "providerInstanceId" | "profileId" | "profileContext">;
  readonly skills?: ReadonlyArray<CodeProfileSkillContribution>;
  readonly uuid: () => string;
}): ComposedCodeProfileContext {
  const snapshot = input.thread.profileContext;
  if (snapshot === undefined) return { entries: [], blocks: [] };

  const attributions: ProfileContextAttribution[] = [];
  if (snapshot.instructions !== undefined && input.thread.profileId !== undefined) {
    attributions.push(
      attributeProfileInstructions({
        profileId: String(input.thread.profileId),
        displayName: snapshot.displayName,
        instructions: snapshot.instructions,
      }),
    );
  }
  for (const skill of input.skills ?? []) {
    attributions.push(
      attributeProfileSkillInstructions({
        qualifiedId: skill.qualifiedId,
        displayName: skill.displayName,
        text: skill.text,
      }),
    );
  }

  const providerInstanceId = decodeProviderInstanceId(input.thread.providerInstanceId);
  const entries: ContextEntry[] = [];
  const blocks: ProviderContextBlock[] = [];
  for (const attribution of attributions) {
    const tokens = Math.max(16, Math.ceil(attribution.text.length / 4));
    entries.push(
      decodeContextEntry({
        id: input.uuid(),
        source: { kind: attribution.sourceKind, referenceId: attribution.referenceId },
        category: attribution.category,
        label: attribution.label,
        eligibility: {
          providerInstanceId,
          status: "eligible",
          reason: "selected-provider",
        },
        posture: attribution.sourceKind === "instruction" ? "required" : "compressible",
        retention: "active",
        priority: attribution.sourceKind === "instruction" ? 100 : 20,
        originalSize: tokens,
        includedSize: tokens,
        tokens: { kind: "known", tokens, accuracy: "conservative-heuristic" },
        state: "included",
        introducedAtTurn: 1,
        reuseCount: 0,
        preview: { redacted: true, label: attribution.label },
      }),
    );
    blocks.push({ kind: "instructions", text: attribution.text });
  }
  return { entries, blocks };
}
