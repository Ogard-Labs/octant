import {
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  type CodeRuntimeWork,
  type CodeThread,
  type CodeThreadId,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";
import {
  codeSiblingThreadSource,
  codeSiblingThreadState,
  type CodeSiblingThreadEvidence,
} from "./codeSiblingThreadSource";

const created = "2026-10-14T06:00:00.000Z";
const projectA = decodeProjectId("a1000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("b1000000-0000-4000-8000-000000000001");
const windowId = "a1000000-0000-4000-8000-0000000000ff" as WindowId;

function codeThread(id: string, overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id,
    projectId: projectA,
    bindingRevisionId: "a1000000-0000-4000-8000-000000000002",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "a1000000-0000-4000-8000-000000000003",
    title: `Thread ${id.slice(-1)}`,
    lifecycle: "active",
    providerInstanceId: "a1000000-0000-4000-8000-000000000004",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/siblings",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "opened-pr",
      confirmedAt: created,
    },
    version: 1,
    createdAt: created,
    updatedAt: "2026-10-14T06:30:00.000Z",
    ...overrides,
  });
}

let workCounter = 0;
function work(
  threadId: CodeThreadId,
  kind: CodeRuntimeWork["kind"],
  state: CodeRuntimeWork["state"],
  updatedAt: string,
  firstSequence: number,
): ProjectedCodeRuntimeWork {
  workCounter += 1;
  return {
    work: {
      id: `a1000000-0000-4000-8000-${String(900 + workCounter).padStart(12, "0")}`,
      threadId,
      kind,
      state,
      updatedAt,
    } as CodeRuntimeWork,
    firstSequence,
  };
}

function evidenceFor(input: {
  readonly threads: ReadonlyArray<CodeThread>;
  readonly works?: Readonly<Record<string, ReadonlyArray<ProjectedCodeRuntimeWork>>>;
  readonly parked?: ReadonlyArray<string>;
  readonly decisions?: ReadonlyArray<string>;
}): CodeSiblingThreadEvidence & {
  readonly readTranscript: ReturnType<typeof vi.fn>;
  readonly standingReads: () => number;
} {
  let standing = 0;
  let insideStanding = false;
  const readTranscript = vi.fn(async () => {
    // The mention read must run on the window's standing authority.
    if (!insideStanding) return undefined;
    return [{ role: "user" as const, text: "Ship it.", occurredAt: created as never }];
  });
  return {
    threads: () => input.threads,
    thread: (threadId) => input.threads.find((thread) => thread.id === threadId),
    runtimeWorks: (threadId) => input.works?.[String(threadId)] ?? [],
    turnAwaitsPerson: (threadId) => input.parked?.includes(String(threadId)) === true,
    decisionPending: (thread) => input.decisions?.includes(String(thread.id)) === true,
    mentions: { readTranscript },
    standingAuthority: async (read) => {
      standing += 1;
      insideStanding = true;
      try {
        return await read();
      } finally {
        insideStanding = false;
      }
    },
    readTranscript,
    standingReads: () => standing,
  };
}

