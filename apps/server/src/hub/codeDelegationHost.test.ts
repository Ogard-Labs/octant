import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentProfileId,
  DelegationRequestId,
  ProjectId,
  decodeCodeProjectDelegatedCode,
  type DelegatedAuthority,
} from "@octant/contracts";
import {
  createCodeDelegationHost,
  delegatedCodeBranch,
  delegationHostByProjectType,
  type CodeDelegationProjectFacts,
  type CodeDelegationServices,
} from "./codeDelegationHost";
import type { PeerDelegationHost } from "./peerDelegationService";

const PROJECT = Schema.decodeUnknownSync(ProjectId)("11111111-1111-4111-8111-111111111111");
const REQUEST = Schema.decodeUnknownSync(DelegationRequestId)(
  "22222222-2222-4222-8222-222222222222",
);
const MARK = decodeCodeProjectDelegatedCode({
  remoteName: "origin",
  baseBranch: "main",
  outcomeKind: "opened-pr",
  confirmedAt: "2026-11-20T10:00:00.000Z",
});
const CODE: DelegatedAuthority = { mode: "code", posture: "approval-gated" };

function codeProject(
  overrides: Partial<CodeDelegationProjectFacts> = {},
): CodeDelegationProjectFacts {
  return {
    type: "code",
    lifecycle: "active",
    delegatedCode: MARK,
    bindingHistory: [{ revisionId: "66666666-6666-4666-8666-666666666666" }],
    ...overrides,
  };
}

function fixture(
  project: CodeDelegationProjectFacts | undefined = codeProject(),
  repository: { readonly name: string | undefined } = { name: "acme/widget" },
  helperRunRefusal: CodeDelegationServices["helperRunRefusal"] = () => undefined,
) {
  let next = 0;
  const createThread = vi.fn<CodeDelegationServices["createThread"]>(async () => ({
    kind: "managed-thread-created",
    thread: { id: "33333333-3333-4333-8333-333333333333", checkoutId: "checkout-1" },
  }));
  const startTurn = vi.fn<CodeDelegationServices["startTurn"]>(async () => "accepted");
  const host = createCodeDelegationHost({
    readProject: () => project,
    defaultProvider: () => ({ providerInstanceId: "provider-1", modelId: "model-a" }),
    helperRunRefusal,
    deliveryRepository: async () => repository.name,
    createThread,
    startTurn,
    readTurn: async () => undefined,
    cancelTurn: async () => "already-finished",
    uuid: () => `00000000-0000-4000-8000-00000000000${++next}`,
  });
  return { host, createThread, startTurn };
}

function start(host: PeerDelegationHost, overrides: { authority?: DelegatedAuthority } = {}) {
  return host.startThread({
    requestId: REQUEST,
    senderName: "Studio",
    projectId: PROJECT,
    task: "Fix the flaky login test\nIt fails one run in ten.",
    authority: overrides.authority ?? CODE,
    admissionCurrent: () => true,
  });
}

