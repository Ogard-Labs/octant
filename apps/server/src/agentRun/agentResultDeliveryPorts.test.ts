import { describe, expect, it, vi } from "vitest";
import {
  decodeAgentRun,
  decodeCodeThread,
  decodeWorkThread,
  type AgentRun,
  type UtcTimestamp,
} from "@octant/contracts";
import { CodeServiceError } from "../code/codeService";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import {
  createCodeAgentResultDeliveryPort,
  createWorkAgentResultDeliveryPort,
} from "./agentResultDeliveryPorts";

const NOW = "2026-07-19T12:00:00.000Z" as UtcTimestamp;

const ids = {
  project: "84000000-0000-4000-8000-000000000002",
  thread: "84000000-0000-4000-8000-000000000003",
  binding: "84000000-0000-4000-8000-000000000006",
  checkout: "84000000-0000-4000-8000-000000000007",
  provider: "84000000-0000-4000-8000-00000000000a",
  run: "84000000-0000-4000-8000-000000000010",
};

let counter = 0;
const uuid = () => `84000000-0000-4000-8000-${String(++counter).padStart(12, "1")}`;

const workThread = decodeWorkThread({
  id: ids.thread,
  projectId: ids.project,
  title: "Draft brief",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  bindingRevisionId: ids.binding,
  workingDirectory: ".",
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

const codeThread = decodeCodeThread({
  id: ids.thread,
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  repositoryId: `repo_${"d".repeat(64)}`,
  checkoutId: ids.checkout,
  title: "Authority foundation",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/phase-7",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: NOW,
  },
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

const run: AgentRun = decodeAgentRun({
  id: ids.run,
  requestId: "84000000-0000-4000-8000-000000000011",
  parentThreadId: ids.thread,
  depth: 0,
  role: "review",
  task: "Find the regression.",
  creationPosture: "automatic",
  executionKind: "octant-managed",
  lifecycleStatus: "completed",
  authority: {
    filesystem: false,
    shell: false,
    git: false,
    network: true,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  routingReceipt: {
    executionResolution: {
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      executionPolicy: "plan",
      permissionPersistence: "current-session",
      effectivePermissions: {
        filesystem: false,
        shell: false,
        git: false,
        network: true,
        tools: true,
        subagents: false,
      },
      source: "project-default",
      fallbackChain: ["project-default"],
      downgradeReasons: [],
    },
    selectedExecutionKind: "octant-managed",
    attemptedExecutionKind: "provider-native",
    selectedProviderInstanceId: ids.provider,
    selectedModelId: "model-a",
    fallbackCandidates: [],
    capabilityDegradations: [],
    contextSnapshotId: "84000000-0000-4000-8000-000000000012",
    effectiveAuthorityDigest: "digest-1",
    usageQuality: "provider-reported",
    hostId: "local",
    mode: "chat",
  },
  workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 4,
  createdAt: NOW,
  updatedAt: NOW,
});

const mark = {
  kind: "agent-result" as const,
  runId: run.id,
  runIds: [run.id],
  runGenerations: [{ runId: run.id, generation: 1 }],
};

function workPort(isEnabled = true) {
  const startFirstTurn = vi.fn(
    async () => ({ kind: "accepted", turn: { delivery: mark } }) as never,
  );
  const port = createWorkAgentResultDeliveryPort({
    uuid,
    resultText: () => "Found the regression.",
    isEnabled: () => isEnabled,
    readThread: () => workThread,
    startFirstTurn,
  });
  return { port, startFirstTurn };
}

function codePort(compacting: () => boolean = () => false) {
  const stageEvidence = vi.fn(
    async () => ({ contentId: "84000000-0000-4000-8000-000000000020", byteLength: 21 }) as never,
  );
  const executeOperation = vi.fn(
    async () => ({ kind: "provider-turn-state", state: "running", delivery: mark }) as never,
  );
  const port = createCodeAgentResultDeliveryPort({
    uuid,
    resultText: () => "Found the regression.",
    readThread: () => codeThread,
    compacting,
    stageEvidence,
    executeOperation,
  });
  return { port, stageEvidence, executeOperation };
}

describe("agent result delivery to a Work or Code parent", () => {
  it("delivers a child run's result to its parent with no window open", async () => {
    const work = workPort();
    const code = codePort();

    expect(await work.port.dispatch([run])).toMatchObject({ kind: "dispatched" });
    expect(await code.port.dispatch([run])).toMatchObject({ kind: "dispatched" });
  });

  it("does not borrow an open window to deliver a child result", async () => {
    const work = workPort();
    const code = codePort();

    await work.port.dispatch([run]);
    await code.port.dispatch([run]);

    expect(work.startFirstTurn).toHaveBeenCalledWith(
      ROUTINE_HOST_SCOPE_ID,
      expect.objectContaining({ kind: "start-work-thread-turn", delivery: mark }),
    );
    expect(code.stageEvidence).toHaveBeenCalledWith(
      ROUTINE_HOST_SCOPE_ID,
      codeThread.id,
      expect.any(String),
    );
    expect(code.executeOperation).toHaveBeenCalledWith(
      ROUTINE_HOST_SCOPE_ID,
      expect.objectContaining({ kind: "start-provider-turn", delivery: mark }),
    );
  });

  it("holds a Work parent's result while Work is turned off", async () => {
    const work = workPort(false);

    expect(await work.port.dispatch([run])).toEqual({
      kind: "deferred",
      detail: "Work is turned off on this host.",
    });
    expect(work.startFirstTurn).not.toHaveBeenCalled();
  });

  it("holds a Code parent's result while its session compacts, then delivers it", async () => {
    let compacting = true;
    const code = codePort(() => compacting);

    expect(await code.port.dispatch([run])).toEqual({
      kind: "deferred",
      detail: "The parent Code thread's session is being compacted.",
    });
    expect(code.stageEvidence).not.toHaveBeenCalled();
    expect(code.executeOperation).not.toHaveBeenCalled();
    compacting = false;
    expect(await code.port.dispatch([run])).toMatchObject({ kind: "dispatched" });
  });

  it("holds a Code parent's result its turn was refused for a compaction, even one already over", async () => {
    // The compaction started while the result was staged and ended before
    // the refusal reached the port: only the refusal says why.
    const code = codePort(() => false);
    code.executeOperation.mockRejectedValueOnce(
      new CodeServiceError({
        category: "waiting",
        message: "This session is being compacted. Send again when it finishes.",
      }),
    );

    expect(await code.port.dispatch([run])).toEqual({
      kind: "deferred",
      detail: "This session is being compacted. Send again when it finishes.",
    });
  });

  it("fails a Code delivery its Project access refuses", async () => {
    const code = codePort();
    code.stageEvidence.mockRejectedValueOnce(new Error("Code Project is not active."));

    expect(await code.port.dispatch([run])).toEqual({
      kind: "refused",
      detail: "Code Project is not active.",
    });
    expect(code.executeOperation).not.toHaveBeenCalled();
  });
});
