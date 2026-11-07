import { expect, it } from "vitest";
import {
  decodeAutomationThreadId,
  decodeBrowserThreadId,
  decodeAutomationDefinitionRevision,
  decodeAggregateVersion,
} from "@octant/contracts";
import {
  automationDefinitionFixture,
  automationRunForDefinition,
} from "../automation/automationTestFixtures";
import { deriveToolHostId } from "./browserAuthorityResolver";
import {
  currentRoutineBrowserTarget,
  routineBrowserExecutionIsCurrent,
} from "./browserRoutineSessions";

it("binds a recurring permission to its definition rather than routine observation counters", () => {
  const definition = automationDefinitionFixture();
  const project = {
    id: definition.projectId,
    type: definition.mode,
    lifecycle: "active" as const,
    version: definition.projectVersion,
    bindingHistory: [
      {
        revisionId: definition.binding.kind === "chat" ? "" : definition.binding.bindingRevisionId,
      },
    ],
  };
  const input = {
    definition,
    project,
    toolHostId: deriveToolHostId("/test-host"),
    providerEligible: true,
    executionProfileCurrent: true,
  };
  const target = currentRoutineBrowserTarget(input);
  expect(target?.target.grantee).toEqual({ kind: "routine", routineId: definition.id });
  expect(
    currentRoutineBrowserTarget({
      ...input,
      definition: { ...definition, version: decodeAggregateVersion(definition.version + 1) },
    })?.revision,
  ).toBe(target?.revision);
  expect(
    currentRoutineBrowserTarget({
      ...input,
      definition: {
        ...definition,
        definitionRevision: decodeAutomationDefinitionRevision(definition.definitionRevision + 1),
      },
    })?.revision,
  ).not.toBe(target?.revision);
  expect(currentRoutineBrowserTarget({ ...input, providerEligible: false })).toBeUndefined();
  expect(currentRoutineBrowserTarget({ ...input, executionProfileCurrent: false })).toBeUndefined();
  expect(
    currentRoutineBrowserTarget({ ...input, definition: { ...definition, lifecycle: "paused" } }),
  ).toBeUndefined();
  expect(
    currentRoutineBrowserTarget({
      ...input,
      project: { ...project, version: decodeAggregateVersion(project.version + 1) },
    }),
  ).toBeUndefined();
  const threadId = decodeBrowserThreadId("90000000-0000-4000-8000-000000000001");
  const run = {
    ...automationRunForDefinition(definition),
    lifecycle: "running" as const,
    threadId: decodeAutomationThreadId(String(threadId)),
  };
  const execution = { definition, target, threadId, authority: target?.target.authority, run };
  expect(routineBrowserExecutionIsCurrent(execution)).toBe(true);
  expect(
    routineBrowserExecutionIsCurrent({ ...execution, run: { ...run, lifecycle: "completed" } }),
  ).toBe(false);
  expect(
    routineBrowserExecutionIsCurrent({
      ...execution,
      threadId: decodeBrowserThreadId("90000000-0000-4000-8000-000000000002"),
    }),
  ).toBe(false);
  expect(
    routineBrowserExecutionIsCurrent({
      ...execution,
      definition: {
        ...definition,
        definitionRevision: decodeAutomationDefinitionRevision(definition.definitionRevision + 1),
      },
    }),
  ).toBe(false);
  expect(routineBrowserExecutionIsCurrent({ ...execution, authority: undefined })).toBe(false);
});
