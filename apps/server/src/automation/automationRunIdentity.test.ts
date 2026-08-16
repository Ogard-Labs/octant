import { describe, expect, it } from "vitest";
import {
  deriveAutomationOccurrenceKey,
  type AutomationOccurrence,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  automationFirstTurnRequestIdForOccurrence,
  automationRunIdForOccurrence,
  buildAutomationRunForOccurrence,
  deterministicAutomationUuid,
} from "./automationRunIdentity";
import {
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
  automationDefinitionFixture,
} from "./automationTestFixtures";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("automation run identity", () => {
  it("derives stable version-4 UUIDs from an occurrence identity", () => {
    const first = deterministicAutomationUuid("automation-run:some-key");
    const second = deterministicAutomationUuid("automation-run:some-key");
    const other = deterministicAutomationUuid("automation-run:another-key");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(UUID_PATTERN);
  });

  it("names the same run and first-turn request for the same occurrence key", () => {
    const definition = automationDefinitionFixture();
    const occurrence: AutomationOccurrence = {
      kind: "manual",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as AutomationOccurrence;
    const key = deriveAutomationOccurrenceKey(occurrence);
    expect(automationRunIdForOccurrence(key)).toBe(automationRunIdForOccurrence(key));
    expect(automationFirstTurnRequestIdForOccurrence(key)).toBe(
      automationFirstTurnRequestIdForOccurrence(key),
    );
    expect(String(automationRunIdForOccurrence(key))).not.toBe(
      String(automationFirstTurnRequestIdForOccurrence(key)),
    );
  });

  it("builds a queued scheduled run that satisfies the strict run contract", () => {
    const definition = automationDefinitionFixture();
    const occurrence: AutomationOccurrence = {
      kind: "scheduled",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      triggerKind: "once",
      scheduledAt: definition.trigger.kind === "once" ? definition.trigger.scheduledAt : undefined,
    } as AutomationOccurrence;
    const run = buildAutomationRunForOccurrence({
      definition,
      occurrence,
      now: AUTOMATION_TEST_NOW as UtcTimestamp,
    });
    expect(run.lifecycle).toBe("queued");
    expect(run.version).toBe(1);
    expect(run.automationId).toBe(definition.id);
    expect(run.occurrenceKey).toBe(deriveAutomationOccurrenceKey(occurrence));
    expect(run.id).toBe(automationRunIdForOccurrence(run.occurrenceKey));
    expect(run.firstTurnRequestId).toBe(
      automationFirstTurnRequestIdForOccurrence(run.occurrenceKey),
    );
    expect(run.scheduledAt).toBe(
      definition.trigger.kind === "once" ? definition.trigger.scheduledAt : null,
    );
    expect(run.definitionSnapshot.definitionRevision).toBe(definition.definitionRevision);
    expect(run.authoritySnapshot.effectiveAuthorityDigest).toBe(
      definition.authorityProfile.effectiveAuthorityDigest,
    );
  });

  it("builds a queued manual run with a null scheduled instant", () => {
    const definition = automationDefinitionFixture();
    const occurrence: AutomationOccurrence = {
      kind: "manual",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
    } as AutomationOccurrence;
    const run = buildAutomationRunForOccurrence({
      definition,
      occurrence,
      now: AUTOMATION_TEST_NOW as UtcTimestamp,
    });
    expect(run.scheduledAt).toBeNull();
    expect(run.occurrence).toEqual(occurrence);
  });
});
