import { describe, expect, it, vi } from "vitest";
import {
  decodeUtcTimestamp,
  type GithubAuthenticationSnapshot,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { ActivityWindow } from "@octant/contracts/code-home-activity";
import type { GhHomeActivityResult, GhHomeActivityRow } from "../github/ghHomeActivityPort";
import { createCodeHomeForgeRead } from "./codeHomeForgeRead";

const windowId = "83000000-0000-4000-8000-0000000000aa" as WindowId;
const projectId = "83000000-0000-4000-8000-000000000004" as ProjectId;
const deniedProject = "83000000-0000-4000-8000-000000000005" as ProjectId;
const START_MS = 1_700_000_000_000;
const START_CHECKED_AT = new Date(START_MS).toISOString();

const current: ActivityWindow = {
  from: null,
  until: decodeUtcTimestamp("2026-08-21T00:00:00.000Z"),
};

const readySnapshot = (login = "henrik"): GithubAuthenticationSnapshot => ({
  state: "ready",
  account: { login, gitProtocol: "https", scopes: [] },
  capabilities: [
    { kind: "pull-requests-read", available: true },
    { kind: "issues-read", available: true },
    { kind: "repository-catalogue", available: true },
  ],
});

const mergedRow: GhHomeActivityRow = {
  kind: "prs-merged",
  number: 42,
  title: "Ship it",
  mergedAt: "2026-08-20T10:00:00Z",
  mergedBy: "henrik",
};
const closedRow: GhHomeActivityRow = {
  kind: "issues-closed",
  number: 11,
  title: "Real issue",
  closedAt: "2026-08-20T09:05:00Z",
  closedBy: "henrik",
};
const releaseRow: GhHomeActivityRow = {
  kind: "releases-published",
  releaseId: 77,
  tag: "v1.2.3",
  name: "One two three",
  url: "https://github.com/octant-dev/octant/releases/tag/v1.2.3",
  publishedAt: "2026-08-19T12:00:00Z",
  publishedBy: "henrik",
};

const repository = {
  projectId,
  repositoryOwner: "Octant-Dev",
  repositoryName: "Octant",
};

function fixture(options: {
  readonly snapshot?: GithubAuthenticationSnapshot | (() => GithubAuthenticationSnapshot);
  readonly effective?: boolean;
  readonly repositories?: ReadonlyArray<typeof repository>;
  readonly denied?: ReadonlySet<string>;
  readonly results?: ReadonlyArray<GhHomeActivityResult>;
}) {
  const queue = [...(options.results ?? [{ status: "ready", rows: [mergedRow] }])];
  const observe = vi.fn(
    async (_input: {
      readonly owner: string;
      readonly name: string;
      readonly card: "prs-merged" | "issues-closed" | "releases-published";
      readonly since: string | undefined;
      readonly until: string | undefined;
      readonly signal: AbortSignal;
    }): Promise<GhHomeActivityResult> =>
      queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: "ready", rows: [] }),
  );
  let nowMs = START_MS;
  const snapshotOf = options.snapshot;
  const ports = {
    capabilitySnapshot: vi.fn(async () =>
      typeof snapshotOf === "function" ? snapshotOf() : (snapshotOf ?? readySnapshot()),
    ),
    integrationEffective: () => options.effective ?? true,
    listRepositories: vi.fn(async () => options.repositories ?? [repository]),
    mayReadProject: (_id: WindowId, project: ProjectId) =>
      !(options.denied ?? new Set()).has(String(project)),
    port: { observe },
    now: () => nowMs,
  };
  const { forgeRead, forgeAccount } = createCodeHomeForgeRead(ports);
  return {
    forgeRead,
    forgeAccount,
    observe,
    ports,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const read = (
  forgeRead: ReturnType<typeof fixture>["forgeRead"],
  input: { readonly refresh?: boolean; readonly admission?: () => boolean } = {},
) =>
  forgeRead({
    windowId,
    card: "prs-merged",
    current,
    refresh: input.refresh ?? false,
    ...(input.admission === undefined ? {} : { admission: input.admission }),
  });

describe("createCodeHomeForgeRead", () => {
  it("refuses an insecure account as a labeled fallback without calling gh", async () => {
    const { forgeRead, observe } = fixture({
      snapshot: { state: "insecure-storage", capabilities: [] },
    });
    const result = await read(forgeRead);
    expect(result).toEqual({ status: "fallback", fallback: "insecure-github-storage" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("treats an external token as insecure storage, not a connection", async () => {
    const { forgeRead, observe } = fixture({
      snapshot: { state: "external-token", capabilities: [] },
    });
    expect(await read(forgeRead)).toEqual({
      status: "fallback",
      fallback: "insecure-github-storage",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("refuses a disconnected account as a labeled fallback", async () => {
    const { forgeRead, observe } = fixture({
      snapshot: { state: "unauthorized", capabilities: [] },
    });
    expect(await read(forgeRead)).toEqual({
      status: "fallback",
      fallback: "no-github-connection",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("reports an unobservable account as a read failure, not a fallback", async () => {
    const { forgeRead, observe } = fixture({
      snapshot: { state: "unavailable", capabilities: [] },
    });
    expect(await read(forgeRead)).toEqual({
      status: "unavailable",
      reason: "read-failed",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("refuses when the bundled integration is not effective, without observing credentials", async () => {
    const { forgeRead, observe, ports } = fixture({ effective: false });
    expect(await read(forgeRead)).toEqual({
      status: "unavailable",
      reason: "not-connected",
    });
    expect(observe).not.toHaveBeenCalled();
    expect(ports.capabilitySnapshot).not.toHaveBeenCalled();
  });

  it("reports a rate-limited capability snapshot honestly", async () => {
    const { forgeRead, observe } = fixture({
      snapshot: { ...readySnapshot(), state: "rate-limited" },
    });
    expect(await read(forgeRead)).toEqual({
      status: "unavailable",
      reason: "rate-limited",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("refuses when the pull-requests capability is not granted", async () => {
    const { forgeRead, observe } = fixture({
      snapshot: {
        state: "scope-limited",
        account: readySnapshot().account,
        capabilities: [{ kind: "pull-requests-read", available: false }],
      },
    });
    expect(await read(forgeRead)).toEqual({
      status: "unavailable",
      reason: "not-connected",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("returns normalized records witnessed per Project and skips denied Projects without fetching", async () => {
    const { forgeRead, observe } = fixture({
      repositories: [
        repository,
        { ...repository, projectId: deniedProject, repositoryName: "Other" },
      ],
      denied: new Set([String(deniedProject)]),
    });
    const result = await read(forgeRead);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.checkedAt).toBe(START_CHECKED_AT);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      projectId: String(projectId),
      repositoryKey: "octant-dev/octant",
      record: {
        kind: "prs-merged",
        id: "octant-dev/octant#42",
        mergedBy: "henrik",
      },
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(observe).mock.calls[0]![0]).toMatchObject({
      owner: "Octant-Dev",
      name: "Octant",
    });
  });

  it("counts only the signed-in person's own merges, never another actor's", async () => {
    const { forgeRead } = fixture({
      results: [
        {
          status: "ready",
          rows: [
            mergedRow,
            { ...mergedRow, number: 7, mergedBy: "teammate" },
            { ...mergedRow, number: 8, mergedBy: "HENRIK" },
          ],
        },
      ],
    });
    const result = await read(forgeRead);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.records.map((entry) => entry.record.id)).toEqual([
      "octant-dev/octant#42",
      "octant-dev/octant#8",
    ]);
  });

  it("counts only the signed-in person's own closures and releases", async () => {
    const { forgeRead } = fixture({
      results: [
        {
          status: "ready",
          rows: [closedRow, { ...closedRow, number: 12, closedBy: "teammate" }],
        },
      ],
    });
    const closed = await forgeRead({ windowId, card: "issues-closed", current, refresh: false });
    expect(closed.status).toBe("ready");
    if (closed.status !== "ready") return;
    expect(closed.records.map((entry) => entry.record.id)).toEqual(["octant-dev/octant#11"]);
  });

  it("identifies a release by its stable id and only counts the person's publish", async () => {
    const { forgeRead } = fixture({
      results: [
        {
          status: "partial",
          reason: "incomplete",
          rows: [releaseRow, { ...releaseRow, releaseId: 78, publishedBy: "teammate" }],
        },
      ],
    });
    const result = await forgeRead({
      windowId,
      card: "releases-published",
      current,
      refresh: false,
    });
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.record).toMatchObject({
      kind: "releases-published",
      id: "octant-dev/octant/releases/77",
      tag: "v1.2.3",
    });
  });

  it("drops a release whose link is not a canonical tag page for the repository", async () => {
    const { forgeRead } = fixture({
      results: [
        {
          status: "partial",
          reason: "incomplete",
          rows: [
            {
              ...releaseRow,
              url: "https://github.com/octant-dev/other/releases/tag/v1.2.3",
            },
            { ...releaseRow, releaseId: 78, url: "https://evil.example/x", tag: "v9" },
            {
              ...releaseRow,
              releaseId: 79,
              url: "https://user:pw@github.com/octant-dev/octant/releases/tag/v1",
            },
            {
              ...releaseRow,
              releaseId: 80,
              url: "https://github.com.evil.example/octant-dev/octant/releases/tag/v1",
            },
          ],
        },
      ],
    });
    const result = await forgeRead({
      windowId,
      card: "releases-published",
      current,
      refresh: false,
    });
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.records).toHaveLength(0);
  });

  it("serves the one-minute cache before refetching, and refresh bypasses it", async () => {
    const { forgeRead, observe, advance } = fixture({});
    const first = await read(forgeRead);
    const second = await read(forgeRead);
    expect(observe).toHaveBeenCalledTimes(1);
    if (first.status === "ready" && second.status === "ready") {
      expect(second.checkedAt).toBe(first.checkedAt);
    }
    advance(61_000);
    await read(forgeRead);
    expect(observe).toHaveBeenCalledTimes(2);
    await read(forgeRead, { refresh: true });
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it("serves the last good rows as partial with their original checkedAt on a refused refresh", async () => {
    const { forgeRead, observe } = fixture({
      results: [
        { status: "ready", rows: [mergedRow] },
        { status: "unavailable", reason: "read-failed" },
      ],
    });
    const first = await read(forgeRead);
    const stale = await read(forgeRead, { refresh: true });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(stale.status).toBe("partial");
    if (first.status !== "ready" || stale.status !== "partial") return;
    expect(stale.checkedAt).toBe(first.checkedAt);
    expect(stale.records).toHaveLength(1);
  });

  it("keeps one repository's rows when another fails, marked partial", async () => {
    const { forgeRead } = fixture({
      repositories: [repository, { ...repository, repositoryName: "Failing" }],
      results: [
        { status: "ready", rows: [mergedRow] },
        { status: "unavailable", reason: "rate-limited" },
      ],
    });
    const result = await read(forgeRead);
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.records).toHaveLength(1);
    expect(result.checkedAt).toBe(START_CHECKED_AT);
  });

  it("evicts cached history when the signed-in account changes", async () => {
    let snapshot = readySnapshot("henrik");
    const { observe } = fixture({});
    const ports = {
      capabilitySnapshot: vi.fn(async () => snapshot),
      integrationEffective: () => true,
      listRepositories: vi.fn(async () => [repository]),
      mayReadProject: () => true,
      port: { observe },
      now: () => START_MS,
    };
    const read2 = createCodeHomeForgeRead(ports).forgeRead;
    await read2({ windowId, card: "prs-merged", current, refresh: false });
    snapshot = readySnapshot("other-login");
    await read2({ windowId, card: "prs-merged", current, refresh: false });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("purges a missing repository's cache and never serves its former rows", async () => {
    const { forgeRead, observe } = fixture({
      results: [
        { status: "ready", rows: [mergedRow] },
        { status: "partial", rows: [], reason: "repository-missing" },
      ],
    });
    await read(forgeRead);
    const after = await read(forgeRead, { refresh: true });
    expect(observe).toHaveBeenCalledTimes(2);
    // A 404 repo is no coverage at all: with nothing else read the whole
    // answer stays unavailable rather than reusing the earlier rows.
    expect(after).toMatchObject({ status: "unavailable", reason: "read-failed" });
  });

  it("closes a past window's search at its end, ceiled to the second", async () => {
    const lastMonth: ActivityWindow = {
      from: decodeUtcTimestamp("2023-10-01T00:00:00.000Z"),
      until: decodeUtcTimestamp("2023-11-01T00:00:00.500Z"),
    };
    const { forgeRead, observe } = fixture({});
    await forgeRead({ windowId, card: "prs-merged", current: lastMonth, refresh: false });
    expect(vi.mocked(observe).mock.calls[0]?.[0]).toMatchObject({
      since: "2023-10-01T00:00:00.000Z",
      until: "2023-11-01T00:00:01.000Z",
    });
  });

  it("reads a window ending near now as open-ended so its cache stays shared", async () => {
    const thisWeek: ActivityWindow = {
      from: decodeUtcTimestamp("2023-11-13T00:00:00.000Z"),
      until: decodeUtcTimestamp("2023-11-14T22:12:20.000Z"),
    };
    const { forgeRead, observe } = fixture({});
    await forgeRead({ windowId, card: "prs-merged", current: thisWeek, refresh: false });
    expect(vi.mocked(observe).mock.calls[0]?.[0]).toMatchObject({
      since: "2023-11-13T00:00:00.000Z",
      until: undefined,
    });
  });

  it("closes the search at the later comparison end when it is the bound that matters", async () => {
    const lastMonth: ActivityWindow = {
      from: decodeUtcTimestamp("2023-10-01T00:00:00.000Z"),
      until: decodeUtcTimestamp("2023-11-01T00:00:00.000Z"),
    };
    const monthBefore: ActivityWindow = {
      from: decodeUtcTimestamp("2023-09-01T00:00:00.000Z"),
      until: decodeUtcTimestamp("2023-10-01T00:00:00.000Z"),
    };
    const { forgeRead, observe } = fixture({});
    await forgeRead({
      windowId,
      card: "issues-closed",
      current: lastMonth,
      comparison: monthBefore,
      refresh: false,
    });
    expect(vi.mocked(observe).mock.calls[0]?.[0]).toMatchObject({
      since: "2023-09-01T00:00:00.000Z",
      until: "2023-11-01T00:00:00.000Z",
    });
  });

  it("does not share cache entries between reads with different upper bounds", async () => {
    const weekA: ActivityWindow = {
      from: decodeUtcTimestamp("2023-10-25T00:00:00.000Z"),
      until: decodeUtcTimestamp("2023-11-01T00:00:00.000Z"),
    };
    const weekB: ActivityWindow = {
      from: decodeUtcTimestamp("2023-10-25T00:00:00.000Z"),
      until: decodeUtcTimestamp("2023-11-05T00:00:00.000Z"),
    };
    const { forgeRead, observe } = fixture({});
    await forgeRead({ windowId, card: "prs-merged", current: weekA, refresh: false });
    await forgeRead({ windowId, card: "prs-merged", current: weekB, refresh: false });
    expect(observe).toHaveBeenCalledTimes(2);
    await forgeRead({ windowId, card: "prs-merged", current: weekA, refresh: false });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("purges a missing repository's rows under every timeframe, not just the refreshed one", async () => {
    const weekA: ActivityWindow = {
      from: decodeUtcTimestamp("2026-08-04T00:00:00.000Z"),
      until: decodeUtcTimestamp("2026-08-11T00:00:00.000Z"),
    };
    const weekB: ActivityWindow = {
      from: decodeUtcTimestamp("2026-08-11T00:00:00.000Z"),
      until: decodeUtcTimestamp("2026-08-18T00:00:00.000Z"),
    };
    const newerRow: GhHomeActivityRow = { ...mergedRow, number: 55 };
    const { forgeRead, observe } = fixture({
      results: [
        { status: "ready", rows: [mergedRow] },
        { status: "ready", rows: [mergedRow] },
        { status: "partial", rows: [], reason: "repository-missing" },
        { status: "ready", rows: [newerRow] },
      ],
    });
    // Two windows cache under two different `since` keys.
    await forgeRead({ windowId, card: "prs-merged", current: weekA, refresh: false });
    await forgeRead({ windowId, card: "prs-merged", current: weekB, refresh: false });
    expect(observe).toHaveBeenCalledTimes(2);
    // Losing access on week B's refresh must not let week A serve its old rows.
    const lost = await forgeRead({
      windowId,
      card: "prs-merged",
      current: weekB,
      refresh: true,
    });
    expect(lost).toMatchObject({ status: "unavailable" });
    const again = await forgeRead({
      windowId,
      card: "prs-merged",
      current: weekA,
      refresh: true,
    });
    expect(observe).toHaveBeenCalledTimes(4);
    if (again.status !== "ready") throw new Error(`expected a ready read, got ${again.status}`);
    expect(again.records[0]?.record).toMatchObject({ number: 55 });
  });

  it("marks the read partial when a repository answer was truncated", async () => {
    const { forgeRead } = fixture({
      results: [{ status: "partial", rows: [mergedRow], reason: "incomplete" }],
    });
    const result = await read(forgeRead);
    expect(result.status).toBe("partial");
  });

  it("refuses when the window has no connected repositories to read", async () => {
    const { forgeRead, observe } = fixture({ repositories: [] });
    expect(await read(forgeRead)).toEqual({
      status: "unavailable",
      reason: "not-connected",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("stops between repositories the moment admission is lost", async () => {
    const { forgeRead, observe } = fixture({
      repositories: [repository, { ...repository, repositoryName: "Second" }],
      results: [
        { status: "ready", rows: [mergedRow] },
        { status: "ready", rows: [mergedRow] },
      ],
    });
    let admitted = true;
    const result = await read(forgeRead, {
      admission: () => {
        const was = admitted;
        admitted = false;
        return was;
      },
    });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("answers the normalized account only while the connection holds", async () => {
    const { forgeAccount } = fixture({});
    expect(await forgeAccount("prs-merged")).toBe("henrik");
  });

  it("answers no account when the integration or capability gate is not effective", async () => {
    const off = fixture({ effective: false });
    expect(await off.forgeAccount("prs-merged")).toBeUndefined();
    expect(off.ports.capabilitySnapshot).not.toHaveBeenCalled();
    const denied = fixture({
      snapshot: {
        state: "scope-limited",
        account: readySnapshot().account,
        capabilities: [{ kind: "pull-requests-read", available: false }],
      },
    });
    expect(await denied.forgeAccount("prs-merged")).toBeUndefined();
  });

  it("gates each card on its own catalogue capability", async () => {
    const limited = {
      state: "scope-limited" as const,
      account: readySnapshot().account,
      capabilities: [
        { kind: "issues-read" as const, available: true },
        { kind: "pull-requests-read" as const, available: false },
      ],
    };
    const { forgeRead, observe } = fixture({ snapshot: limited });
    const issues = await forgeRead({
      windowId,
      card: "issues-closed",
      current,
      refresh: false,
    });
    expect(issues.status).not.toBe("unavailable");
    expect(observe).toHaveBeenCalledTimes(1);

    const merged = await forgeRead({
      windowId,
      card: "prs-merged",
      current,
      refresh: false,
    });
    expect(merged).toMatchObject({ status: "unavailable", reason: "not-connected" });
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
