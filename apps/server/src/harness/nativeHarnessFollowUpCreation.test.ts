import { describe, expect, it } from "vitest";
import type { NativeHarnessSessionView } from "@octant/contracts";
import {
  createNativeHarnessFollowUp,
  type NativeHarnessFollowUpCreationDependencies,
} from "./nativeHarnessFollowUpCreation";

const windowId = "00000000-0000-4000-8000-0000000000f0";
const parentThreadId = "00000000-0000-4000-8000-000000000010";
const projectId = "00000000-0000-4000-8000-0000000000bb";
const lead = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "frontier-large",
};
const now = "2026-09-05T12:00:00.000Z";

function view(mode: "chat" | "work" | "code"): NativeHarnessSessionView {
  return {
    session: { threadId: parentThreadId, mode, projectId, lead },
  } as never;
}

function dependencies(
  overrides: Partial<NativeHarnessFollowUpCreationDependencies> & {
    readonly calls?: unknown[];
  },
): NativeHarnessFollowUpCreationDependencies {
  const calls = overrides.calls ?? [];
  return {
    chat: {
      execute: async (command: unknown) => {
        calls.push(command);
        const { kind, threadId } = command as { kind: string; threadId: string };
        return kind === "create-chat-thread"
          ? ({ kind: "thread-created", thread: { id: threadId, version: 1 } } as never)
          : ({ kind: "thread-updated", thread: { id: threadId, version: 2 } } as never);
      },
    },
    work: {
      execute: async (_windowId, command) => {
        calls.push(command);
        return {
          kind: "thread-created",
          thread: { id: (command as { threadId: string }).threadId },
        } as never;
      },
    },
    code: undefined,
    readCodeThread: () => undefined,
    readProject: () => undefined,
    hostId: "local" as never,
    uuid: () => "00000000-0000-4000-8000-000000000099",
    clock: () => now,
    ...overrides,
  };
}

describe("native harness follow-up creation", () => {
  it("creates a Chat thread in the parent's Project under the lead's model and names it", async () => {
    const calls: unknown[] = [];
    const outcome = await createNativeHarnessFollowUp(dependencies({ calls }), {
      windowId,
      view: view("chat"),
      creation: { kind: "new-thread", mode: "chat", projectId, title: "Add tests" } as never,
    });
    expect(outcome).toEqual({
      kind: "created",
      created: {
        kind: "new-thread",
        mode: "chat",
        projectId,
        title: "Add tests",
        threadId: "00000000-0000-4000-8000-000000000099",
      },
    });
    expect(calls).toMatchObject([
      { kind: "create-chat-thread", title: "Add tests", projectId },
      { kind: "change-chat-provider", modelId: "frontier-large", expectedVersion: 1 },
    ]);
  });

  it("creates a Work thread on the Project's current binding and refuses without a Project", async () => {
    const calls: unknown[] = [];
    const deps = dependencies({
      calls,
      readProject: () =>
        ({ bindingHistory: [{ revisionId: "00000000-0000-4000-8000-0000000000c1" }] }) as never,
    });
    const created = await createNativeHarnessFollowUp(deps, {
      windowId,
      view: view("work"),
      creation: { kind: "new-thread", mode: "work", projectId, title: "Draft the memo" } as never,
    });
    expect(created.kind).toBe("created");
    expect(calls).toMatchObject([
      {
        kind: "create-work-thread",
        projectId,
        bindingRevisionId: "00000000-0000-4000-8000-0000000000c1",
        modelId: "frontier-large",
      },
    ]);
    const refused = await createNativeHarnessFollowUp(deps, {
      windowId,
      view: view("work"),
      creation: { kind: "new-thread", mode: "work", title: "Draft the memo" } as never,
    });
    expect(refused).toMatchObject({ kind: "refused", message: expect.stringContaining("Project") });
  });

  it("refuses a Code follow-up in a detached checkout and creates one on a branch, approval-gated", async () => {
    const calls: unknown[] = [];
    let head: { kind: "branch"; name: string; oid: string } | { kind: "detached"; oid: string } = {
      kind: "detached",
      oid: "a".repeat(40),
    };
    const deps = dependencies({
      calls,
      readCodeThread: () =>
        ({
          id: parentThreadId,
          projectId,
          deliveryTarget: {
            branchIntent: "feature/parent",
            remoteName: "origin",
            proposedBaseRepository: "octant/octant",
            proposedBaseBranch: "main",
            outcomeKind: "local-implementation",
            confirmedAt: now,
          },
        }) as never,
      code: {
        execute: (_windowId, command) => {
          calls.push(command);
          if (command.kind === "prepare-code-project-checkout") {
            return {
              kind: "checkout-prepared",
              bindingRevisionId: "00000000-0000-4000-8000-0000000000c1",
              checkout: {
                id: "00000000-0000-4000-8000-0000000000d1",
                repositoryId: `repo_${"e".repeat(64)}`,
                kind: "existing-worktree",
                availability: "available",
                head,
                observedAt: now,
              },
            } as never;
          }
          return { kind: "thread-created", thread: { id: "created" } } as never;
        },
      },
    });
    const creation = {
      kind: "new-thread",
      mode: "code",
      projectId,
      title: "Fix the parser",
    } as never;
    const refused = await createNativeHarnessFollowUp(deps, {
      windowId,
      view: view("code"),
      creation,
    });
    expect(refused).toMatchObject({ kind: "refused", message: expect.stringContaining("branch") });

    head = { kind: "branch", name: "feature/parent", oid: "b".repeat(40) };
    const created = await createNativeHarnessFollowUp(deps, {
      windowId,
      view: view("code"),
      creation,
    });
    expect(created).toMatchObject({
      kind: "created",
      created: { threadId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(calls.at(-1)).toMatchObject({
      kind: "create-code-thread",
      thread: {
        executionPolicy: "approval-gated",
        modelId: "frontier-large",
        deliveryTarget: { branchIntent: "feature/parent", proposedBaseBranch: "main" },
      },
    });
  });
});
