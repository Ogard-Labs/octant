import { expect, it } from "vitest";
import {
  decodeAutomationThreadId,
  decodeBrowserThreadId,
  decodeAutomationDefinitionRevision,
  decodeAggregateVersion,
  decodeToolActionAuthority,
  decodeAutomationDefinition,
  decodeCodeThreadId,
  decodeWorktreeReceiptId,
} from "@octant/contracts";
import {
  automationDefinitionFixture,
  automationRunForDefinition,
} from "../automation/automationTestFixtures";
import { deriveManagedWorktreeCheckoutId } from "../code/managedCodeThreadCreation";
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

it("uses the dispatched Code thread's own managed checkout without broadening reviewed authority", () => {
  const work = automationDefinitionFixture();
  if (work.binding.kind !== "work") throw Error("Expected Work fixture");
  const definition = decodeAutomationDefinition({
    ...work,
    mode: "code",
    binding: {
      kind: "code",
      hostId: work.hostId,
      projectId: work.projectId,
      projectVersion: work.projectVersion,
      bindingRevisionId: work.binding.bindingRevisionId,
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: "aa000000-0000-4000-8000-0000000000d1",
      worktreeReceiptId: "aa000000-0000-4000-8000-0000000000d2",
    },
    executionProfile: { ...work.executionProfile, mode: "code" },
    deliveryTarget: { ...work.deliveryTarget, mode: "code" },
  });
  if (definition.binding.kind !== "code") throw Error("Expected Code binding");
  const binding = definition.binding;
  const target = currentRoutineBrowserTarget({
    definition,
    project: {
      id: definition.projectId,
      type: "code",
      lifecycle: "active",
      version: definition.projectVersion,
      bindingHistory: [{ revisionId: binding.bindingRevisionId }],
    },
    toolHostId: deriveToolHostId("/test-host"),
    providerEligible: true,
    executionProfileCurrent: true,
  });
  if (target === undefined) throw Error("Expected eligible target");
  const threadId = decodeBrowserThreadId("90000000-0000-4000-8000-000000000001");
  const checkoutId = deriveManagedWorktreeCheckoutId({
    repositoryId: binding.repositoryId,
    threadId,
  });
  const thread = {
    id: decodeCodeThreadId(String(threadId)),
    projectId: definition.projectId,
    bindingRevisionId: binding.bindingRevisionId,
    repositoryId: binding.repositoryId,
    checkoutId,
    providerInstanceId: definition.executionProfile.providerInstanceId,
    modelId: definition.executionProfile.modelId,
  };
  const checkout = {
    id: checkoutId,
    repositoryId: binding.repositoryId,
    kind: "managed-worktree" as const,
    availability: "available" as const,
    head: { kind: "none" as const },
    ownershipReceiptId: decodeWorktreeReceiptId("aa000000-0000-4000-8000-0000000000d2"),
    observedAt: work.createdAt,
  };
  const input = {
    definition,
    target,
    threadId,
    run: {
      ...automationRunForDefinition(definition),
      lifecycle: "running" as const,
      threadId: decodeAutomationThreadId(String(threadId)),
    },
    authority: decodeToolActionAuthority({ ...target.target.authority, worktreeId: checkoutId }),
    codeExecution: { thread, checkout },
  };
  const followUp = decodeAutomationDefinition({
    ...definition,
    targetPolicy: "same-thread",
    originThreadId: threadId,
    missedRunPolicy: "run-once",
  });
  const sameThread = {
    ...input,
    definition: followUp,
    run: {
      ...automationRunForDefinition(followUp),
      lifecycle: "running" as const,
      threadId: decodeAutomationThreadId(String(threadId)),
    },
    authority: target.target.authority,
    codeExecution: {
      thread: { ...thread, checkoutId: binding.checkoutId },
      checkout: {
        id: binding.checkoutId,
        repositoryId: binding.repositoryId,
        kind: "existing-worktree" as const,
        availability: "available" as const,
        head: { kind: "none" as const },
        observedAt: work.createdAt,
      },
    },
  };
  expect(routineBrowserExecutionIsCurrent(sameThread)).toBe(true);
  expect(
    routineBrowserExecutionIsCurrent({
      ...sameThread,
      definition: {
        ...followUp,
        originThreadId: decodeAutomationThreadId("90000000-0000-4000-8000-000000000099"),
      },
    }),
  ).toBe(false);
  expect(
    routineBrowserExecutionIsCurrent({
      ...sameThread,
      codeExecution: input.codeExecution,
      authority: input.authority,
    }),
  ).toBe(false);
  expect(String(checkoutId)).not.toBe(String(binding.checkoutId));
  expect(routineBrowserExecutionIsCurrent(input)).toBe(true);
  expect(routineBrowserExecutionIsCurrent({ ...input, codeExecution: undefined })).toBe(false);
  expect(routineBrowserExecutionIsCurrent({ ...input, authority: target.target.authority })).toBe(
    false,
  );
  expect(
    routineBrowserExecutionIsCurrent({
      ...input,
      codeExecution: { thread, checkout: { ...checkout, availability: "unavailable" } },
    }),
  ).toBe(false);
  expect(
    routineBrowserExecutionIsCurrent({
      ...input,
      codeExecution: { thread: { ...thread, checkoutId: binding.checkoutId }, checkout },
    }),
  ).toBe(false);
  expect(
    routineBrowserExecutionIsCurrent({
      ...input,
      authority: decodeToolActionAuthority({
        ...input.authority,
        rootId: "90000000-0000-4000-8000-000000000099",
      }),
    }),
  ).toBe(false);
});
