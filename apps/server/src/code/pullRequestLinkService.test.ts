import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED,
  CODE_PULL_REQUEST_LINK_AGGREGATE,
  CODE_PULL_REQUEST_LINK_CREATED,
  CODE_PULL_REQUEST_LINK_DISPLAY_UPDATED,
  CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
  CODE_PULL_REQUEST_LINK_MERGED_INTO,
  decodeCodeOperationId,
  decodeCodeProjectPullRequestSwitchTarget,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type CodeOperationResult,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { CodeOperationEventStore } from "./codeOperationEventStore";
import {
  CodeProjectPullRequestService,
  type CodeProjectPullRequestAuthorizedProject,
} from "./codeProjectPullRequestService";
import {
  CodeProjectPullRequestSwitchService,
  type PullRequestAutoFixThreads,
  type PullRequestSwitchForge,
} from "./codeProjectPullRequestSwitchService";
import {
  cachedGithubObservationFromHistory,
  pullRequestIdentitiesFromHistory,
} from "./codeThreadMetadataService";
import type { GhPullRequestSwitchObservation } from "./ghPullRequestSwitchPort";
import {
  PullRequestLinkService,
  collectLegacyPullRequestLinks,
  deriveLegacyPullRequestLinkId,
} from "./pullRequestLinkService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const threadA = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const threadB = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");
const providerInstanceId = "40000000-0000-4000-8000-000000000001";
const signal = new AbortController().signal;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openJournal(clock: () => string = () => "2026-11-19T10:00:00.000Z") {
  const directory = mkdtempSync(join(tmpdir(), "octant-pull-request-links-"));
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, clock);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  cleanups.push(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return journal;
}

function linkEventsOf(journal: Journal) {
  return journal.replayAggregateType({
    aggregateType: CODE_PULL_REQUEST_LINK_AGGREGATE,
    afterSequence: 0,
    limit: 1_000,
  });
}

function switchFixture(input: {
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "transaction">;
  readonly clock: () => string;
  readonly linkedByTarget: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly linkedPullRequestsByThread: ReadonlyMap<
    string,
    ReadonlyArray<ReturnType<typeof decodeCodeProjectPullRequestSwitchTarget>>
  >;
}) {
  const observed: GhPullRequestSwitchObservation = {
    status: "observed",
    state: "open",
    headSha: "a".repeat(40),
    headBranch: "feature/work",
    baseBranch: "main",
    autoMergeEnabled: true,
    waitingOn: [],
    failures: [],
    activity: {
      checks: "passed",
      failedChecks: [],
      conflicting: false,
      reviews: [],
      comments: [],
    },
  };
  const forge: PullRequestSwitchForge = {
    readAutoMergeSettings: vi.fn(async () => ({
      status: "read" as const,
      allowAutoMerge: true,
      methods: { merge: true, squash: true, rebase: false },
    })),
    enableAutoMerge: vi.fn(async () => ({ status: "enabled" as const })),
    disableAutoMerge: vi.fn(async () => ({ status: "disabled" as const })),
    observe: vi.fn(async () => observed),
    readCiLogs: vi.fn(async () => ({ status: "unavailable" as const })),
    planCiRerun: vi.fn(async () => ({ status: "unavailable" as const })),
    rerunCi: vi.fn(async () => ({ status: "unavailable" as const })),
  };
  const threads: PullRequestAutoFixThreads = {
    inspect: () => ({ status: "available", turnActive: false }),
    markOutsideContent: () => true,
    startTurn: vi.fn(async () => true),
    notifyPerson: vi.fn(async () => undefined),
  };
  const switches = new CodeProjectPullRequestSwitchService({
    authority: {
      authorizePullRequest: async (_windowId, target) => ({
        status: "authorized",
        linkedThreadIds:
          input.linkedByTarget.get(
            `${target.repositoryOwner.toLowerCase()}/${target.repositoryName.toLowerCase()}#${target.number}`,
          ) ?? [],
      }),
      connectionRevoked: () => false,
      linkedPullRequests: async (_windowId, threadId) =>
        input.linkedPullRequestsByThread.get(String(threadId)) ?? [],
    },
    forge,
    threads,
    journal: input.journal,
    clock: input.clock,
    uuid: randomUUID,
  });
  return { switches, forge, threads };
}