describe("Code sibling-thread state", () => {
  it("reports running work as working and work owed by the person as waiting for the person", () => {
    const running = codeThread("a1000000-0000-4000-8000-000000000011");
    const parked = codeThread("a1000000-0000-4000-8000-000000000012");
    const unconfirmed = codeThread("a1000000-0000-4000-8000-000000000013");
    const interrupted = codeThread("a1000000-0000-4000-8000-000000000014");
    const asked = codeThread("a1000000-0000-4000-8000-000000000015");
    const pushWaiting = codeThread("a1000000-0000-4000-8000-000000000016");
    const evidence = evidenceFor({
      threads: [running, parked, unconfirmed, interrupted, asked, pushWaiting],
      works: {
        [String(running.id)]: [
          work(running.id, "provider-turn", "running", "2026-10-14T07:00:00.000Z", 1),
        ],
        [String(parked.id)]: [
          work(parked.id, "provider-turn", "running", "2026-10-14T07:01:00.000Z", 2),
        ],
        [String(unconfirmed.id)]: [
          work(unconfirmed.id, "provider-turn", "completed", "2026-10-14T07:02:00.000Z", 3),
          work(unconfirmed.id, "git", "ambiguous", "2026-10-14T07:03:00.000Z", 4),
        ],
        [String(interrupted.id)]: [
          work(interrupted.id, "provider-turn", "interrupted", "2026-10-14T07:04:00.000Z", 5),
        ],
        [String(asked.id)]: [
          work(asked.id, "provider-turn", "completed", "2026-10-14T07:05:00.000Z", 6),
        ],
        [String(pushWaiting.id)]: [
          work(pushWaiting.id, "provider-turn", "completed", "2026-10-14T07:06:00.000Z", 7),
          work(pushWaiting.id, "git", "waiting", "2026-10-14T07:07:00.000Z", 8),
        ],
      },
      parked: [String(parked.id)],
      decisions: [String(asked.id)],
    });

    expect(codeSiblingThreadState(running, evidence)).toEqual({
      state: "working",
      stateChangedAt: "2026-10-14T07:00:00.000Z",
    });
    expect(codeSiblingThreadState(parked, evidence).state).toBe("waiting-for-person");
    expect(codeSiblingThreadState(unconfirmed, evidence)).toEqual({
      state: "waiting-for-person",
      stateChangedAt: "2026-10-14T07:03:00.000Z",
    });
    expect(codeSiblingThreadState(interrupted, evidence).state).toBe("waiting-for-person");
    expect(codeSiblingThreadState(asked, evidence)).toEqual({
      state: "waiting-for-person",
      stateChangedAt: "2026-10-14T07:05:00.000Z",
    });
    expect(codeSiblingThreadState(pushWaiting, evidence).state).toBe("waiting-for-person");
  });

  it("reports a thread that never ran as idle since it was created, and lets only the latest turn speak", () => {
    const fresh = codeThread("a1000000-0000-4000-8000-000000000021");
    const finished = codeThread("a1000000-0000-4000-8000-000000000022");
    const evidence = evidenceFor({
      threads: [fresh, finished],
      works: {
        // A restart can leave an older turn's record running with a later
        // time; the newer turn that finished still decides the state.
        [String(finished.id)]: [
          work(finished.id, "provider-turn", "running", "2026-10-14T09:00:00.000Z", 1),
          work(finished.id, "provider-turn", "completed", "2026-10-14T08:00:00.000Z", 2),
        ],
      },
    });

    expect(codeSiblingThreadState(fresh, evidence)).toEqual({
      state: "idle",
      stateChangedAt: created,
    });
    expect(codeSiblingThreadState(finished, evidence)).toEqual({
      state: "idle",
      stateChangedAt: "2026-10-14T08:00:00.000Z",
    });
  });
});

describe("Code sibling-thread source", () => {
  it("lists the persisted Code threads of the asked Project and marks completed and archived ones closed", () => {
    const open = codeThread("a1000000-0000-4000-8000-000000000031");
    const completed = codeThread("a1000000-0000-4000-8000-000000000032", {
      completedAt: "2026-10-14T07:00:00.000Z",
    });
    const archived = codeThread("a1000000-0000-4000-8000-000000000033", {
      lifecycle: "archived",
    });
    const snoozed = codeThread("a1000000-0000-4000-8000-000000000034", {
      snooze: { until: "2026-10-15T07:00:00.000Z", at: "2026-10-14T07:00:00.000Z" },
    });
    const elsewhere = codeThread("a1000000-0000-4000-8000-000000000035", {
      projectId: projectB,
    });
    const source = codeSiblingThreadSource(
      evidenceFor({ threads: [open, completed, archived, snoozed, elsewhere] }),
      windowId,
    );

    expect(
      source.projectThreads(projectA).map((entry) => [String(entry.threadId), entry.closed]),
    ).toEqual([
      [String(open.id), false],
      [String(completed.id), true],
      [String(archived.id), true],
      [String(snoozed.id), false],
    ]);
    expect(source.thread(open.id)).toMatchObject({
      threadId: open.id,
      projectId: projectA,
      mode: "code",
      closed: false,
      title: open.title,
      state: "idle",
    });
  });

  it("resolves nothing for an id with no Code thread row, such as a child run or a deleted thread", () => {
    const source = codeSiblingThreadSource(
      evidenceFor({ threads: [codeThread("a1000000-0000-4000-8000-000000000041")] }),
      windowId,
    );

    expect(source.thread(decodeCodeThreadId("a1000000-0000-4000-8000-000000000042"))).toBe(
      undefined,
    );
  });

  it("reads a transcript through the mention read for the turn's window, on its standing authority", async () => {
    const target = codeThread("a1000000-0000-4000-8000-000000000051");
    const evidence = evidenceFor({ threads: [target] });
    const source = codeSiblingThreadSource(evidence, windowId);

    await expect(source.readTranscript(target.id)).resolves.toEqual([
      { role: "user", text: "Ship it.", occurredAt: created },
    ]);
    expect(evidence.readTranscript).toHaveBeenCalledExactlyOnceWith(windowId, String(target.id));
    expect(evidence.standingReads()).toBe(1);
  });
});
