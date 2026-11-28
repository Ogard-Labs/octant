import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodeDigest,
  GithubRepositoryName,
  GithubRepositoryOwner,
  decodeCodeFileId,
  decodeCodeOperationId,
  decodeCodeRelativePath,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodePullRequestReviewDiffSnapshot,
  decodeWindowId,
  type CodeThread,
  type PullRequestReviewRoute,
  type PullRequestReviewTarget,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestLinkService } from "../code/pullRequestLinkService";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type {
  PullRequestReviewHostRuntimePort,
  PullRequestReviewTurnExecutionResult,
} from "../pullRequestReviewers/pullRequestReviewService";
import {
  BUNDLED_PULL_REQUEST_GUIDE_WRITER_DISPLAY_NAME,
  BUNDLED_PULL_REQUEST_GUIDE_WRITER_ID,
  createBundledPullRequestGuideWriter,
} from "./bundledPullRequestGuideWriter";
import { PullRequestGuideService, validateGuideStops } from "./pullRequestGuideService";
import { PullRequestGuideWriterRegistry } from "./pullRequestGuideWriterRegistry";
import {
  PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
  type PullRequestGuideWriter,
} from "@octant/plugin-api/pull-request-guide-writer";

const NOW = "2026-11-26T12:00:00.000Z";
const WINDOW_ID = decodeWindowId("10000000-0000-4000-8000-000000000001");
const PROJECT_ID = decodeProjectId("20000000-0000-4000-8000-000000000001");
const THREAD_ID = decodeCodeThreadId("30000000-0000-4000-8000-000000000001");
const HEAD_1 = "a".repeat(40);
const HEAD_2 = "b".repeat(40);
const ROUTE: PullRequestReviewRoute = {
  providerInstanceId: decodeProviderInstanceId("60000000-0000-4000-8000-000000000002"),
  modelId: decodeProviderModelId("guide-model"),
};
const TARGET: PullRequestReviewTarget = {
  projectId: PROJECT_ID,
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("ogard-labs"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 42,
};
const PATCH = [
  "@@ -1,3 +1,4 @@",
  " export function allow(role: string) {",
  "+  if (role === 'guest') return true;",
  "   return role === 'owner';",
  " }",
].join("\n");

const DIFF = decodePullRequestReviewDiffSnapshot({
  headSha: HEAD_1,
  baseRef: "main",
  reviewOperationId: decodeCodeOperationId("70000000-0000-4000-8000-000000000001"),
  files: [
    {
      fileId: decodeCodeFileId("71000000-0000-4000-8000-000000000001"),
      path: decodeCodeRelativePath("src/auth.ts"),
      fileDigest: Schema.decodeUnknownSync(CodeDigest)("1".repeat(64)),
      status: "modified",
      patch: PATCH,
    },
  ],
});

const GUIDE_REPLY = JSON.stringify({
  stops: [
    {
      title: "Guests are let in",
      why: "This widens who passes the check.",
      needsDecision: true,
      anchors: [
        { path: "src/auth.ts", startLine: 2, endLine: 2 },
        { path: "src/elsewhere.ts", startLine: 1, endLine: 3 },
        { path: "src/auth.ts", startLine: 80, endLine: 90 },
      ],
    },
    { title: "Nothing to anchor", why: "", needsDecision: false, anchors: [] },
  ],
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeThread(): CodeThread {
  return decodeCodeThread({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    bindingRevisionId: "51000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"5".repeat(64)}`,
    checkoutId: "40000000-0000-4000-8000-000000000001",
    title: "Tighten auth check",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "worker-model",
    executionPolicy: "full-access",
    permissionPersistence: "current-session",
    lifecycle: "active",
    deliveryTarget: {
      remoteName: "origin",
      proposedBaseRepository: "ogard-labs/octant",
      proposedBaseBranch: "main",
      branchIntent: "feature/auth",
      outcomeKind: "opened-pr",
      confirmedAt: NOW,
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function harness(options: {
  readonly route?: PullRequestReviewRoute;
  readonly admit?: "admitted" | "refused";
  readonly head?: { current: string };
  readonly reply?: string;
  /** Read at each turn, so a second run can answer differently. */
  readonly replies?: { current: string };
  readonly captureThrows?: boolean;
  readonly turnWaitsForAbort?: boolean;
  readonly readHead?: () => Promise<string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "octant-pr-guide-"));
  dirs.push(dir);
  const connection = openSqlite(join(dir, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => NOW,
  });
  let counter = 0;
  const uuid = () => `80000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const head = options.head ?? { current: HEAD_1 };
  const turns: string[] = [];
  const spend: string[] = [];
  const recordedUsage: Array<{ readonly modelId: string }> = [];
  const runtime: Pick<
    PullRequestReviewHostRuntimePort,
    | "readCurrentHeadSha"
    | "capturePullRequestDiff"
    | "inspectRoute"
    | "executeReadOnlyTurn"
    | "scratchRoot"
    | "spendCeiling"
    | "recordUsage"
  > = {
    scratchRoot: dir,
    readCurrentHeadSha: async () => (options.readHead ? options.readHead() : head.current),
    recordUsage: (entry) => {
      recordedUsage.push({ modelId: String(entry.modelId) });
    },
    capturePullRequestDiff: async () => {
      if (options.captureThrows === true) throw new Error("gh refused");
      return { status: "ready", capture: { snapshot: DIFF } };
    },
    inspectRoute: () => ({ status: "ready" }),
    // A fake turn: no provider is reached and nothing is billed.
    executeReadOnlyTurn: async (input): Promise<PullRequestReviewTurnExecutionResult> => {
      turns.push(input.prompt);
      if (options.turnWaitsForAbort === true) {
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => resolve()),
        );
        return { status: "cancelled" } as never;
      }
      return {
        status: "completed",
        sessionId: "fake",
        text: options.replies?.current ?? options.reply ?? GUIDE_REPLY,
      };
    },
    spendCeiling: {
      admit: () => {
        spend.push("admit");
        return options.admit === "refused"
          ? ({ status: "refused" } as never)
          : ({ status: "admitted" } as never);
      },
      settle: () => {
        spend.push("settle");
      },
      abandon: () => {
        spend.push("abandon");
      },
    },
  };
  let writerEnabled = true;
  const writers = new PullRequestGuideWriterRegistry();
  writers.register({
    writerId: BUNDLED_PULL_REQUEST_GUIDE_WRITER_ID,
    displayName: BUNDLED_PULL_REQUEST_GUIDE_WRITER_DISPLAY_NAME,
    activation: () => ({ installed: true, trusted: true, enabled: writerEnabled }),
    writer: createBundledPullRequestGuideWriter(),
  });
  const pullRequestLinks = new PullRequestLinkService({
    journal,
    uuid,
    clock: () => NOW,
  });
  const make = (serviceOptions?: { readonly withLinks?: boolean }) =>
    new PullRequestGuideService({
      journal,
      ...(serviceOptions?.withLinks === true ? { pullRequestLinks } : {}),
      authority: {
        authorizePullRequest: async (_windowId, requestedTarget) => {
          const link =
            serviceOptions?.withLinks === true
              ? pullRequestLinks.resolveLink({
                  projectId: requestedTarget.projectId,
                  repositoryOwner: requestedTarget.repositoryOwner,
                  repositoryName: requestedTarget.repositoryName,
                  number: requestedTarget.number,
                })
              : undefined;
          return {
            status: "authorized",
            linkedThreadIds: [String(THREAD_ID)],
            ...(link?.pullRequestNodeId === undefined
              ? {}
              : { pullRequestNodeId: link.pullRequestNodeId }),
          };
        },
        threadPullRequest: async () => ({ status: "resolved", target: TARGET }),
      },
      readThread: () => makeThread(),
      guideRoute: () => options.route,
      runtime,
      writers,
      uuid,
      clock: () => NOW,
    });
  return {
    make,
    journal,
    pullRequestLinks,
    turns,
    spend,
    recordedUsage,
    head,
    writers,
    setWriterEnabled: (enabled: boolean) => {
      writerEnabled = enabled;
    },
  };
}

describe("review guides", () => {
  it("drops an anchor outside the head's diff", () => {
    const stops = validateGuideStops(
      [
        {
          title: "Guests",
          why: "Widens access.",
          needsDecision: false,
          anchors: [
            { path: "src/auth.ts", startLine: 2, endLine: 3 },
            { path: "src/auth.ts", startLine: 40, endLine: 41 },
            { path: "README.md", startLine: 1, endLine: 1 },
          ],
        },
      ],
      DIFF,
    );
    expect(stops).toEqual([
      {
        id: "stop-1",
        title: "Guests",
        why: "Widens access.",
        needsDecision: false,
        anchors: [{ path: "src/auth.ts", startLine: 2, endLine: 3 }],
      },
    ]);
  });

  it("keeps at most 30 stops and 8 anchors a stop", () => {
    const anchor = { path: "src/auth.ts", startLine: 1, endLine: 2 };
    const stops = validateGuideStops(
      Array.from({ length: 40 }, (_, index) => ({
        title: `Stop ${index}`,
        why: "",
        needsDecision: false,
        anchors: Array.from({ length: 12 }, () => anchor),
      })),
      DIFF,
    );
    expect(stops).toHaveLength(30);
    expect(stops[0]?.anchors).toHaveLength(8);
  });

  it("writes a guide for the head, keeps unanchored stops, and reads stale after a push", async () => {
    const { make, turns, spend, head } = harness({ route: ROUTE });
    const service = make();
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const result = await started.done;
    expect(result.status).toBe("recorded");
    expect(turns).toHaveLength(1);
    expect(spend).toEqual(["admit", "settle"]);

    const fresh = await service.read(WINDOW_ID, TARGET, HEAD_1);
    expect(fresh.status === "read" && fresh.view.stale).toBe(false);
    const stops = fresh.status === "read" ? (fresh.view.guide?.stops ?? []) : [];
    expect(stops.map((stop) => [stop.title, stop.anchors.length, stop.needsDecision])).toEqual([
      ["Guests are let in", 1, true],
      ["Nothing to anchor", 0, false],
    ]);

    head.current = HEAD_2;
    const afterPush = await service.read(WINDOW_ID, TARGET, HEAD_2);
    expect(afterPush.status === "read" && afterPush.view.stale).toBe(true);

    // The projection is rebuilt from the journal alone.
    const reloaded = await make().read(WINDOW_ID, TARGET, HEAD_1);
    expect(reloaded.status === "read" && reloaded.view.guide?.stops.length).toBe(2);
  });

  it("keeps the saved guide when a Rewrite yields no usable stop", async () => {
    const replies = { current: GUIDE_REPLY };
    const { make } = harness({ route: ROUTE, replies });
    const service = make();
    const first = await service.writeForPerson(WINDOW_ID, TARGET);
    if (first.status !== "started") throw new Error("expected a started run");
    expect((await first.done).status).toBe("recorded");

    replies.current = JSON.stringify({ stops: [{ why: "no title" }] });
    const rewrite = await service.writeForPerson(WINDOW_ID, TARGET);
    if (rewrite.status !== "started") throw new Error("expected a started run");
    expect(await rewrite.done).toEqual({ status: "failed", reason: "invalid-output" });
    const read = await service.read(WINDOW_ID, TARGET, HEAD_1);
    expect(read.status === "read" && read.view.guide?.stops.length).toBe(2);
  });

  it("reads a reply whose stop quotes a fenced snippet", async () => {
    const reply = JSON.stringify({
      stops: [
        {
          title: "Guests are let in",
          why: "It now reads:\n```ts\nreturn true;\n```",
          needsDecision: false,
          anchors: [{ path: "src/auth.ts", startLine: 2, endLine: 2 }],
        },
      ],
    });
    const { make } = harness({ route: ROUTE, reply });
    const started = await make().writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected a started run");
    expect((await started.done).status).toBe("recorded");
  });

  it("refuses a guide run when no model is picked", async () => {
    const { make, turns, spend } = harness({});
    const service = make();
    expect(await service.writeForPerson(WINDOW_ID, TARGET)).toEqual({
      status: "refused",
      reason: "no-model",
    });
    const read = await service.read(WINDOW_ID, TARGET, HEAD_1);
    expect(read.status === "read" && read.view.modelPicked).toBe(false);
    expect(turns).toEqual([]);
    expect(spend).toEqual([]);
  });

  it("refuses a guide run past the spend ceiling", async () => {
    const { make, turns } = harness({ route: ROUTE, admit: "refused" });
    const service = make();
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected a started run");
    expect(await started.done).toEqual({ status: "failed", reason: "spend-ceiling" });
    expect(turns).toEqual([]);
    const read = await service.read(WINDOW_ID, TARGET, HEAD_1);
    expect(read.status === "read" && read.view.lastFailure).toBe("spend-ceiling");
  });

  it("runs one guide per pull request at a time", async () => {
    const { make } = harness({ route: ROUTE });
    const service = make();
    const first = await service.writeForPerson(WINDOW_ID, TARGET);
    expect(await service.writeForPerson(WINDOW_ID, TARGET)).toEqual({
      status: "refused",
      reason: "running",
    });
    if (first.status === "started") await first.done;
  });

  it("refuses model output over 16 KB", async () => {
    const { make } = harness({ route: ROUTE, reply: "x".repeat(17 * 1024) });
    const started = await make().writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected a started run");
    expect(await started.done).toEqual({ status: "failed", reason: "invalid-output" });
  });

  it("records head-stale when a push lands during the run", async () => {
    const head = { current: HEAD_1 };
    const { make } = harness({ route: ROUTE, head });
    const service = make();
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected a started run");
    head.current = HEAD_2;
    expect(await started.done).toEqual({ status: "failed", reason: "head-stale" });
  });

  it("asks before an agent's run and starts nothing when the person declines", async () => {
    const { make, turns } = harness({ route: ROUTE });
    const service = make();
    const asked: number[] = [];
    const declined = await service.writeForThread(WINDOW_ID, THREAD_ID, async (target) => {
      asked.push(target.number);
      return false;
    });
    expect(declined).toEqual({ status: "not-confirmed" });
    expect(asked).toEqual([42]);
    expect(turns).toEqual([]);
  });

  it("gives back the spend reservation and frees the pull request when reading the diff throws", async () => {
    const { make, spend } = harness({ route: ROUTE, captureThrows: true });
    const service = make();
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected a started run");
    expect((await started.done).status).toBe("failed");
    expect(spend).toEqual(["admit", "abandon"]);
    const read = await service.read(WINDOW_ID, TARGET, HEAD_1);
    expect(read.status === "read" && read.view.running).toBe(false);
  });

  it("stopping the agent's turn cancels the guide run it started", async () => {
    const { make, turns } = harness({ route: ROUTE, turnWaitsForAbort: true });
    const service = make();
    const turn = new AbortController();
    const started = await service.writeForThread(WINDOW_ID, THREAD_ID, undefined, turn.signal);
    if (started.status !== "started") throw new Error("expected a started run");
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turn.abort();
    expect(await started.done).toEqual({ status: "failed", reason: "cancelled" });
  });

  it("an earlier push's failure is not shown for the new head", async () => {
    const { make } = harness({ route: ROUTE, admit: "refused" });
    const service = make();
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    if (started.status === "started") await started.done;
    const read = await service.read(WINDOW_ID, TARGET, HEAD_2);
    expect(read.status === "read" && read.view.lastFailure).toBeUndefined();
  });

  it("refuses guide runs with not-effective and bills nothing when the writer plugin is disabled", async () => {
    const { make, turns, spend, setWriterEnabled } = harness({ route: ROUTE });
    setWriterEnabled(false);
    const service = make();
    expect(await service.writeForPerson(WINDOW_ID, TARGET)).toEqual({
      status: "refused",
      reason: "not-effective",
    });
    const confirm = vi.fn(async () => true);
    expect(await service.writeForThread(WINDOW_ID, THREAD_ID, confirm)).toEqual({
      status: "refused",
      reason: "not-effective",
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(turns).toEqual([]);
    expect(spend).toEqual([]);
  });

  it("resolves a third-party guide writer only once installed, trusted, and enabled", async () => {
    const { make, turns, spend, writers, setWriterEnabled } = harness({ route: ROUTE });
    setWriterEnabled(false);
    let trusted = false;
    const customWriter: PullRequestGuideWriter = {
      kind: PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
      write: async (_request, host, signal) => {
        const diff = await host.readPullRequestDiff(signal);
        if (diff.status !== "ready") return { status: "failed", detail: "no diff" };
        return {
          status: "written",
          stops: [
            {
              title: "Third-party stop",
              why: "Proposed by the active third-party writer plugin.",
              needsDecision: true,
              anchors: [{ path: "src/auth.ts", startLine: 2, endLine: 3 }],
            },
          ],
        };
      },
    };
    writers.register({
      writerId: "acme/custom-guide-writer",
      displayName: "Custom writer",
      activation: () => ({ installed: true, trusted, enabled: true }),
      writer: customWriter,
    });
    const service = make();
    // Discovery/install alone (untrusted) grants nothing and bills nothing.
    expect(await service.writeForPerson(WINDOW_ID, TARGET)).toEqual({
      status: "refused",
      reason: "not-effective",
    });
    expect(turns).toEqual([]);
    expect(spend).toEqual([]);

    // Once trusted as well as installed and enabled, the third-party writer runs.
    trusted = true;
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected third-party writer to start");
    const outcome = await started.done;
    expect(outcome.status).toBe("recorded");
    if (outcome.status === "recorded") {
      expect(outcome.guide.stops[0]?.title).toBe("Third-party stop");
    }
  });

  it("revokes the writer host port and abandons spend if the plugin is disabled mid-run", async () => {
    const { make, turns, spend, writers, setWriterEnabled } = harness({ route: ROUTE });
    setWriterEnabled(false);
    let active = true;
    writers.register({
      writerId: "acme/midrun-disabled-writer",
      displayName: "Mid-run disabled writer",
      activation: () => ({ installed: true, trusted: true, enabled: active }),
      writer: {
        kind: PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
        write: async (_request, host, signal) => {
          await host.readPullRequestDiff(signal);
          active = false;
          const turn = await host.runReadOnlyGuideTurn({ prompt: "write guide" }, signal);
          if (turn.status !== "completed") {
            return { status: "refused", detail: "writer became inactive" };
          }
          return {
            status: "written",
            stops: [{ title: "Should not record", why: "", needsDecision: false, anchors: [] }],
          };
        },
      },
    });
    const service = make();
    const started = await service.writeForPerson(WINDOW_ID, TARGET);
    if (started.status !== "started") throw new Error("expected started run");
    expect(await started.done).toEqual({ status: "failed", reason: "unavailable" });
    expect(turns).toEqual([]);
    expect(spend).toEqual(["admit", "abandon"]);
  });

  it("withholds recording a rewrite if the writer plugin is disabled during the final head check, while keeping usage recorded", async () => {
    const replies = { current: GUIDE_REPLY };
    let headChecks = 0;
    let releaseFinalHeadCheck: (() => void) | undefined;
    let finalHeadCheckStarted: (() => void) | undefined;
    const waitingOnFinalHeadCheck = new Promise<void>((resolve) => {
      finalHeadCheckStarted = resolve;
    });
    const { make, recordedUsage, setWriterEnabled } = harness({
      route: ROUTE,
      replies,
      readHead: async () => {
        headChecks += 1;
        // Calls 1–2 are the initial guide's start and final check; call 3 is the rewrite's start;
        // call 4 is the rewrite's final head check right before persisting.
        if (headChecks === 4) {
          finalHeadCheckStarted?.();
          await new Promise<void>((resolve) => {
            releaseFinalHeadCheck = resolve;
          });
        }
        return HEAD_1;
      },
    });
    const service = make();
    const initial = await service.writeForPerson(WINDOW_ID, TARGET);
    if (initial.status !== "started") throw new Error("expected initial guide run");
    expect((await initial.done).status).toBe("recorded");
    expect(recordedUsage).toHaveLength(1);

    replies.current = JSON.stringify({
      stops: [
        {
          title: "Replacement stop after disablement",
          why: "Must never replace the saved guide once the writer is turned off.",
          needsDecision: true,
          anchors: [{ path: "src/auth.ts", startLine: 2, endLine: 2 }],
        },
      ],
    });
    const rewrite = await service.writeForPerson(WINDOW_ID, TARGET);
    if (rewrite.status !== "started") throw new Error("expected rewrite run");
    await waitingOnFinalHeadCheck;
    setWriterEnabled(false);
    releaseFinalHeadCheck?.();

    expect(await rewrite.done).toEqual({ status: "failed", reason: "unavailable" });
    // Usage for the completed model turn is still recorded, while the saved guide stays untouched.
    expect(recordedUsage).toHaveLength(2);
    const read = await service.read(WINDOW_ID, TARGET, HEAD_1);
    expect(read.status).toBe("read");
    if (read.status === "read") {
      expect(read.view.guide?.stops[0]?.title).toBe("Guests are let in");
    }
  });

  it("keeps a guide across a repository rename and never shares it when a different pull request reuses the old repository name", async () => {
    const { make, pullRequestLinks } = harness({ route: ROUTE });
    const beforeRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("app"),
      number: 9,
    };
    const afterRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("application"),
      number: 9,
    };

    await pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_app9",
      baseRepositoryNodeId: "R_kgDO_app",
      threadIds: [THREAD_ID],
    });

    const service = make({ withLinks: true });
    const started = await service.writeForPerson(WINDOW_ID, beforeRename);
    if (started.status !== "started") throw new Error("expected guide run");
    expect((await started.done).status).toBe("recorded");

    // Rename acme/app -> acme/application on the same linked PR node ID.
    await pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "application",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_app9",
      baseRepositoryNodeId: "R_kgDO_app",
      threadIds: [THREAD_ID],
    });

    // A different pull request later reuses the old name acme/app#9 with a distinct node ID.
    await pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_reused9",
      baseRepositoryNodeId: "R_kgDO_reused",
      threadIds: [THREAD_ID],
    });

    const readAfterRename = await service.read(WINDOW_ID, afterRename, HEAD_1);
    expect(readAfterRename.status).toBe("read");
    if (readAfterRename.status === "read") {
      expect(readAfterRename.view.guide?.stops[0]?.title).toBe("Guests are let in");
    }

    const readReused = await service.read(WINDOW_ID, beforeRename, HEAD_1);
    expect(readReused.status).toBe("read");
    if (readReused.status === "read") {
      expect(readReused.view.guide).toBeUndefined();
    }

    // Replaying from the journal preserves both the renamed PR's guide and isolation.
    const restarted = make({ withLinks: true });
    const replayedRenamed = await restarted.read(WINDOW_ID, afterRename, HEAD_1);
    expect(replayedRenamed.status).toBe("read");
    if (replayedRenamed.status === "read") {
      expect(replayedRenamed.view.guide?.stops[0]?.title).toBe("Guests are let in");
    }
    const replayedReused = await restarted.read(WINDOW_ID, beforeRename, HEAD_1);
    expect(replayedReused.status).toBe("read");
    if (replayedReused.status === "read") {
      expect(replayedReused.view.guide).toBeUndefined();
    }
  });

  it("replays a legacy coordinate-keyed guide across a repository rename, allows rewrites without a version conflict, and isolates reused names", async () => {
    const replies = { current: GUIDE_REPLY };
    const { make, pullRequestLinks, head } = harness({ route: ROUTE, replies });
    const beforeRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("app"),
      number: 9,
    };
    const afterRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("application"),
      number: 9,
    };

    // Write a legacy guide BEFORE any PR link or node ID exists (stored under `${projectId}:acme/app#9`).
    const legacyService = make({ withLinks: false });
    const legacyRun = await legacyService.writeForPerson(WINDOW_ID, beforeRename);
    if (legacyRun.status !== "started") throw new Error("expected legacy guide run");
    expect((await legacyRun.done).status).toBe("recorded");

    // Link is created, backfilled with a GitHub node ID, and later renamed to acme/application#9.
    await pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      threadIds: [THREAD_ID],
    });
    await pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "application",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_legacy9",
      baseRepositoryNodeId: "R_kgDO_legacy",
      threadIds: [THREAD_ID],
    });
    // Another PR later reuses acme/app#9 with a different node ID.
    await pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_new9",
      baseRepositoryNodeId: "R_kgDO_new",
      threadIds: [THREAD_ID],
    });

    const replayed = make({ withLinks: true });
    const renamedRead = await replayed.read(WINDOW_ID, afterRename, HEAD_1);
    expect(renamedRead.status).toBe("read");
    if (renamedRead.status === "read") {
      expect(renamedRead.view.guide?.stops[0]?.title).toBe("Guests are let in");
    }

    const reusedRead = await replayed.read(WINDOW_ID, beforeRename, HEAD_1);
    expect(reusedRead.status).toBe("read");
    if (reusedRead.status === "read") {
      expect(reusedRead.view.guide).toBeUndefined();
    }

    // Rewriting the guide after upgrading to the node-ID aggregate must succeed without version conflicts.
    head.current = HEAD_2;
    replies.current = JSON.stringify({
      stops: [
        {
          title: "Post-rename guide stop",
          why: "Written on the stable node-ID aggregate after replaying legacy history.",
          needsDecision: false,
          anchors: [],
        },
      ],
    });
    const rewrite = await replayed.writeForPerson(WINDOW_ID, afterRename);
    if (rewrite.status !== "started") throw new Error("expected post-rename rewrite");
    expect((await rewrite.done).status).toBe("recorded");

    const afterRestart = make({ withLinks: true });
    const latestRead = await afterRestart.read(WINDOW_ID, afterRename, HEAD_2);
    expect(latestRead.status).toBe("read");
    if (latestRead.status === "read") {
      expect(latestRead.view.guide?.stops[0]?.title).toBe("Post-rename guide stop");
    }
  });
});