describe("pull request link identity and backfill", () => {
  it("records PR node ID and base repository node ID in the journal when created or first observed", async () => {
    const journal = openJournal();
    const service = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => "2026-11-19T10:00:00.000Z",
    });

    const created = await service.recordObservation({
      projectId,
      repositoryOwner: "upstream-org",
      repositoryName: "core",
      number: 175,
      url: "https://github.com/upstream-org/core/pull/175",
      baseBranch: "main",
      headOwner: "fork-contributor",
      headBranch: "feature/work",
      pullRequestNodeId: "PR_kwDO175",
      baseRepositoryNodeId: "R_kgDOUpstreamBase",
      threadIds: [threadA],
    });

    expect(created.status).toBe("created");
    const events = linkEventsOf(journal);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventName).toBe(CODE_PULL_REQUEST_LINK_CREATED);
    expect(events[0]?.payload).toMatchObject({
      projectId,
      repositoryOwner: "upstream-org",
      repositoryName: "core",
      number: 175,
      headOwner: "fork-contributor",
      pullRequestNodeId: "PR_kwDO175",
      baseRepositoryNodeId: "R_kgDOUpstreamBase",
      threadIds: [threadA],
    });

    // Re-observing the same PR with the same IDs and display fields writes no extra event.
    const repeat = await service.recordObservation({
      projectId,
      repositoryOwner: "upstream-org",
      repositoryName: "core",
      number: 175,
      url: "https://github.com/upstream-org/core/pull/175",
      baseBranch: "main",
      headOwner: "fork-contributor",
      headBranch: "feature/work",
      pullRequestNodeId: "PR_kwDO175",
      baseRepositoryNodeId: "R_kgDOUpstreamBase",
      threadIds: [threadA],
    });
    expect(repeat.status).toBe("unchanged");
    expect(linkEventsOf(journal)).toHaveLength(1);
  });

  it("replays pre-change journal entries identically and backfills forge IDs once on the next observation", async () => {
    let now = "2026-10-15T09:00:00.000Z";
    const journal = openJournal(() => now);
    const operationStore = new CodeOperationEventStore({
      journal,
      uuid: randomUUID,
      clock: () => now,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });

    // Legacy journal entry written before forge node IDs existed.
    const legacyResult: CodeOperationResult = {
      kind: "pull-request-state",
      operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000001"),
      state: "created",
      number: 42,
      url: "https://github.com/octant/octant/pull/42",
      headRepository: "octocat",
      headBranch: "feature/legacy",
      baseRepository: "octant/octant",
      baseBranch: "main",
    };
    operationStore.append({
      threadId: threadA,
      operationId: legacyResult.operationId,
      expectedCursor: 0,
      event: { kind: "operation-result", result: legacyResult },
    });

    // Existing readers still replay the legacy journal identically with zero writes.
    const historyBefore = operationStore.summaryForThread(threadA);
    expect(pullRequestIdentitiesFromHistory(historyBefore)).toEqual([
      { number: 42, observedAt: "2026-10-15T09:00:00.000Z" },
    ]);
    expect(cachedGithubObservationFromHistory(historyBefore)).toMatchObject({
      status: "observed",
      pullRequest: { number: 42, baseRepository: "octant/octant", state: "open" },
    });

    const readLegacy = () =>
      collectLegacyPullRequestLinks({
        journal,
        threads: [
          {
            threadId: threadA,
            projectId,
            frames: historyBefore.status === "ok" ? historyBefore.frames : [],
          },
        ],
      });

    // Constructing the identity owner writes nothing during replay.
    now = "2026-11-19T12:00:00.000Z";
    const service = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      legacyLinks: readLegacy,
    });
    expect(linkEventsOf(journal)).toHaveLength(0);

    // Next successful observation with forge IDs backfills once without rewriting history.
    const backfilled = await service.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 42,
      url: "https://github.com/octant/octant/pull/42",
      baseBranch: "main",
      headOwner: "octocat",
      headBranch: "feature/legacy",
      pullRequestNodeId: "PR_kwDOLegacy42",
      baseRepositoryNodeId: "R_kgDOLegacyRepo",
      threadIds: [threadA],
    });
    expect(backfilled.status).toBe("updated");
    if (backfilled.status === "updated") expect(backfilled.backfilled).toBe(true);

    const eventsAfterFirst = linkEventsOf(journal);
    expect(eventsAfterFirst.map((event) => event.eventName)).toEqual([
      CODE_PULL_REQUEST_LINK_CREATED,
      CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
    ]);
    expect(eventsAfterFirst[0]?.payload).toMatchObject({
      linkedAt: "2026-10-15T09:00:00.000Z",
      threadIds: [threadA],
    });
    expect(eventsAfterFirst[1]?.payload).toEqual({
      linkId: backfilled.status === "updated" ? backfilled.link.linkId : "",
      pullRequestNodeId: "PR_kwDOLegacy42",
      baseRepositoryNodeId: "R_kgDOLegacyRepo",
    });

    // Subsequent observation writes no duplicate backfill event, even after restart/replay.
    const restarted = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      legacyLinks: readLegacy,
    });
    const second = await restarted.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 42,
      url: "https://github.com/octant/octant/pull/42",
      baseBranch: "main",
      headOwner: "octocat",
      headBranch: "feature/legacy",
      pullRequestNodeId: "PR_kwDOLegacy42",
      baseRepositoryNodeId: "R_kgDOLegacyRepo",
      threadIds: [threadA],
    });
    expect(second.status).toBe("unchanged");
    expect(linkEventsOf(journal)).toHaveLength(2);
    expect(restarted.findByForgeId(projectId, "PR_kwDOLegacy42")).toMatchObject({
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 42,
      pullRequestNodeId: "PR_kwDOLegacy42",
      baseRepositoryNodeId: "R_kgDOLegacyRepo",
      threadIds: [threadA],
    });
  });

  it("keeps working by owner/name and number when IDs are missing and retries backfill on a later observation", async () => {
    let now = "2026-11-19T10:00:00.000Z";
    const journal = openJournal(() => now);
    const service = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });

    // Offline / rate-limited first observation without IDs succeeds without refusal.
    const first = await service.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 88,
      threadIds: [threadA],
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error("expected created link");
    expect(first.link.pullRequestNodeId).toBeUndefined();
    expect(first.link.baseRepositoryNodeId).toBeUndefined();

    // Another offline observation continues working on owner/name + number without duplicating.
    now = "2026-11-19T10:05:00.000Z";
    const stillOffline = await service.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 88,
      threadIds: [threadA],
    });
    expect(stillOffline.status).toBe("unchanged");
    expect(linkEventsOf(journal)).toHaveLength(1);

    // Partial recovery: PR node ID arrives first while base repo GraphQL is still limited.
    now = "2026-11-19T10:10:00.000Z";
    const partial = await service.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 88,
      pullRequestNodeId: "PR_kwDO88",
      threadIds: [threadA],
    });
    expect(partial.status).toBe("updated");
    expect(service.findByForgeId(projectId, "PR_kwDO88")?.baseRepositoryNodeId).toBeUndefined();

    // Full recovery: base repo node ID arrives and backfills cleanly once.
    now = "2026-11-19T10:15:00.000Z";
    const full = await service.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 88,
      pullRequestNodeId: "PR_kwDO88",
      baseRepositoryNodeId: "R_kgDO88Base",
      threadIds: [threadA],
    });
    expect(full.status).toBe("updated");
    expect(service.findByForgeId(projectId, "PR_kwDO88")).toMatchObject({
      linkId: first.link.linkId,
      pullRequestNodeId: "PR_kwDO88",
      baseRepositoryNodeId: "R_kgDO88Base",
    });

    // Subsequent observation emits nothing further.
    const settled = await service.recordObservation({
      projectId,
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 88,
      pullRequestNodeId: "PR_kwDO88",
      baseRepositoryNodeId: "R_kgDO88Base",
      threadIds: [threadA],
    });
    expect(settled.status).toBe("unchanged");
    expect(linkEventsOf(journal)).toHaveLength(3);
  });

  it("merges a later duplicate link into the earlier one on backfill, moves threads, reconciles switches, notifies affected threads, and deletes nothing", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 42,
    });
    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 42,
    });
    const { switches, forge, threads } = switchFixture({
      journal,
      clock: () => now,
      linkedByTarget: new Map([
        ["old-org/repo#42", [String(threadA)]],
        ["new-org/repo#42", [String(threadB)]],
      ]),
      linkedPullRequestsByThread: new Map([
        [String(threadA), [oldTarget]],
        [String(threadB), [newTarget]],
      ]),
    });

    // Enable switches across the two pre-backfill links:
    // - Merge when ready: ON in both -> must stay ON on the earlier link (without calling disableAutoMerge).
    // - Auto-fix: ON in earlier (threadA), OFF in later -> must turn OFF and notify threadA.
    // - Watch: OFF in earlier, ON in later (threadB) -> must turn OFF and notify threadB.
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: newTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await switches.setAutoFix(
      windowId,
      { kind: "enable", target: oldTarget, threadId: threadA },
      "user",
    );
    await switches.watch({
      windowId,
      threadId: threadB,
      providerInstanceId,
      signal,
    });

    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });

    // Two existing links recorded before forge IDs were known.
    const firstCreated = await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 42,
      threadIds: [threadA],
    });
    now = "2026-11-02T10:00:00.000Z";
    const secondCreated = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 42,
      threadIds: [threadB],
    });
    if (firstCreated.status !== "created" || secondCreated.status !== "created") {
      throw new Error("expected two distinct pre-backfill links");
    }

    // Backfill the later link FIRST to prove the earlier link STILL stays survivor.
    now = "2026-11-19T12:00:00.000Z";
    const backfilledLate = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 42,
      pullRequestNodeId: "PR_kwDO42",
      baseRepositoryNodeId: "R_kgDOBaseRepo",
      threadIds: [threadB],
    });
    expect(backfilledLate.status).toBe("updated");

    // Now backfill the earlier link with the same PR node ID -> duplicate detected!
    now = "2026-11-19T12:05:00.000Z";
    const merged = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      lookupRepositoryOwner: "old-org",
      lookupRepositoryName: "repo",
      number: 42,
      url: "https://github.com/new-org/repo/pull/42",
      pullRequestNodeId: "PR_kwDO42",
      baseRepositoryNodeId: "R_kgDOBaseRepo",
    });

    expect(merged.status).toBe("merged");
    if (merged.status !== "merged") throw new Error("expected duplicate merge");
    expect(merged.link.linkId).toBe(firstCreated.link.linkId);
    expect(merged.mergedLinkIds).toEqual([secondCreated.link.linkId]);
    expect(merged.disabledSwitches).toEqual(["auto-fix", "watch"]);
    expect(merged.link.threadIds).toEqual([threadA, threadB]);
    expect(merged.link.repositoryOwner).toBe("new-org");
    expect(merged.link.repositoryName).toBe("repo");

    // Nothing was deleted from the journal: both original creation events plus merged-into remain.
    const allEvents = linkEventsOf(journal);
    expect(
      allEvents.filter((event) => event.eventName === CODE_PULL_REQUEST_LINK_CREATED),
    ).toHaveLength(2);
    const mergedEvent = allEvents.find(
      (event) => event.eventName === CODE_PULL_REQUEST_LINK_MERGED_INTO,
    );
    expect(mergedEvent?.payload).toEqual({
      linkId: secondCreated.link.linkId,
      survivingLinkId: firstCreated.link.linkId,
      pullRequestNodeId: "PR_kwDO42",
      baseRepositoryNodeId: "R_kgDOBaseRepo",
      movedThreadIds: [threadB],
      disabledSwitches: ["auto-fix", "watch"],
    });

    // Merge when ready stayed ON in both -> kept ON on survivor without disabling forge auto-merge.
    expect(forge.disableAutoMerge).not.toHaveBeenCalled();
    const survivingView = await switches.query(windowId, oldTarget);
    expect(survivingView.mergeWhenReady.status).toBe("on");
    expect(survivingView.autoFix.status).toBe("off");
    const retiredView = await switches.query(windowId, newTarget);
    expect(retiredView.mergeWhenReady.status).toBe("off");
    expect(retiredView.autoFix.status).toBe("off");
    // Watch on threadB was turned off (unwatch reports not-watching).
    await expect(
      switches.unwatch({ threadId: threadB, providerInstanceId: "provider-1" }),
    ).resolves.toEqual({ status: "not-watching" });

    // Notices named each turned-off switch and why, so the person can turn it back on.
    expect(threads.notifyPerson).toHaveBeenCalledWith(threadA, expect.stringContaining("Auto-fix"));
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadA,
      expect.stringContaining("duplicate links"),
    );
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadB,
      expect.stringContaining("Pull request watch"),
    );
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadB,
      expect.stringContaining("duplicate links"),
    );

    // Replaying both services from the journal reproduces the exact merged state.
    const replayedLinks = new PullRequestLinkService({ journal, uuid: randomUUID });
    expect(replayedLinks.listActive()).toHaveLength(1);
    expect(replayedLinks.resolveCanonical(secondCreated.link.linkId)?.linkId).toBe(
      firstCreated.link.linkId,
    );
    expect(replayedLinks.findById(secondCreated.link.linkId)?.status).toBe("merged-into");
    expect(replayedLinks.findByForgeId(projectId, "PR_kwDO42")?.threadIds).toEqual([
      threadA,
      threadB,
    ]);
  });

  it("turns off Merge when ready when on in only one duplicate link and notifies linked threads", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 77,
    });
    const { switches, forge, threads } = switchFixture({
      journal,
      clock: () => now,
      linkedByTarget: new Map([
        ["old-org/repo#77", [String(threadA)]],
        ["new-org/repo#77", [String(threadB)]],
      ]),
      linkedPullRequestsByThread: new Map(),
    });

    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );

    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });
    await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 77,
      pullRequestNodeId: "PR_kwDO77",
      baseRepositoryNodeId: "R_kgDO77Base",
      threadIds: [threadA],
    });
    now = "2026-11-02T10:00:00.000Z";
    await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 77,
      threadIds: [threadB],
    });

    now = "2026-11-19T12:00:00.000Z";
    const merged = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 77,
      pullRequestNodeId: "PR_kwDO77",
      baseRepositoryNodeId: "R_kgDO77Base",
    });
    expect(merged.status).toBe("merged");
    if (merged.status !== "merged") throw new Error("expected merged");
    expect(merged.disabledSwitches).toEqual(["merge-when-ready"]);
    expect(forge.disableAutoMerge).toHaveBeenCalledOnce();
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("off");
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadA,
      expect.stringContaining("Merge when ready"),
    );
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadB,
      expect.stringContaining("Merge when ready"),
    );
  });

  it("updates display fields via a journal event on repository rename while keeping link, thread, watch, and switches", async () => {
    let now = "2026-11-10T10:00:00.000Z";
    const journal = openJournal(() => now);
    const initialTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-owner",
      repositoryName: "old-name",
      number: 15,
    });
    const { switches, threads } = switchFixture({
      journal,
      clock: () => now,
      linkedByTarget: new Map([["old-owner/old-name#15", [String(threadA)]]]),
      linkedPullRequestsByThread: new Map([[String(threadA), [initialTarget]]]),
    });

    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: initialTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await switches.setAutoFix(
      windowId,
      { kind: "enable", target: initialTarget, threadId: threadA },
      "user",
    );
    await switches.watch({
      windowId,
      threadId: threadA,
      providerInstanceId,
      signal,
    });

    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });
    const created = await links.recordObservation({
      projectId,
      repositoryOwner: "old-owner",
      repositoryName: "old-name",
      number: 15,
      url: "https://github.com/old-owner/old-name/pull/15",
      baseBranch: "main",
      headOwner: "old-owner",
      headBranch: "feature/rename",
      pullRequestNodeId: "PR_kwDO15",
      baseRepositoryNodeId: "R_kgDORenameRepo",
      threadIds: [threadA],
    });
    if (created.status !== "created") throw new Error("expected created");

    // Observation returns the renamed owner/name for the same forge ID.
    now = "2026-11-19T12:00:00.000Z";
    const renamed = await links.recordObservation({
      projectId,
      repositoryOwner: "new-owner",
      repositoryName: "new-name",
      lookupRepositoryOwner: "old-owner",
      lookupRepositoryName: "old-name",
      number: 15,
      url: "https://github.com/new-owner/new-name/pull/15",
      baseBranch: "main",
      headOwner: "new-owner",
      headBranch: "feature/rename",
      pullRequestNodeId: "PR_kwDO15",
      baseRepositoryNodeId: "R_kgDORenameRepo",
      threadIds: [threadA],
    });
    expect(renamed.status).toBe("updated");
    if (renamed.status !== "updated") throw new Error("expected updated");
    expect(renamed.backfilled).toBe(false);
    expect(renamed.displayUpdated).toBe(true);
    expect(renamed.link.linkId).toBe(created.link.linkId);
    expect(renamed.link).toMatchObject({
      repositoryOwner: "new-owner",
      repositoryName: "new-name",
      number: 15,
      url: "https://github.com/new-owner/new-name/pull/15",
      pullRequestNodeId: "PR_kwDO15",
      baseRepositoryNodeId: "R_kgDORenameRepo",
      threadIds: [threadA],
    });

    // Switches and watch remain ON and untouched.
    const switchView = await switches.query(windowId, initialTarget);
    expect(switchView.mergeWhenReady.status).toBe("on");
    expect(switchView.autoFix.status).toBe("on");
    expect(switches.watching).toBe(true);
    expect(threads.notifyPerson).not.toHaveBeenCalled();

    const events = linkEventsOf(journal);
    expect(events.map((event) => event.eventName)).toEqual([
      CODE_PULL_REQUEST_LINK_CREATED,
      CODE_PULL_REQUEST_LINK_DISPLAY_UPDATED,
    ]);

    // Replaying reproduces the renamed display fields with the same link and thread.
    const replayed = new PullRequestLinkService({ journal, uuid: randomUUID });
    expect(replayed.findByForgeId(projectId, "PR_kwDO15")).toMatchObject({
      linkId: created.link.linkId,
      repositoryOwner: "new-owner",
      repositoryName: "new-name",
      threadIds: [threadA],
    });
  });

  it("records forge IDs from project pull-request refresh for linked PRs without creating links for unrelated PRs", async () => {
    const journal = openJournal();
    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => "2026-11-19T12:00:00.000Z",
    });
    const project: CodeProjectPullRequestAuthorizedProject = {
      id: projectId,
      name: "Octant",
      type: "code",
      lifecycle: "active",
      binding: { canonicalRoot: "/repos/octant" },
    };
    const prService = new CodeProjectPullRequestService({
      projects: { bootstrap: async () => ({ active: [project] }) },
      remotes: {
        remotes: async () => [
          {
            name: "origin",
            fetchUrl: "https://github.com/octant/octant.git",
            pushUrl: "https://github.com/octant/octant.git",
          },
        ],
      },
      list: {
        listActive: async () => ({
          status: "ok",
          rows: [
            {
              number: 12,
              title: "Linked PR",
              draft: false,
              state: "open",
              mergeability: "mergeable",
              author: "octocat",
              baseBranch: "main",
              headBranch: "feature/linked",
              updatedAt: "2026-11-19T11:00:00Z",
              url: "https://github.com/octant/octant/pull/12",
              checks: "passing",
              review: "approved",
              reviewRequestedFrom: [],
              failingChecks: [],
              crossRepository: false,
              pullRequestNodeId: "PR_kwDO12",
              baseRepositoryNodeId: "R_kgDOOctant",
            },
            {
              number: 99,
              title: "Unrelated team PR",
              draft: false,
              state: "open",
              mergeability: "mergeable",
              author: "teammate",
              baseBranch: "main",
              headBranch: "feature/unrelated",
              updatedAt: "2026-11-19T11:00:00Z",
              url: "https://github.com/octant/octant/pull/99",
              checks: "passing",
              review: "none",
              reviewRequestedFrom: [],
              failingChecks: [],
              crossRepository: false,
              pullRequestNodeId: "PR_kwDO99",
              baseRepositoryNodeId: "R_kgDOOctant",
            },
          ],
        }),
      },
      detail: { observeReviewByIdentity: async () => ({ status: "unavailable" }) },
      threads: {
        list: async () => [
          {
            threadId: String(threadA),
            projectId: String(projectId),
            title: "Linked thread",
            repository: { owner: "octant", name: "octant" },
            deliveryBranch: "feature/linked",
            pullRequestNumbers: [],
          },
        ],
      },
      pullRequestLinks: links,
      clock: () => "2026-11-19T12:00:00.000Z",
    });

    await prService.refresh(windowId, { kind: "refresh-all" }, signal);

    expect(links.listActive()).toHaveLength(1);
    expect(links.findByForgeId(projectId, "PR_kwDO12")).toMatchObject({
      number: 12,
      pullRequestNodeId: "PR_kwDO12",
      baseRepositoryNodeId: "R_kgDOOctant",
      threadIds: [threadA],
    });
    expect(links.findByForgeId(projectId, "PR_kwDO99")).toBeUndefined();
  });

  it("keeps Merge when ready on and retries duplicate reconciliation when GitHub fails to disable auto-merge", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 78,
    });
    const { switches, forge, threads } = switchFixture({
      journal,
      clock: () => now,
      linkedByTarget: new Map([
        ["old-org/repo#78", [String(threadA)]],
        ["new-org/repo#78", [String(threadB)]],
      ]),
      linkedPullRequestsByThread: new Map(),
    });

    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );

    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });
    const firstLink = await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 78,
      pullRequestNodeId: "PR_kwDO78",
      baseRepositoryNodeId: "R_kgDO78Base",
      threadIds: [threadA],
    });
    now = "2026-11-02T10:00:00.000Z";
    await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 78,
      threadIds: [threadB],
    });
    if (firstLink.status !== "created") throw new Error("expected first link");

    // First attempt: forge answers unavailable -> switch stays ON, merge deferred, no notice.
    vi.mocked(forge.disableAutoMerge).mockResolvedValueOnce({
      status: "unavailable",
      reason: "disconnected",
    });
    now = "2026-11-19T12:00:00.000Z";
    const firstAttempt = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 78,
      pullRequestNodeId: "PR_kwDO78",
      baseRepositoryNodeId: "R_kgDO78Base",
    });
    expect(firstAttempt).toMatchObject({
      status: "merge-deferred",
      reason: "merge-when-ready-disable-failed",
    });
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("on");
    expect(links.listActive()).toHaveLength(2);
    expect(
      linkEventsOf(journal).filter(
        (event) => event.eventName === CODE_PULL_REQUEST_LINK_MERGED_INTO,
      ),
    ).toHaveLength(0);
    expect(threads.notifyPerson).not.toHaveBeenCalled();

    // Second attempt: forge throws -> switch STILL stays ON, merge still deferred.
    vi.mocked(forge.disableAutoMerge).mockRejectedValueOnce(new Error("connection reset"));
    now = "2026-11-19T12:05:00.000Z";
    const secondAttempt = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 78,
      pullRequestNodeId: "PR_kwDO78",
      baseRepositoryNodeId: "R_kgDO78Base",
    });
    expect(secondAttempt).toMatchObject({
      status: "merge-deferred",
      reason: "merge-when-ready-disable-failed",
    });
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("on");
    expect(links.listActive()).toHaveLength(2);
    expect(threads.notifyPerson).not.toHaveBeenCalled();

    // Third attempt: forge confirms disabled -> switch turns OFF, links merge, threads notified.
    vi.mocked(forge.disableAutoMerge).mockResolvedValueOnce({ status: "disabled" });
    now = "2026-11-19T12:10:00.000Z";
    const thirdAttempt = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 78,
      pullRequestNodeId: "PR_kwDO78",
      baseRepositoryNodeId: "R_kgDO78Base",
    });
    expect(thirdAttempt.status).toBe("merged");
    if (thirdAttempt.status !== "merged") throw new Error("expected merged on retry");
    expect(thirdAttempt.link.linkId).toBe(firstLink.link.linkId);
    expect(thirdAttempt.disabledSwitches).toEqual(["merge-when-ready"]);
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("off");
    expect(links.listActive()).toHaveLength(1);
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadA,
      expect.stringContaining("Merge when ready"),
    );
    expect(threads.notifyPerson).toHaveBeenCalledWith(
      threadB,
      expect.stringContaining("Merge when ready"),
    );
  });

  it("does not materialize a second link from operation history for a PR already tracked in the link registry", async () => {
    let now = "2026-11-19T10:00:00.000Z";
    const journal = openJournal(() => now);
    const operationStore = new CodeOperationEventStore({
      journal,
      uuid: randomUUID,
      clock: () => now,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const readLegacy = () => {
      const history = operationStore.summaryForThread(threadA);
      return collectLegacyPullRequestLinks({
        journal,
        threads: [
          {
            threadId: threadA,
            projectId,
            frames: history.status === "ok" ? history.frames : [],
          },
        ],
      });
    };

    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      legacyLinks: readLegacy,
    });

    // Post-change creation offline (no forge IDs yet) creates a random-UUID link,
    // and the operation result enters thread history without forge IDs too.
    const created = await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 205,
      url: "https://github.com/old-org/repo/pull/205",
      baseBranch: "main",
      headOwner: "octocat",
      headBranch: "feature/post-change",
      threadIds: [threadA],
    });
    if (created.status !== "created") throw new Error("expected created");

    const opResult: CodeOperationResult = {
      kind: "pull-request-state",
      operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000205"),
      state: "created",
      number: 205,
      url: "https://github.com/old-org/repo/pull/205",
      headRepository: "octocat",
      headBranch: "feature/post-change",
      baseRepository: "old-org/repo",
      baseBranch: "main",
    };
    operationStore.append({
      threadId: threadA,
      operationId: opResult.operationId,
      expectedCursor: 0,
      event: { kind: "operation-result", result: opResult },
    });

    // Next observation backfills forge IDs and sees a rename — must NOT materialize
    // a duplicate legacy link from operation history.
    now = "2026-11-19T11:00:00.000Z";
    const backfilled = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      lookupRepositoryOwner: "old-org",
      lookupRepositoryName: "repo",
      number: 205,
      url: "https://github.com/new-org/repo/pull/205",
      baseBranch: "main",
      headOwner: "octocat",
      headBranch: "feature/post-change",
      pullRequestNodeId: "PR_kwDO205",
      baseRepositoryNodeId: "R_kgDO205Base",
      threadIds: [threadA],
    });
    expect(backfilled.status).toBe("updated");
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]?.linkId).toBe(created.link.linkId);
    expect(
      linkEventsOf(journal).filter((event) => event.eventName === CODE_PULL_REQUEST_LINK_CREATED),
    ).toHaveLength(1);

    // Even after restart and another observation querying the old owner/name,
    // no duplicate link is ever materialized.
    const restarted = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      legacyLinks: readLegacy,
    });
    const afterRestart = await restarted.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      lookupRepositoryOwner: "old-org",
      lookupRepositoryName: "repo",
      number: 205,
      url: "https://github.com/new-org/repo/pull/205",
      baseBranch: "main",
      headOwner: "octocat",
      headBranch: "feature/post-change",
      pullRequestNodeId: "PR_kwDO205",
      baseRepositoryNodeId: "R_kgDO205Base",
      threadIds: [threadA],
    });
    expect(afterRestart.status).toBe("unchanged");
    expect(restarted.listActive()).toHaveLength(1);
    expect(
      linkEventsOf(journal).filter((event) => event.eventName === CODE_PULL_REQUEST_LINK_CREATED),
    ).toHaveLength(1);
  });

  it("creates a separate link instead of overwriting or merging when a reused repository name serves a different forge ID", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });

    const original = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "tools",
      number: 42,
      url: "https://github.com/acme/tools/pull/42",
      baseBranch: "main",
      headOwner: "acme",
      headBranch: "feature/old-repo",
      pullRequestNodeId: "PR_kwDOOld42",
      baseRepositoryNodeId: "R_kgDOOldRepo",
      threadIds: [threadA],
    });
    if (original.status !== "created") throw new Error("expected original created");

    // The old repository moved away and a brand-new repository reuses `acme/tools`
    // with its own PR #42 and distinct GitHub node IDs.
    now = "2026-11-19T12:00:00.000Z";
    const replacement = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "tools",
      number: 42,
      url: "https://github.com/acme/tools/pull/42",
      baseBranch: "main",
      headOwner: "acme",
      headBranch: "feature/new-repo",
      pullRequestNodeId: "PR_kwDONew42",
      baseRepositoryNodeId: "R_kgDONewRepo",
      threadIds: [threadB],
    });
    expect(replacement.status).toBe("created");
    if (replacement.status !== "created") throw new Error("expected separate link");
    expect(replacement.link.linkId).not.toBe(original.link.linkId);
    expect(links.listActive()).toHaveLength(2);
    expect(links.findByForgeId(projectId, "PR_kwDOOld42")).toMatchObject({
      linkId: original.link.linkId,
      baseRepositoryNodeId: "R_kgDOOldRepo",
      threadIds: [threadA],
    });
    expect(links.findByForgeId(projectId, "PR_kwDONew42")).toMatchObject({
      linkId: replacement.link.linkId,
      baseRepositoryNodeId: "R_kgDONewRepo",
      threadIds: [threadB],
    });

    // Re-observing the replacement repo stays on the new link without touching the old one.
    const repeat = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "tools",
      number: 42,
      url: "https://github.com/acme/tools/pull/42",
      baseBranch: "main",
      headOwner: "acme",
      headBranch: "feature/new-repo",
      pullRequestNodeId: "PR_kwDONew42",
      baseRepositoryNodeId: "R_kgDONewRepo",
      threadIds: [threadB],
    });
    expect(repeat.status).toBe("unchanged");
    if (repeat.status !== "unchanged") throw new Error("expected unchanged");
    expect(repeat.link.linkId).toBe(replacement.link.linkId);
  });

  it("preserves switches that were on in both duplicate links when a merge commit is interrupted and retried", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 88,
    });
    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 88,
    });
    const { switches, forge, threads } = switchFixture({
      journal,
      clock: () => now,
      linkedByTarget: new Map([
        ["old-org/repo#88", [String(threadA)]],
        ["new-org/repo#88", [String(threadB)]],
      ]),
      linkedPullRequestsByThread: new Map(),
    });

    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: newTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );

    let failNextMergeAppend = true;
    const flakyJournal: Pick<Journal, "append" | "replayAggregateType"> = {
      replayAggregateType: (query) => journal.replayAggregateType(query),
      append: (request) => {
        const events =
          typeof request === "object" &&
          request !== null &&
          "events" in request &&
          Array.isArray(request.events)
            ? request.events
            : [];
        if (
          failNextMergeAppend &&
          events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "eventName" in event &&
              event.eventName === CODE_PULL_REQUEST_LINK_MERGED_INTO,
          )
        ) {
          failNextMergeAppend = false;
          throw new Error("simulated crash before merged-into commit");
        }
        return journal.append(request);
      },
    };

    const links = new PullRequestLinkService({
      journal: flakyJournal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });
    const firstLink = await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 88,
      pullRequestNodeId: "PR_kwDO88",
      baseRepositoryNodeId: "R_kgDO88Base",
      threadIds: [threadA],
    });
    now = "2026-11-02T10:00:00.000Z";
    await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 88,
      threadIds: [threadB],
    });
    if (firstLink.status !== "created") throw new Error("expected first link");

    // First attempt crashes right as `merged-into` is about to persist.
    now = "2026-11-19T12:00:00.000Z";
    await expect(
      links.recordObservation({
        projectId,
        repositoryOwner: "new-org",
        repositoryName: "repo",
        number: 88,
        pullRequestNodeId: "PR_kwDO88",
        baseRepositoryNodeId: "R_kgDO88Base",
      }),
    ).rejects.toThrow("simulated crash");

    // Neither target's Merge when ready switch was turned off before the crash.
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("on");
    expect((await switches.query(windowId, newTarget)).mergeWhenReady.status).toBe("on");
    expect(forge.disableAutoMerge).not.toHaveBeenCalled();

    // Retry after restart completes the merge and keeps Merge when ready ON on the survivor.
    const restarted = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });
    const retried = await restarted.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 88,
      pullRequestNodeId: "PR_kwDO88",
      baseRepositoryNodeId: "R_kgDO88Base",
    });
    expect(retried.status).toBe("merged");
    if (retried.status !== "merged") throw new Error("expected merged on retry");
    expect(retried.link.linkId).toBe(firstLink.link.linkId);
    expect(retried.disabledSwitches).toEqual([]);
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("on");
    expect((await switches.query(windowId, newTarget)).mergeWhenReady.status).toBe("off");
    expect(forge.disableAutoMerge).not.toHaveBeenCalled();
    expect(threads.notifyPerson).not.toHaveBeenCalled();
  });

  it("keeps the earliest linkedAt timestamp from full thread operation history when selecting a legacy survivor", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const operationStore = new CodeOperationEventStore({
      journal,
      uuid: randomUUID,
      clock: () => now,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });

    // Thread A linked `old-org/repo#91` earliest (Nov 1), then observed it again latest (Nov 18).
    operationStore.append({
      threadId: threadA,
      operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000091"),
      expectedCursor: 0,
      event: {
        kind: "operation-result",
        result: {
          kind: "pull-request-state",
          operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000091"),
          state: "created",
          number: 91,
          url: "https://github.com/old-org/repo/pull/91",
          headRepository: "octocat",
          headBranch: "feature/earliest",
          baseRepository: "old-org/repo",
          baseBranch: "main",
        },
      },
    });
    // Thread B linked `new-org/repo#91` second (Nov 2), with last observation earlier than A's (Nov 10).
    now = "2026-11-02T10:00:00.000Z";
    operationStore.append({
      threadId: threadB,
      operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000092"),
      expectedCursor: 0,
      event: {
        kind: "operation-result",
        result: {
          kind: "pull-request-state",
          operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000092"),
          state: "existing",
          number: 91,
          url: "https://github.com/new-org/repo/pull/91",
          headRepository: "octocat",
          headBranch: "feature/earliest",
          baseRepository: "new-org/repo",
          baseBranch: "main",
        },
      },
    });
    now = "2026-11-10T10:00:00.000Z";
    operationStore.append({
      threadId: threadB,
      operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000093"),
      expectedCursor: 0,
      event: {
        kind: "operation-result",
        result: {
          kind: "pull-request-state",
          operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000093"),
          state: "existing",
          number: 91,
          url: "https://github.com/new-org/repo/pull/91",
          headRepository: "octocat",
          headBranch: "feature/earliest",
          baseRepository: "new-org/repo",
          baseBranch: "main",
        },
      },
    });
    now = "2026-11-18T10:00:00.000Z";
    operationStore.append({
      threadId: threadA,
      operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000094"),
      expectedCursor: 0,
      event: {
        kind: "operation-result",
        result: {
          kind: "pull-request-state",
          operationId: decodeCodeOperationId("30000000-0000-4000-8000-000000000094"),
          state: "existing",
          number: 91,
          url: "https://github.com/old-org/repo/pull/91",
          headRepository: "octocat",
          headBranch: "feature/earliest",
          baseRepository: "old-org/repo",
          baseBranch: "main",
        },
      },
    });

    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      legacyLinks: () =>
        collectLegacyPullRequestLinks({
          journal,
          threads: [threadA, threadB].map((threadId) => {
            const history = operationStore.historyForThread(threadId);
            return {
              threadId,
              projectId,
              frames: history.status === "ok" ? history.frames : [],
            };
          }),
        }),
    });

    now = "2026-11-19T12:00:00.000Z";
    const merged = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      lookupRepositoryOwner: "old-org",
      lookupRepositoryName: "repo",
      number: 91,
      pullRequestNodeId: "PR_kwDO91",
      baseRepositoryNodeId: "R_kgDO91Base",
    });

    expect(merged.status).toBe("merged");
    if (merged.status !== "merged") throw new Error("expected merged");
    const expectedOldId = deriveLegacyPullRequestLinkId({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 91,
    });
    expect(merged.link.linkId).toBe(expectedOldId);
    expect(merged.link.linkedAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("carries a known base repository node ID from a merged duplicate onto the surviving link when the observation omits it", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });

    // Earlier link has no forge IDs yet.
    const earlier = await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 95,
      threadIds: [threadA],
    });
    // Later duplicate link already knows both PR and base repository node IDs.
    now = "2026-11-02T10:00:00.000Z";
    await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 95,
      pullRequestNodeId: "PR_kwDO95",
      baseRepositoryNodeId: "R_kgDO95Base",
      threadIds: [threadB],
    });
    if (earlier.status !== "created") throw new Error("expected earlier link");

    // Merging observation carries PR node ID only (base repository lookup rate-limited).
    now = "2026-11-19T12:00:00.000Z";
    const merged = await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      lookupRepositoryOwner: "old-org",
      lookupRepositoryName: "repo",
      number: 95,
      pullRequestNodeId: "PR_kwDO95",
    });
    expect(merged.status).toBe("merged");
    if (merged.status !== "merged") throw new Error("expected merged");
    expect(merged.link.linkId).toBe(earlier.link.linkId);
    expect(merged.link.pullRequestNodeId).toBe("PR_kwDO95");
    expect(merged.link.baseRepositoryNodeId).toBe("R_kgDO95Base");
  });

  it("rolls back the duplicate link merge atomically when a switch-disable journal write fails and completes cleanly on retry", async () => {
    let now = "2026-11-01T10:00:00.000Z";
    const journal = openJournal(() => now);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 96,
    });
    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 96,
    });

    let failNextAutoFixDisable = false;
    const flakyJournal: Pick<Journal, "append" | "replayAggregateType" | "transaction"> = {
      replayAggregateType: (query) => journal.replayAggregateType(query),
      transaction: (body) => journal.transaction(body),
      append: (request) => {
        const events =
          typeof request === "object" &&
          request !== null &&
          "events" in request &&
          Array.isArray(request.events)
            ? request.events
            : [];
        if (
          failNextAutoFixDisable &&
          events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "eventName" in event &&
              event.eventName === CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED,
          )
        ) {
          failNextAutoFixDisable = false;
          throw new Error("simulated switch write failure after commitMerge");
        }
        return journal.append(request);
      },
    };

    const { switches, forge, threads } = switchFixture({
      journal: flakyJournal,
      clock: () => now,
      linkedByTarget: new Map([
        ["old-org/repo#96", [String(threadA)]],
        ["new-org/repo#96", [String(threadB)]],
      ]),
      linkedPullRequestsByThread: new Map([
        [String(threadA), [oldTarget]],
        [String(threadB), [newTarget]],
      ]),
    });

    // Both links have Merge when ready ON; Auto-fix is ON only on oldTarget;
    // watch is ON only on newTarget.
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: newTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await switches.setAutoFix(
      windowId,
      { kind: "enable", target: oldTarget, threadId: threadA },
      "user",
    );
    await switches.watch({
      windowId,
      threadId: threadB,
      providerInstanceId,
      signal,
    });
    expect((await switches.query(windowId, oldTarget)).autoFix.status).toBe("on");

    const links = new PullRequestLinkService({
      journal: flakyJournal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: switches,
    });
    const firstLink = await links.recordObservation({
      projectId,
      repositoryOwner: "old-org",
      repositoryName: "repo",
      number: 96,
      threadIds: [threadA],
    });
    now = "2026-11-02T10:00:00.000Z";
    await links.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      number: 96,
      threadIds: [threadB],
    });
    if (firstLink.status !== "created") throw new Error("expected first link");

    // Inject failure on the Auto-fix disable append (which runs AFTER commitMerge
    // inside the atomic transaction).
    failNextAutoFixDisable = true;
    now = "2026-11-19T12:00:00.000Z";
    await expect(
      links.recordObservation({
        projectId,
        repositoryOwner: "new-org",
        repositoryName: "repo",
        lookupRepositoryOwner: "old-org",
        lookupRepositoryName: "repo",
        number: 96,
        pullRequestNodeId: "PR_kwDO96",
        baseRepositoryNodeId: "R_kgDO96Base",
      }),
    ).rejects.toThrow("simulated switch write failure");

    // Atomic rollback: zero `merged-into` or `forge-ids-backfilled` events committed,
    // both links remain active in memory AND journal, all switches remain intact,
    // and no thread notices were sent prematurely.
    expect(links.listActive()).toHaveLength(2);
    expect(
      linkEventsOf(journal).filter(
        (event) =>
          event.eventName === CODE_PULL_REQUEST_LINK_MERGED_INTO ||
          event.eventName === CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
      ),
    ).toHaveLength(0);
    expect((await switches.query(windowId, oldTarget)).mergeWhenReady.status).toBe("on");
    expect((await switches.query(windowId, newTarget)).mergeWhenReady.status).toBe("on");
    expect((await switches.query(windowId, oldTarget)).autoFix.status).toBe("on");
    expect(switches.watching).toBe(true);
    expect(threads.notifyPerson).not.toHaveBeenCalled();

    // Restart from the durable journal and retry: reconciliation completes atomically,
    // keeps Merge when ready ON, turns mixed Auto-fix and watch OFF, and notifies threads.
    const restartedSwitches = switchFixture({
      journal,
      clock: () => now,
      linkedByTarget: new Map([
        ["old-org/repo#96", [String(threadA)]],
        ["new-org/repo#96", [String(threadB)]],
      ]),
      linkedPullRequestsByThread: new Map([
        [String(threadA), [oldTarget]],
        [String(threadB), [newTarget]],
      ]),
    });
    const restartedLinks = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: restartedSwitches.switches,
    });
    expect(restartedLinks.listActive()).toHaveLength(2);

    const recovered = await restartedLinks.recordObservation({
      projectId,
      repositoryOwner: "new-org",
      repositoryName: "repo",
      lookupRepositoryOwner: "old-org",
      lookupRepositoryName: "repo",
      number: 96,
      pullRequestNodeId: "PR_kwDO96",
      baseRepositoryNodeId: "R_kgDO96Base",
    });
    expect(recovered.status).toBe("merged");
    if (recovered.status !== "merged") throw new Error("expected merged after recovery");
    expect(recovered.link.linkId).toBe(firstLink.link.linkId);
    expect(recovered.disabledSwitches).toEqual(["auto-fix", "watch"]);
    expect(restartedLinks.listActive()).toHaveLength(1);
    expect(
      (await restartedSwitches.switches.query(windowId, oldTarget)).mergeWhenReady.status,
    ).toBe("on");
    expect(
      (await restartedSwitches.switches.query(windowId, newTarget)).mergeWhenReady.status,
    ).toBe("off");
    expect((await restartedSwitches.switches.query(windowId, oldTarget)).autoFix.status).toBe(
      "off",
    );
    await expect(
      restartedSwitches.switches.unwatch({ threadId: threadB, providerInstanceId }),
    ).resolves.toEqual({ status: "not-watching" });
    expect(forge.disableAutoMerge).not.toHaveBeenCalled();
    expect(restartedSwitches.forge.disableAutoMerge).not.toHaveBeenCalled();
    expect(restartedSwitches.threads.notifyPerson).toHaveBeenCalledWith(
      threadA,
      expect.stringContaining("Auto-fix"),
    );
    expect(restartedSwitches.threads.notifyPerson).toHaveBeenCalledWith(
      threadB,
      expect.stringContaining("Pull request watch"),
    );
  });

  it("refuses to match an existing or renamed link when a reused repository name reports a different base repository node ID without a PR node ID", async () => {
    let now = "2026-11-19T10:00:00.000Z";
    const journal = openJournal(() => now);
    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });

    const original = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "reused-name",
      number: 42,
      pullRequestNodeId: "PR_kwDOold42",
      baseRepositoryNodeId: "R_kgDOoldrepo1",
      threadIds: [threadA],
    });
    expect(original.status).toBe("created");
    if (original.status !== "created") throw new Error("expected created");

    // Same display name, missing pullRequestNodeId, DIFFERENT baseRepositoryNodeId:
    // must create a separate link rather than matching or mutating the original.
    now = "2026-11-19T11:00:00.000Z";
    const reusedActive = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "reused-name",
      number: 42,
      baseRepositoryNodeId: "R_kgDOnewrepo2",
      threadIds: [threadB],
    });
    expect(reusedActive.status).toBe("created");
    if (reusedActive.status !== "created") throw new Error("expected separate link");
    expect(String(reusedActive.link.linkId)).not.toBe(String(original.link.linkId));
    expect(links.findById(original.link.linkId)?.baseRepositoryNodeId).toBe("R_kgDOoldrepo1");
    expect(links.findById(original.link.linkId)?.threadIds).toEqual([threadA]);

    // Also prove historical display alias rejects a conflicting baseRepositoryNodeId
    // when the original repository was renamed away and a third repository takes its old name.
    now = "2026-11-19T12:00:00.000Z";
    const renamed = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "original-renamed",
      number: 42,
      pullRequestNodeId: "PR_kwDOold42",
      baseRepositoryNodeId: "R_kgDOoldrepo1",
    });
    expect(renamed.status).toBe("updated");

    now = "2026-11-19T13:00:00.000Z";
    const reusedHistorical = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "reused-name",
      number: 42,
      baseRepositoryNodeId: "R_kgDOthirdrepo3",
    });
    expect(reusedHistorical.status).toBe("created");
    if (reusedHistorical.status !== "created") throw new Error("expected third link");
    expect(String(reusedHistorical.link.linkId)).not.toBe(String(original.link.linkId));
    expect(String(reusedHistorical.link.linkId)).not.toBe(String(reusedActive.link.linkId));
    expect(links.findById(original.link.linkId)?.repositoryName).toBe("original-renamed");
    expect(
      links.resolveLink({
        projectId,
        repositoryOwner: "acme",
        repositoryName: "reused-name",
        number: 42,
        baseRepositoryNodeId: "R_kgDOoldrepo1",
      })?.linkId,
    ).toBe(original.link.linkId);
  });
});
