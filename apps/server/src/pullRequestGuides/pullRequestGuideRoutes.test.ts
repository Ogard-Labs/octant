import { randomBytes } from "node:crypto";
import {
  DeviceId,
  GithubRepositoryName,
  GithubRepositoryOwner,
  RemoteSessionId,
  StableHostId,
  decodeProjectId,
  decodeWindowId,
  type PullRequestReviewTarget,
} from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WINDOW_CAPABILITY_HEADER, createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createBundledPullRequestGuideWriter } from "./bundledPullRequestGuideWriter";
import { createPullRequestGuideRouteHandler } from "./pullRequestGuideRoutes";
import { PullRequestGuideService } from "./pullRequestGuideService";

const SCOPE_WINDOW = decodeWindowId("73000000-0000-4000-8000-000000000001");
const TARGET: PullRequestReviewTarget = {
  projectId: decodeProjectId("20000000-0000-4000-8000-000000000001"),
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("ogard-labs"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 7,
};

function setup() {
  const viewedCalls: string[] = [];
  const service = new PullRequestGuideService({
    journal: {
      append: () => {
        throw new Error("no guide run is expected");
      },
      replayAggregateType: () => [],
    },
    authority: {
      authorizePullRequest: async () => ({ status: "authorized", linkedThreadIds: [] }),
      threadPullRequest: async () => ({ status: "refused", reason: "no-pull-request" }),
    },
    readThread: () => undefined,
    guideRoute: () => undefined,
    runtime: {
      scratchRoot: "/nonexistent",
      readCurrentHeadSha: async () => undefined,
      capturePullRequestDiff: async () => ({ status: "unavailable" }),
      inspectRoute: () => ({ status: "refused" }),
    },
    writer: createBundledPullRequestGuideWriter(),
    uuid: () => "80000000-0000-4000-8000-000000000001",
  });
  const windowAuthorityStore = new WindowAuthorityStore();
  const capability = randomBytes(32).toString("base64url");
  windowAuthorityStore.register({ windowId: SCOPE_WINDOW, capability, now: 1_000 });
  const handler = createPullRequestGuideRouteHandler({
    service,
    viewed: {
      read: async () => {
        viewedCalls.push("read");
        return { status: "read", view: { files: [] } };
      },
      write: async () => {
        viewedCalls.push("write");
        return { status: "done" };
      },
    },
    windowAuthorityStore,
    now: () => 1_000,
  });
  const local = (path: string, body: unknown) =>
    new Request(`http://127.0.0.1:4100/api/code/pull-request-guides${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [WINDOW_CAPABILITY_HEADER]: capability },
      body: JSON.stringify(body),
    });
  const pairedPhone = (path: string, body: unknown) => {
    const request = new Request(`http://127.0.0.1:4100/api/code/pull-request-guides${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: Schema.decodeUnknownSync(StableHostId)("70000000-0000-4000-8000-000000000001"),
        deviceId: Schema.decodeUnknownSync(DeviceId)("71000000-0000-4000-8000-000000000001"),
        credentialGeneration: 1,
        origin: "https://remote.octant.test",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(
          "72000000-0000-4000-8000-000000000001",
        ),
        admittedBy: "host-person",
      }),
      scopeId: SCOPE_WINDOW,
    });
    return request;
  };
  return { handler, local, pairedPhone, viewedCalls };
}

describe("pull request guide routes", () => {
  it("a paired device can read a guide but not start one", async () => {
    const { handler, pairedPhone } = setup();
    const read = await handler(pairedPhone("/query", { target: TARGET }));
    expect(read?.status).toBe(200);
    expect(await read?.json()).toEqual({ stale: false, running: false, modelPicked: false });
    const write = await handler(pairedPhone("/write", { target: TARGET }));
    expect(write?.status).toBe(403);
  });

  it("marking a file Viewed is refused from a paired device", async () => {
    const { handler, pairedPhone, viewedCalls } = setup();
    const mark = await handler(
      pairedPhone("/viewed", { target: TARGET, path: "src/auth.ts", viewed: true }),
    );
    expect(mark?.status).toBe(403);
    expect(viewedCalls).toEqual([]);
  });

  it("a local window marks a file Viewed through GitHub and starts no run without a model", async () => {
    const { handler, local, viewedCalls } = setup();
    const mark = await handler(
      local("/viewed", { target: TARGET, path: "src/auth.ts", viewed: true }),
    );
    expect(mark?.status).toBe(200);
    expect(viewedCalls).toEqual(["write"]);
    const write = await handler(local("/write", { target: TARGET }));
    expect(write?.status).toBe(409);
    expect(await write?.json()).toMatchObject({ reason: "no-model" });
  });
});
