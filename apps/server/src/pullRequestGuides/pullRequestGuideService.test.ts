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
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type {
  PullRequestReviewHostRuntimePort,
  PullRequestReviewTurnExecutionResult,
} from "../pullRequestReviewers/pullRequestReviewService";
import { createBundledPullRequestGuideWriter } from "./bundledPullRequestGuideWriter";
import { PullRequestGuideService, validateGuideStops } from "./pullRequestGuideService";

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
  readonly captureThrows?: boolean;
  readonly turnWaitsForAbort?: boolean;
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
    readCurrentHeadSha: async () => head.current,
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
      return { status: "completed", sessionId: "fake", text: options.reply ?? GUIDE_REPLY };
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
  const make = () =>
    new PullRequestGuideService({
      journal,
      authority: {
        authorizePullRequest: async () => ({
          status: "authorized",
          linkedThreadIds: [String(THREAD_ID)],
        }),
        threadPullRequest: async () => ({ status: "resolved", target: TARGET }),
      },
      readThread: () => makeThread(),
      guideRoute: () => options.route,
      runtime,
      writer: createBundledPullRequestGuideWriter(),
      uuid,
      clock: () => NOW,
    });
  return { make, turns, spend, head };
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
});
