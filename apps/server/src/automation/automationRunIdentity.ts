import { createHash } from "node:crypto";
import {
  decodeAutomationRun,
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationFirstTurnRequestId,
  type AutomationOccurrence,
  type AutomationOccurrenceKeyText,
  type AutomationRun,
  type AutomationRunId,
  type UtcTimestamp,
} from "@octant/contracts";

/**
 * Derive a stable UUID from an occurrence identity so retried commands,
 * scheduler restarts, and crash recovery all name the same aggregate.
 * Formatted as a version-4/variant-1 UUID to satisfy the strict contract id
 * schemas while remaining fully deterministic.
 */
export function deterministicAutomationUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The durable one-run-per-occurrence claim identity. */
export function automationRunIdForOccurrence(
  occurrenceKey: AutomationOccurrenceKeyText,
): AutomationRunId {
  return deterministicAutomationUuid(`automation-run:${occurrenceKey}`) as AutomationRunId;
}

/** The idempotent first-turn request identity retried across restarts. */
export function automationFirstTurnRequestIdForOccurrence(
  occurrenceKey: AutomationOccurrenceKeyText,
): AutomationFirstTurnRequestId {
  return deterministicAutomationUuid(
    `automation-first-turn:${occurrenceKey}`,
  ) as AutomationFirstTurnRequestId;
}

export interface BuildAutomationRunForOccurrenceInput {
  readonly definition: AutomationDefinition;
  readonly occurrence: AutomationOccurrence;
  readonly now: UtcTimestamp;
}

/**
 * Build the queued version-1 run for one occurrence of a definition. The run
 * id doubles as the occurrence claim, so building the same occurrence twice
 * always names the same aggregate. The definition and authority snapshots are
 * copied immutably from the exact definition revision that owns the
 * occurrence; the caller must pass that revision.
 */
export function buildAutomationRunForOccurrence(
  input: BuildAutomationRunForOccurrenceInput,
): AutomationRun {
  const { definition, occurrence, now } = input;
  const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
  return decodeAutomationRun({
    id: automationRunIdForOccurrence(occurrenceKey),
    automationId: definition.id,
    occurrence,
    occurrenceKey,
    scheduledAt: occurrence.kind === "scheduled" ? occurrence.scheduledAt : null,
    claimedAt: now,
    definitionSnapshot: {
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      displayName: definition.displayName,
      taskPrompt: definition.taskPrompt,
      hostId: definition.hostId,
      mode: definition.mode,
      projectId: definition.projectId,
      projectVersion: definition.projectVersion,
      binding: definition.binding,
      executionProfile: definition.executionProfile,
      authorityProfile: definition.authorityProfile,
      deliveryTarget: definition.deliveryTarget,
      trigger: definition.trigger,
      missedRunPolicy: definition.missedRunPolicy,
      targetPolicy: definition.targetPolicy,
    },
    authoritySnapshot: {
      profileId: definition.authorityProfile.profileId,
      profileVersion: definition.authorityProfile.profileVersion,
      requested: definition.authorityProfile.requested,
      effective: definition.authorityProfile.effective,
      effectiveAuthorityDigest: definition.authorityProfile.effectiveAuthorityDigest,
      capturedAt: now,
    },
    firstTurnRequestId: automationFirstTurnRequestIdForOccurrence(occurrenceKey),
    lifecycle: "queued",
    notificationRefs: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}
