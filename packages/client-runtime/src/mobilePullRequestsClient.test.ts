import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { listMobilePullRequests, setMobilePullRequestBabysit } from "./mobilePullRequestsClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const projectId = "20000000-0000-4000-8000-000000000002";

const view = {
  version: 1,
  query: { version: 1 },
  projects: [
    {
      kind: "connected",
      projectId,
      projectName: "Octant",
      repositoryOwner: "octocat",
      repositoryName: "octant",
    },
  ],
  rows: [
    {
      projectId,
      projectName: "Octant",
      repositoryOwner: "octocat",
      repositoryName: "octant",
      number: 812,
      title: "Polish the review loop",
      draft: false,
      state: "open",
      mergeability: "mergeable",
      author: "octocat",
      baseBranch: "main",
      headBranch: "feature/review-loop",
      updatedAt: "2026-11-20T09:00:00Z",
      checks: "failing",
      review: "approved",
      failingChecks: [{ name: "typecheck" }],
      linkedThreads: [{ threadId: "60000000-0000-4000-8000-000000000001", title: "Review loop" }],
    },
  ],
  repositoriesTruncated: false,
  pullRequestsTruncated: true,
  freshness: { status: "fresh" },
  generatedAt: "2026-11-20T09:01:00.000Z",
};

function host(answer: () => Response | Promise<Response>) {
  const sent: Array<{ path: string; body: unknown; contentType: string | undefined }> = [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: async (request) => {
      sent.push({
        path: request.path,
        body: JSON.parse(String(request.body)),
        contentType: request.contentType,
      });
      return answer();
    },
  };
  return { transport, sent };
}

describe("listing a computer's pull requests from the phone", () => {
  it("reads the cached overview for every Project, and asks for a refresh of all of them on pull", async () => {
    const { transport, sent } = host(() => Response.json(view));
    const cached = await listMobilePullRequests(transport);
    const refreshed = await listMobilePullRequests(transport, { refresh: true });

    expect(sent).toEqual([
      {
        path: "/api/code/project-pull-requests",
        body: { version: 1 },
        contentType: "application/json",
      },
      {
        path: "/api/code/project-pull-requests/refresh",
        body: { kind: "refresh-all" },
        contentType: "application/json",
      },
    ]);
    expect(cached).toMatchObject({ status: "ready", hostId, truncated: true });
    expect(cached.status === "ready" ? cached.rows.map((row) => row.number) : []).toEqual([812]);
    expect(refreshed.status).toBe("ready");
  });

  it("says a computer refused, could not be reached, or answered unreadably, as values", async () => {
    expect(
      (await listMobilePullRequests(host(() => new Response("", { status: 403 })).transport))
        .status,
    ).toBe("refused");
    expect(
      (await listMobilePullRequests(host(() => new Response("", { status: 503 })).transport))
        .status,
    ).toBe("unavailable");
    expect(
      (
        await listMobilePullRequests(
          host(() => {
            throw new TypeError("offline");
          }).transport,
        )
      ).status,
    ).toBe("unavailable");
    expect(
      (await listMobilePullRequests(host(() => Response.json({ rows: "nope" })).transport)).status,
    ).toBe("unavailable");
  });
});

describe("Babysit from the phone", () => {
  const threadId = "60000000-0000-4000-8000-000000000001";
  const target = { projectId, repositoryOwner: "octocat", repositoryName: "octant", number: 812 };
  const stoppedAt = "2026-11-26T08:00:00.000Z";
  const switchesView = (autoFix: unknown) => ({
    version: 1,
    target,
    mergeWhenReady: { status: "off" },
    autoFix,
    generatedAt: "2026-11-26T09:00:00.000Z",
  });
  function host(answers: Record<string, (body: unknown) => Response>) {
    const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async ({ path, body }) => {
        const parsed: unknown = body === undefined ? undefined : JSON.parse(String(body));
        sent.push({ path, body: parsed });
        const answer = answers[path];
        return answer === undefined ? new Response("", { status: 404 }) : answer(parsed);
      },
    };
    return { sent, transport };
  }

  it("restarts a stopped Babysit only from the stop the phone just read", async () => {
    const on = { status: "on", threadId, enabledAt: "2026-11-26T09:00:00.000Z" };
    const { sent, transport } = host({
      "/api/code/project-pull-requests/switches": () =>
        Response.json(
          switchesView({ status: "stopped", threadId, stoppedAt, reason: "attempt-limit" }),
        ),
      "/api/code/project-pull-requests/auto-fix": () =>
        Response.json({ status: "applied", view: switchesView(on) }),
    });
    const change = await setMobilePullRequestBabysit(transport, {
      ...target,
      on: true,
      threadId,
      checks: "all",
    });
    expect(change).toMatchObject({ status: "applied", autoFix: { status: "on", threadId } });
    expect(sent.at(-1)).toEqual({
      path: "/api/code/project-pull-requests/auto-fix",
      body: {
        kind: "enable",
        target,
        threadId,
        babysit: { checks: "all" },
        expectedStoppedAt: stoppedAt,
      },
    });
  });

  it("says why the computer refused, and that a device without the right may not change it", async () => {
    const refused = host({
      "/api/code/project-pull-requests/auto-fix": () =>
        Response.json({ status: "refused", reason: "thread-not-linked" }),
    });
    expect(
      await setMobilePullRequestBabysit(refused.transport, { ...target, on: false, threadId }),
    ).toEqual({
      status: "refused",
      message: "That thread is no longer linked to this pull request.",
    });
    expect(refused.sent).toEqual([
      {
        path: "/api/code/project-pull-requests/auto-fix",
        body: { kind: "disable", target, threadId },
      },
    ]);
    const forbidden = host({
      "/api/code/project-pull-requests/auto-fix": () => new Response("", { status: 403 }),
    });
    expect(
      await setMobilePullRequestBabysit(forbidden.transport, { ...target, on: false }),
    ).toEqual({
      status: "refused",
      message: "This phone may not change Babysit for this pull request.",
    });
  });
});
