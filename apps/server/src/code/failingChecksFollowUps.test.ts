import {
  decodeCodeProjectPullRequestRow,
  decodeCodeThreadFollowUpView,
  type CodeProjectPullRequestRow,
  type CodeThreadFollowUp,
} from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import type { CodeFollowUpTriggerObservation } from "./codeFollowUpService";
import { FailingChecksFollowUps, type FailingChecksFollowUpSink } from "./failingChecksFollowUps";

const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const now = "2026-08-22T08:00:00.000Z";

function snapshotRow(overrides: Record<string, unknown> = {}): CodeProjectPullRequestRow {
  return decodeCodeProjectPullRequestRow({
    projectId: "10000000-0000-4000-8000-000000000001",
    projectName: "Octant",
    repositoryOwner: "octant",
    repositoryName: "octant",
    number: 7,
    title: "Wire the board join",
    draft: false,
    state: "open",
    mergeability: "mergeable",
    author: "octocat",
    baseBranch: "main",
    headBranch: "feature/board-join",
    updatedAt: "2026-08-22T07:00:00Z",
    checks: "failing",
    review: "pending",
    linkedThreads: [{ threadId: String(threadId), title: "Board join" }],
    ...overrides,
  });
}

/**
 * Minimal in-memory stand-in for the follow-up service: it records every
 * observation and reproduces the sequence bookkeeping the real aggregate keeps
 * (trigger and acknowledged sequences), without a journal.
 */
function sinkFixture(options?: { readonly failObservationsBeforeSucceeding?: number }) {
  const observations: Array<CodeFollowUpTriggerObservation> = [];
  let followUp: CodeThreadFollowUp | undefined;
  let remainingFailures = options?.failObservationsBeforeSucceeding ?? 0;
  const view = (readThreadId: unknown) =>
    decodeCodeThreadFollowUpView({
      threadId: String(readThreadId),
      followUpVersion: observations.length,
      ...(followUp === undefined ? {} : { followUp }),
    });
  const sink: FailingChecksFollowUpSink = {
    read: (readThreadId) => view(readThreadId),
    observeTrigger: async (input) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Thread follow-up storage is unavailable.");
      }
      observations.push(input);
      followUp = decodeCodeThreadFollowUpView({
        threadId: String(input.threadId),
        followUpVersion: observations.length,
        followUp: {
          threadId: String(input.threadId),
          state: "open",
          origin: input.origin,
          reason: input.reason,
          triggerSequence: input.sourceSequence,
          acknowledgedThroughSequence: followUp?.acknowledgedThroughSequence ?? 0,
          createdAt: now,
        },
      }).followUp;
      if (followUp === undefined) throw new Error("Stub follow-up failed to decode.");
      return followUp;
    },
  };
  const complete = () => {
    if (followUp === undefined) return;
    followUp = decodeCodeThreadFollowUpView({
      threadId: String(followUp.threadId),
      followUpVersion: observations.length,
      followUp: {
        ...followUp,
        state: "completed",
        acknowledgedThroughSequence: followUp.triggerSequence,
        completedAt: now,
      },
    }).followUp;
  };
  return { sink, observations, complete };
}

function followUpsFixture(sink: FailingChecksFollowUpSink) {
  let uuidCounter = 0;
  return new FailingChecksFollowUps({
    followUps: sink,
    uuid: () => `30000000-0000-4000-8000-00000000000${(uuidCounter += 1)}`,
    clock: () => now,
  });
}

describe("FailingChecksFollowUps", () => {
  it("opens exactly one follow-up on the owning thread when a refreshed snapshot first shows failing checks", async () => {
    const { sink, observations } = sinkFixture();
    const followUps = followUpsFixture(sink);

    await followUps.observe([snapshotRow()]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      threadId,
      origin: "automatic",
      reason: "CI is failing on PR #7: Wire the board join",
      sourceSequence: 1,
      triggeredAt: now,
    });

    // Re-observing the same failing snapshot any number of times opens nothing new.
    await followUps.observe([snapshotRow()]);
    await followUps.observe([snapshotRow()]);
    expect(observations).toHaveLength(1);
  });

  it("reopens a completed follow-up with a strictly newer sequence when the checks fail again after recovering", async () => {
    const { sink, observations, complete } = sinkFixture();
    const followUps = followUpsFixture(sink);

    await followUps.observe([snapshotRow()]);
    complete();
    await followUps.observe([snapshotRow({ checks: "passing" })]);
    expect(observations).toHaveLength(1);

    await followUps.observe([snapshotRow()]);
    expect(observations).toHaveLength(2);
    // Strictly newer than the acknowledged sequence, so the marker reopens.
    expect(observations[1]?.sourceSequence).toBe(2);
  });

  it("keeps the edge armed when persisting the trigger fails so the next refresh retries", async () => {
    const { sink, observations } = sinkFixture({ failObservationsBeforeSucceeding: 1 });
    const followUps = followUpsFixture(sink);

    await followUps.observe([snapshotRow()]);
    expect(observations).toHaveLength(0);

    await followUps.observe([snapshotRow()]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.reason).toBe("CI is failing on PR #7: Wire the board join");
  });
});
