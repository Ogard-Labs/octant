import { describe, expect, it } from "vitest";
import {
  WORK_THREAD_EVENT_NAMES,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
  decodeWorkThreadCommand,
  decodeWorkThreadCommandResult,
  decodeWorkThreadId,
} from "./workThreads";
import { decodeWorkspaceTab } from "./shell";

const now = "2026-07-26T21:00:00.000Z";

const ids = {
  thread: "00000000-0000-4000-8000-000000000101",
  project: "20000000-0000-4000-8000-000000000001",
  provider: "10000000-0000-4000-8000-000000000001",
  tab: "30000000-0000-4000-8000-000000000001",
} as const;

const threadFixture = {
  id: ids.thread,
  projectId: ids.project,
  title: "Release notes",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "gemma4:latest",
  version: 1,
  createdAt: now,
  updatedAt: now,
} as const;

describe("work thread contracts", () => {
  it("brands WorkThreadId and rejects non-uuid values", () => {
    expect(decodeWorkThreadId(ids.thread)).toBe(ids.thread);
    expect(() => decodeWorkThreadId("not-a-uuid")).toThrow();
  });

  it("decodes WorkThread with required projectId and rejects excess fields", () => {
    expect(decodeWorkThread(threadFixture)).toEqual(threadFixture);
    expect(
      decodeWorkThread({
        ...threadFixture,
        workingDirectory: "research/brief",
      }),
    ).toMatchObject({ workingDirectory: "research/brief" });
    expect(() => decodeWorkThread({ ...threadFixture, projectId: undefined })).toThrow();
    expect(() => decodeWorkThread({ ...threadFixture, secret: "x" })).toThrow();
  });

  it("decodes create-work-thread command and bootstrap", () => {
    const create = decodeWorkThreadCommand({
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Release notes",
      providerInstanceId: ids.provider,
      modelId: "gemma4:latest",
      hostId: "local",
      bindingRevisionId: ids.tab,
    });
    expect(create.kind).toBe("create-work-thread");
    if (create.kind === "create-work-thread") {
      expect(create.bindingRevisionId).toBe(ids.tab);
    }
    expect(
      decodeWorkThreadCommand({
        kind: "change-work-thread-working-directory",
        threadId: ids.thread,
        expectedVersion: 1,
        workingDirectory: "research/brief",
      }).kind,
    ).toBe("change-work-thread-working-directory");

    const bootstrap = decodeWorkThreadBootstrap({ threads: [threadFixture] });
    expect(bootstrap.threads).toHaveLength(1);

    expect(() =>
      decodeWorkThreadCommand({
        kind: "create-work-thread",
        threadId: ids.thread,
        title: "missing project",
        providerInstanceId: ids.provider,
        modelId: "gemma4:latest",
        hostId: "local",
        bindingRevisionId: ids.tab,
      }),
    ).toThrow();
    expect(() =>
      decodeWorkThreadCommand({
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "missing binding",
        providerInstanceId: ids.provider,
        modelId: "gemma4:latest",
        hostId: "local",
      }),
    ).toThrow();
    expect(
      decodeWorkThreadCommand({
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Release notes",
        providerInstanceId: ids.provider,
        modelId: "gemma4:latest",
        hostId: "local",
        bindingRevisionId: ids.tab,
        issueContext: { owner: "octant", name: "octant", number: 7 },
      }),
    ).toMatchObject({
      kind: "create-work-thread",
      issueContext: { owner: "octant", name: "octant", number: 7 },
    });
    expect(
      decodeWorkThreadCommand({
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Release notes",
        providerInstanceId: ids.provider,
        modelId: "gemma4:latest",
        hostId: "local",
        bindingRevisionId: ids.tab,
        linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
      }),
    ).toMatchObject({
      kind: "create-work-thread",
      linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(() =>
      decodeWorkThreadCommand({
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Release notes",
        providerInstanceId: ids.provider,
        modelId: "gemma4:latest",
        hostId: "local",
        bindingRevisionId: ids.tab,
        issueContext: { owner: "octant", name: "octant", number: 7, body: "assembled" },
      }),
    ).toThrow();
  });

  it("decodes an in-thread provider/model change command", () => {
    expect(
      decodeWorkThreadCommand({
        kind: "change-work-thread-provider",
        threadId: ids.thread,
        expectedVersion: 1,
        providerInstanceId: ids.provider,
        modelId: "gemma4:next",
      }),
    ).toEqual({
      kind: "change-work-thread-provider",
      threadId: ids.thread,
      expectedVersion: 1,
      providerInstanceId: ids.provider,
      modelId: "gemma4:next",
    });
  });

  it("requires a named delivery target and bounded satisfaction evidence for completion", () => {
    expect(
      decodeWorkThreadCommand({
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget: "Release notes",
        satisfactionEvidence: "The notes were reviewed and delivered to the requester.",
      }),
    ).toMatchObject({
      kind: "confirm-work-thread-completion",
      deliveryTarget: "Release notes",
    });
    expect(() =>
      decodeWorkThreadCommand({
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget: "Release notes",
      }),
    ).toThrow();
  });

  it("decodes thread-created command result and event names", () => {
    const result = decodeWorkThreadCommandResult({
      kind: "thread-created",
      thread: threadFixture,
    });
    if (!("kind" in result)) {
      throw new Error(`expected thread-created, got failure ${result.category}`);
    }
    expect(result.kind).toBe("thread-created");
    expect(WORK_THREAD_EVENT_NAMES).toContain("work.thread-created@1");
    expect(WORK_THREAD_EVENT_NAMES).toContain("work.thread-updated@1");
  });

  it("decodes work-thread workspace tab and rejects wrong mode", () => {
    const tab = {
      kind: "work-thread",
      id: ids.tab,
      threadId: ids.thread,
      mode: "work",
      title: "Release notes",
    } as const;
    expect(decodeWorkspaceTab(tab).kind).toBe("work-thread");
    expect(() => decodeWorkspaceTab({ ...tab, mode: "chat" })).toThrow();
  });
});
