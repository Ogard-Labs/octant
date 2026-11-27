import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createTrackerMentionSearch,
  type TrackerMentionSearchSources,
} from "./trackerMentionSearch";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000911");
const projectId = "00000000-0000-4000-8000-000000000912";
const otherProjectId = "00000000-0000-4000-8000-000000000913";

const pullRow = {
  kind: "pull-request" as const,
  number: 2901,
  title: "Fix login",
  state: "draft" as const,
  author: "dana",
  updatedAt: "2026-11-27T10:00:00Z",
  url: "https://github.com/acme/app/pull/2901",
};
const linearRow = {
  id: "issue-node-1",
  identifier: "OCT-1042",
  title: "Mention things",
  state: { name: "In Progress", type: "started" },
  teamKey: "OCT",
  assignee: "Sam",
  url: "https://linear.app/acme/issue/OCT-1042/mention-things",
};

function sources(overrides: Partial<TrackerMentionSearchSources> = {}) {
  const github = {
    connected: vi.fn(() => true),
    search: vi.fn(async () => [pullRow]),
    item: vi.fn(async () => pullRow),
  };
  const linear = {
    connected: vi.fn(() => true),
    list: vi.fn(async () => [linearRow]),
  };
  const all: TrackerMentionSearchSources = {
    threadProject: vi.fn(async () => ({ projectId })),
    windowProject: vi.fn(async (_window, id) =>
      String(id) === projectId
        ? { repository: { owner: "acme", name: "app" }, linearTeamId: "team-1" }
        : undefined,
    ),
    github,
    linear,
    ...overrides,
  };
  return { all, github, linear, search: createTrackerMentionSearch(all) };
}

describe("searching pull requests and issues for the # list", () => {
  it("offers the Project's pull request for its number, and asks Linear for nothing", async () => {
    const { search, github, linear } = sources();

    await expect(
      search({ query: "#2901", readerThreadId: "thread-1" as never }, { windowId }),
    ).resolves.toEqual([
      {
        kind: "pull-request",
        source: "github",
        id: "2901",
        url: pullRow.url,
        title: "Fix login",
        state: "draft",
        container: "acme/app",
        person: "dana",
      },
    ]);
    expect(github.item).toHaveBeenCalledWith(
      { owner: "acme", name: "app", number: 2901 },
      expect.any(AbortSignal),
    );
    expect(linear.list).not.toHaveBeenCalled();
  });

  it("offers the Linear issue a key names, from the Project's mapped team only", async () => {
    const { search, github, linear } = sources();
    linear.list.mockResolvedValue([{ ...linearRow, identifier: "OCT-10420" }, linearRow]);

    const found = await search(
      { query: "oct-1042", projectId: decodeProjectId(projectId) },
      { windowId },
    );

    expect(found.map((item) => [item.kind, item.id, item.state, item.container])).toEqual([
      ["linear-issue", "OCT-1042", "In Progress", "OCT"],
    ]);
    expect(linear.list).toHaveBeenCalledWith(
      { search: "OCT-1042", teamId: "team-1" },
      expect.any(AbortSignal),
    );
    expect(github.search).not.toHaveBeenCalled();
    expect(github.item).not.toHaveBeenCalled();
  });

  it("matches title words on both trackers and searches every team when none is mapped", async () => {
    const { search, linear, github } = sources({
      windowProject: async () => ({ repository: { owner: "acme", name: "app" } }),
    });

    const found = await search(
      { query: "login", readerThreadId: "thread-1" as never },
      { windowId },
    );

    expect(found.map((item) => item.id)).toEqual(["2901", "OCT-1042"]);
    expect(github.search).toHaveBeenCalledWith(
      { owner: "acme", name: "app", text: "login" },
      expect.any(AbortSignal),
    );
    expect(linear.list).toHaveBeenCalledWith({ search: "login" }, expect.any(AbortSignal));
  });

  it("offers nothing and calls no tracker without a connection", async () => {
    const { search, github, linear } = sources();
    github.connected.mockReturnValue(false);
    linear.connected.mockReturnValue(false);

    for (const query of ["2901", "OCT-1042", "login"]) {
      await expect(
        search({ query, readerThreadId: "thread-1" as never }, { windowId }),
      ).resolves.toEqual([]);
    }
    expect(github.search).not.toHaveBeenCalled();
    expect(github.item).not.toHaveBeenCalled();
    expect(linear.list).not.toHaveBeenCalled();
  });

  it("offers nothing for a thread the window cannot open", async () => {
    const { search, github, linear } = sources({ threadProject: async () => undefined });

    await expect(
      search({ query: "login", readerThreadId: "thread-1" as never }, { windowId }),
    ).resolves.toEqual([]);
    expect(github.search).not.toHaveBeenCalled();
    expect(linear.list).not.toHaveBeenCalled();
  });

  it("offers nothing for a Project the window does not hold, whatever else it names", async () => {
    const { search, github, linear } = sources();

    await expect(
      search({ query: "login", projectId: decodeProjectId(otherProjectId) }, { windowId }),
    ).resolves.toEqual([]);
    expect(github.search).not.toHaveBeenCalled();
    expect(linear.list).not.toHaveBeenCalled();
  });

  it("asks only Linear for a composer with no Project", async () => {
    const { search, github, linear } = sources({ threadProject: async () => ({}) });

    const found = await search(
      { query: "mention", readerThreadId: "thread-1" as never },
      { windowId },
    );

    expect(found.map((item) => item.id)).toEqual(["OCT-1042"]);
    expect(github.search).not.toHaveBeenCalled();
    expect(linear.list).toHaveBeenCalledWith({ search: "mention" }, expect.any(AbortSignal));
  });

  it("keeps what one tracker answered when the other fails, and drops a row it cannot show", async () => {
    const { search, github } = sources();
    github.search.mockRejectedValue(new Error("rate limited"));

    const found = await search(
      { query: "login", readerThreadId: "thread-1" as never },
      { windowId },
    );

    expect(found.map((item) => item.id)).toEqual(["OCT-1042"]);
  });

  it("asks no tracker for a bare # or a single letter", async () => {
    const { search, all, github, linear } = sources();

    for (const query of ["", "a"]) {
      await expect(
        search({ query, readerThreadId: "thread-1" as never }, { windowId }),
      ).resolves.toEqual([]);
    }
    expect(all.threadProject).not.toHaveBeenCalled();
    expect(github.search).not.toHaveBeenCalled();
    expect(linear.list).not.toHaveBeenCalled();
  });
});
