import { expect, it, vi } from "vitest";
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
  routineBrowserToolLevel,
  routineBrowserExecutionIsCurrent,
  withRoutineBrowserProfiles,
} from "./browserRoutineSessions";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

it("keeps refused stored-profile calls separate until a routine explicitly returns to Private", async () => {
  const privateExecute = vi.fn(async () => ({ result: { page: "Private" } }));
  const stop = JSON.stringify({ operation: "stop" });
  const profileExecute = vi.fn(async (call: Parameters<AppManagedToolSet["execute"]>[0]) =>
    call.inputJson === stop
      ? { result: { status: "stopped" }, isError: false }
      : { result: { error: "browser-session-permission-required" }, isError: true },
  );
  const definitions = [{ name: "octant_browser", inputSchema: { type: "object" } }];
  const tools = withRoutineBrowserProfiles({
    privateTools: { definitions, execute: privateExecute },
    profileTools: { definitions, execute: profileExecute },
  });
  const execute = (input: unknown) =>
    tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
  expect(await execute({ operation: "navigate", url: "https://example.com" })).toEqual({
    result: { page: "Private" },
  });
  expect(
    await execute({ operation: "navigate", url: "https://example.com", profile: "personal" }),
  ).toMatchObject({ isError: true, result: { error: "browser-session-permission-required" } });
  expect(privateExecute).toHaveBeenLastCalledWith({ name: "octant_browser", inputJson: stop });
  expect(await execute({ operation: "snapshot" })).toMatchObject({
    isError: true,
    result: { error: "browser-session-permission-required" },
  });
  expect(privateExecute).toHaveBeenCalledTimes(2);
  expect(
    await execute({ operation: "navigate", url: "https://example.com", profile: "private" }),
  ).toEqual({ result: { page: "Private" } });
  expect(profileExecute).toHaveBeenLastCalledWith({ name: "octant_browser", inputJson: stop });
});

it("withholds an earlier page's observation and refuses concurrent calls while a routine changes profile", async () => {
  type Answer = Awaited<ReturnType<AppManagedToolSet["execute"]>>;
  let finishRead = (_answer: Answer) => {};
  let finishStop = (_answer: Answer) => {};
  const reading = new Promise<Answer>((resolve) => {
    finishRead = resolve;
  });
  const stopping = new Promise<Answer>((resolve) => {
    finishStop = resolve;
  });
  const privateExecute = vi.fn(async (call: Parameters<AppManagedToolSet["execute"]>[0]) =>
    call.inputJson === JSON.stringify({ operation: "stop" }) ? stopping : reading,
  );
  const profileExecute = vi.fn(async () => ({ result: { page: "Personal" } }));
  const definitions = [{ name: "octant_browser", inputSchema: { type: "object" } }];
  const tools = withRoutineBrowserProfiles({
    privateTools: { definitions, execute: privateExecute },
    profileTools: { definitions, execute: profileExecute },
  });
  const snapshot = { name: "octant_browser", inputJson: JSON.stringify({ operation: "snapshot" }) };
  const oldRead = tools.execute(snapshot);
  const switching = tools.execute({
    name: "octant_browser",
    inputJson: JSON.stringify({
      operation: "navigate",
      url: "https://example.com",
      profile: "personal",
    }),
  });
  try {
    expect(await tools.execute(snapshot)).toMatchObject({
      isError: true,
      result: { error: "browser-busy" },
    });
    expect(profileExecute).not.toHaveBeenCalled();
    finishRead({ result: { page: "earlier private content" } });
    expect(await oldRead).toEqual({
      result: { error: "browser-context-changed", effect: "unknown" },
      isError: true,
    });
    finishStop({ result: { status: "stopped" } });
    expect(await switching).toEqual({ result: { page: "Personal" } });
    expect(profileExecute).toHaveBeenCalledOnce();
  } finally {
    finishRead({ result: { status: "stopped" } });
    finishStop({ result: { status: "stopped" } });
    await Promise.all([oldRead, switching]);
    await tools.close?.();
  }
});

it("reads a routine's Browser tool gate at the level its turn runs at, and at Full access between turns only when it runs at its Project's level", () => {
  const definition = automationDefinitionFixture();
  const optedIn = { ...definition, projectLevel: "opted-in" as const };
  const fullAccessTurn = { executionPolicy: "full-access" as const, fullAccessSandbox: undefined };
  const guardedTurn = { executionPolicy: "approval-gated" as const, fullAccessSandbox: undefined };

  expect(routineBrowserToolLevel(optedIn, fullAccessTurn)).toEqual(fullAccessTurn);
  expect(routineBrowserToolLevel(optedIn, guardedTurn)).toEqual(guardedTurn);
  // No turn runs while a person reviews the routine's Browser permission. A
  // routine opted into its Project's level may run at Full access, so its
  // target stays reviewable on a runtime that carries tools only there.
  expect(routineBrowserToolLevel(optedIn, undefined)).toEqual({ executionPolicy: "full-access" });
  // Every other routine runs below Full access, where the guarded
  // capability alone answers.
  expect(routineBrowserToolLevel(definition, undefined)).toBeUndefined();
});

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
