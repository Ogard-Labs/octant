import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  GithubRepositoryName,
  GithubRepositoryOwner,
  PULL_REQUEST_REVIEW_AGGREGATE_TYPES,
  RemoteSessionId,
  StableHostId,
  decodeCodeCheckoutId,
  decodeCodeRepositoryId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeWindowId,
  type PullRequestReviewTarget,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOW_CAPABILITY_HEADER, createRemoteDevicePrincipal } from "../clientPrincipal";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { PullRequestReviewerRegistry } from "./pullRequestReviewerRegistry";
import { createPullRequestReviewRouteHandler } from "./pullRequestReviewRoutes";
import { PullRequestReviewService } from "./pullRequestReviewService";
import {
  SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
  SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
  createSecondModelPullRequestReviewer,
} from "./secondModelPullRequestReviewer";

const NOW = "2026-11-20T12:00:00.000Z";
const PROJECT_ID = decodeProjectId("20000000-0000-4000-8000-000000000001");
const THREAD_ID = decodeCodeThreadId("30000000-0000-4000-8000-000000000001");
const CHECKOUT_ID = decodeCodeCheckoutId("40000000-0000-4000-8000-000000000001");
const REPO_ID = decodeCodeRepositoryId(`repo_${"5".repeat(64)}`);
const PROVIDER_ID = decodeProviderInstanceId("60000000-0000-4000-8000-000000000002");
const MODEL_ID = decodeProviderModelId("gpt-5.3-codex");
const HOST_ID = Schema.decodeUnknownSync(StableHostId)("70000000-0000-4000-8000-000000000001");
const DEVICE_PAIRED_ID = Schema.decodeUnknownSync(DeviceId)("71000000-0000-4000-8000-000000000001");
const DEVICE_HUB_ID = Schema.decodeUnknownSync(DeviceId)("71000000-0000-4000-8000-000000000002");
const DEVICE_RESTRICTED_ID = Schema.decodeUnknownSync(DeviceId)(
  "71000000-0000-4000-8000-000000000003",
);
const SESSION_ID = Schema.decodeUnknownSync(RemoteSessionId)(
  "72000000-0000-4000-8000-000000000001",
);
const SCOPE_WINDOW = decodeWindowId("73000000-0000-4000-8000-000000000001");