describe("a delegated Code thread", () => {
  it("is offered only in a Code Project its person marked, and never above asking first", () => {
    expect(fixture().host.projectAuthority(PROJECT)).toEqual({
      projectId: PROJECT,
      modes: ["code"],
      ceiling: "approval-gated",
    });
    expect(
      fixture(codeProject({ delegatedCode: undefined })).host.projectAuthority(PROJECT),
    ).toBeUndefined();
    expect(
      fixture(codeProject({ lifecycle: "archived" })).host.projectAuthority(PROJECT),
    ).toBeUndefined();
  });

  it("starts on its own branch from the confirmed target, approval-gated and marked as outside content", async () => {
    const { host, createThread, startTurn } = fixture();
    expect(await start(host)).toEqual({
      status: "started",
      threadId: "33333333-3333-4333-8333-333333333333",
      turnId: "00000000-0000-4000-8000-000000000002",
    });
    const [command, mark] = createThread.mock.calls[0] ?? [];
    expect(command).toMatchObject({
      kind: "create-managed-code-thread",
      executionPolicy: "approval-gated",
      title: "Studio: Fix the flaky login test",
      deliveryTarget: {
        branchIntent: delegatedCodeBranch(REQUEST, "Fix the flaky login test"),
        remoteName: "origin",
        proposedBaseRepository: "acme/widget",
        proposedBaseBranch: "main",
        outcomeKind: "opened-pr",
      },
      sourceBranch: "main",
    });
    expect(mark).toEqual({
      sourceLabel: "Task delegated by Studio",
      contentReference: `delegation:${String(REQUEST)}`,
    });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutId: "checkout-1",
        prompt: expect.stringContaining("flaky"),
      }),
    );
  });

  it("refuses an unmarked Project, a Full access or Plan request, and a named profile before creating anything", async () => {
    const unmarked = fixture(codeProject({ delegatedCode: undefined }));
    expect(await start(unmarked.host)).toEqual({ status: "refused", kind: "project-unavailable" });
    const marked = fixture();
    expect(
      await start(marked.host, { authority: { mode: "code", posture: "full-access" } }),
    ).toEqual({ status: "refused", kind: "posture-unavailable" });
    expect(await start(marked.host, { authority: { mode: "code", posture: "plan" } })).toEqual({
      status: "refused",
      kind: "posture-unavailable",
    });
    expect(
      await start(marked.host, {
        authority: {
          ...CODE,
          profileId: Schema.decodeUnknownSync(AgentProfileId)(
            "44444444-4444-4444-8444-444444444444",
          ),
        },
      }),
    ).toEqual({ status: "refused", kind: "provider-unavailable" });
    expect(unmarked.createThread).not.toHaveBeenCalled();
    expect(marked.createThread).not.toHaveBeenCalled();
  });

  it("starts no thread when the Project's first provider refuses helper runs, as Google Antigravity does", async () => {
    const { host, createThread, startTurn } = fixture(
      codeProject(),
      { name: "acme/widget" },
      (id) =>
        id === "provider-1"
          ? "Google doesn't support Google Antigravity as a helper agent."
          : undefined,
    );
    expect(await start(host)).toEqual({ status: "refused", kind: "provider-unavailable" });
    expect(createThread).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("refuses a pull-request outcome before creating anything when the confirmed remote names no repository", async () => {
    const { host, createThread } = fixture(codeProject(), { name: undefined });
    expect(await start(host)).toEqual({ status: "refused", kind: "start-failed" });
    expect(createThread).not.toHaveBeenCalled();
  });

  it("keeps the Project's own identity as the base for an outcome that opens no pull request", async () => {
    const { host, createThread } = fixture(
      codeProject({ delegatedCode: { ...MARK, outcomeKind: "local-implementation" } }),
    );
    await start(host);
    expect(createThread.mock.calls[0]?.[0]).toMatchObject({
      deliveryTarget: { proposedBaseRepository: String(PROJECT) },
    });
  });

  it("refuses as not granted when the grant ends before the provider turn starts", async () => {
    const { host, startTurn } = fixture();
    let granted = true;
    startTurn.mockImplementation(async (turn) => {
      granted = false;
      return turn.admissionCurrent() ? "accepted" : "refused";
    });
    expect(
      await host.startThread({
        requestId: REQUEST,
        senderName: "Studio",
        projectId: PROJECT,
        task: "Fix the flaky login test",
        authority: CODE,
        admissionCurrent: () => granted,
      }),
    ).toEqual({ status: "refused", kind: "delegation-not-granted" });
  });

  it("names its branch from the task and the request, under a prefix of its own", () => {
    expect(delegatedCodeBranch(REQUEST, "Fix the flaky login test!")).toBe(
      "octant/delegated/fix-the-flaky-login-test-222222222222",
    );
    expect(delegatedCodeBranch(REQUEST, "???")).toBe("octant/delegated/task-222222222222");
  });
});

describe("the delegation host for each Project type", () => {
  it("sends a Code Project to the Code host and a Work Project to the Work host, and reads go back to the host that started the thread", async () => {
    const host = (name: string): PeerDelegationHost => ({
      projectAuthority: (projectId) => ({ projectId, modes: [], ceiling: name as never }),
      startThread: async () => ({ status: "refused", kind: "start-failed" }),
      readThread: async () => ({ state: "running", summary: name, artifacts: [] }),
      interrupt: async () => "unavailable",
    });
    const types = new Map([["code-project", "code" as const]]);
    const combined = delegationHostByProjectType({
      readType: (projectId) => types.get(String(projectId)) ?? "work",
      work: host("work"),
      code: host("code"),
      codeThreads: { has: (threadId) => threadId === "code-thread" },
    });
    expect(combined.projectAuthority("code-project" as never)?.ceiling).toBe("code");
    expect(combined.projectAuthority("work-project" as never)?.ceiling).toBe("work");
    expect((await combined.readThread("code-thread", "turn"))?.summary).toBe("code");
    expect((await combined.readThread("work-thread", "turn"))?.summary).toBe("work");
  });
});