const TARGET: PullRequestReviewTarget = {
  projectId: PROJECT_ID,
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("ogard-labs"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 7,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "octant-pr-review-routes-"));
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
  const uuid = () => `90000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const registry = new PullRequestReviewerRegistry();
  registry.register({
    reviewerId: SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
    displayName: SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
    activation: () => ({ installed: true, trusted: true, enabled: true }),
    reviewer: createSecondModelPullRequestReviewer(),
  });
  const thread = decodeCodeThread({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    bindingRevisionId: "51000000-0000-4000-8000-000000000001",
    repositoryId: REPO_ID,
    checkoutId: CHECKOUT_ID,
    title: "Review PR",
    providerInstanceId: PROVIDER_ID,
    modelId: MODEL_ID,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    lifecycle: "active",
    deliveryTarget: {
      remoteName: "origin",
      proposedBaseRepository: "ogard-labs/octant",
      proposedBaseBranch: "main",
      branchIntent: "feature/review",
      outcomeKind: "opened-pr",
      confirmedAt: NOW,
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const service = new PullRequestReviewService({
    registry,
    journal,
    authority: {
      canAccessProject: () => true,
      authorizePullRequest: async () => ({
        status: "authorized",
        linkedThreadIds: [String(THREAD_ID)],
      }),
    },
    threads: {
      readThread: (id) => (String(id) === String(THREAD_ID) ? thread : undefined),
      isWorkerTurnActive: () => false,
      isStrict: () => false,
      maxStrictHandBackAttempts: () => 3,
      markOutsideContent: () => true,
      startWorkerTurn: async () => true,
    },
    runtime: {
      scratchRoot: dir,
      readCurrentHeadSha: async () => undefined,
      capturePullRequestDiff: async () => ({ status: "unavailable" }),
      inspectRoute: () => ({ status: "refused", reason: "no-account", detail: "none" }),
      postSummaryComment: async () => ({ status: "unavailable", reason: "unavailable" }),
      findings: {
        create: async () => {
          throw new Error("unused");
        },
      },
    },
    uuid,
    clock: () => NOW,
  });

  const windowAuthorityStore = new WindowAuthorityStore();
  const localCapability = randomBytes(32).toString("base64url");
  windowAuthorityStore.register({
    windowId: SCOPE_WINDOW,
    capability: localCapability,
    now: 1_000,
  });
  const handler = createPullRequestReviewRouteHandler({
    service,
    windowAuthorityStore,
    now: () => 1_000,
  });

  const localRequest = (path: string, body: unknown) =>
    new Request(`http://127.0.0.1:4100${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WINDOW_CAPABILITY_HEADER]: localCapability,
      },
      body: JSON.stringify(body),
    });

  const deviceRequest = (
    path: string,
    body: unknown,
    deviceId: typeof DEVICE_PAIRED_ID,
    admittedBy?: "host-person" | "hub-roster",
  ) => {
    const request = new Request(`http://127.0.0.1:4100${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const principal = createRemoteDevicePrincipal({
      hostId: HOST_ID,
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.octant.test",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: SESSION_ID,
      ...(admittedBy === undefined ? {} : { admittedBy }),
    });
    bindPrincipalRouteContext(request, { principal, scopeId: SCOPE_WINDOW });
    return request;
  };

  return { handler, journal, localRequest, deviceRequest };
}

describe("pull request review HTTP routes", () => {
  it("allows local windows and host-person-paired devices to update settings and journals each actor honestly", async () => {
    const { handler, journal, localRequest, deviceRequest } = setup();

    const localSave = await handler(
      localRequest("/api/code/pull-request-reviews/project", {
        projectId: PROJECT_ID,
        enabled: true,
        route: { providerInstanceId: PROVIDER_ID, modelId: MODEL_ID, effort: "medium" },
        postSummaryComment: true,
      }),
    );
    expect(localSave?.status).toBe(200);

    const pairedSave = await handler(
      deviceRequest(
        "/api/code/pull-request-reviews/pr",
        { target: TARGET, sendBlockingFindingsToWorker: true },
        DEVICE_PAIRED_ID,
        "host-person",
      ),
    );
    expect(pairedSave?.status).toBe(200);

    const projectEvents = journal.replayAggregateType({
      aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.projectSettings,
      afterSequence: 0,
      limit: 50,
    });
    expect(projectEvents).toHaveLength(1);
    expect(projectEvents[0]?.actor.kind).toBe("local-user");

    const prEvents = journal.replayAggregateType({
      aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.pullRequestSettings,
      afterSequence: 0,
      limit: 50,
    });
    expect(prEvents).toHaveLength(1);
    expect(prEvents[0]?.actor).toEqual({
      kind: "remote-device",
      actorId: DEVICE_PAIRED_ID,
      deviceId: DEVICE_PAIRED_ID,
    });
  });

  it("refuses hub-introduced and restricted devices from changing any Project, thread, or PR reviewer setting", async () => {
    const { handler, journal, deviceRequest } = setup();

    for (const [deviceId, admittedBy] of [
      [DEVICE_HUB_ID, "hub-roster"] as const,
      [DEVICE_RESTRICTED_ID, undefined] as const,
    ]) {
      const projectRes = await handler(
        deviceRequest(
          "/api/code/pull-request-reviews/project",
          {
            projectId: PROJECT_ID,
            enabled: true,
            route: { providerInstanceId: PROVIDER_ID, modelId: MODEL_ID },
            postSummaryComment: true,
          },
          deviceId,
          admittedBy,
        ),
      );
      expect(projectRes?.status).toBe(403);

      const threadRes = await handler(
        deviceRequest(
          "/api/code/pull-request-reviews/thread",
          { threadId: THREAD_ID, mode: "disabled" },
          deviceId,
          admittedBy,
        ),
      );
      expect(threadRes?.status).toBe(403);

      const prRes = await handler(
        deviceRequest(
          "/api/code/pull-request-reviews/pr",
          { target: TARGET, sendBlockingFindingsToWorker: true },
          deviceId,
          admittedBy,
        ),
      );
      expect(prRes?.status).toBe(403);
    }

    expect(
      journal.replayAggregateType({
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.projectSettings,
        afterSequence: 0,
        limit: 50,
      }),
    ).toHaveLength(0);
    expect(
      journal.replayAggregateType({
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.threadOverride,
        afterSequence: 0,
        limit: 50,
      }),
    ).toHaveLength(0);
    expect(
      journal.replayAggregateType({
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.pullRequestSettings,
        afterSequence: 0,
        limit: 50,
      }),
    ).toHaveLength(0);
  });
});
