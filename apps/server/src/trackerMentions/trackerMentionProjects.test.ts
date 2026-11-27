import { decodeWindowId, type ProjectBootstrap } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTrackerMentionProjects } from "./trackerMentionProjects";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000921");
const remote = (url: string) => ({ name: "origin", fetchUrl: url, pushUrl: url });

function projects(active: ReadonlyArray<object>) {
  return {
    bootstrap: async () => ({ active, archived: [] }) as unknown as ProjectBootstrap,
  };
}

describe("where a composer's Project keeps its pull requests and issues", () => {
  it("names a Code Project's observed repository and its mapped Linear team", async () => {
    const find = createTrackerMentionProjects({
      projects: projects([
        {
          id: "code",
          type: "code",
          connectedRepository: { host: "github.com", owner: "acme", repository: "app" },
          linearTarget: { teamId: "team-1" },
        },
      ]),
      remotes: vi.fn(),
    });

    await expect(find(windowId, "code")).resolves.toEqual({
      repository: { owner: "acme", name: "app" },
      linearTeamId: "team-1",
    });
  });

  it("reads a Work Project's folder once a minute and names no repository for an ambiguous one", async () => {
    let clock = 0;
    const remotes = vi.fn(async () => [remote("git@github.com:acme/notes.git")]);
    const find = createTrackerMentionProjects({
      projects: projects([{ id: "work", type: "work", binding: { canonicalRoot: "/notes" } }]),
      remotes,
      now: () => clock,
    });

    await expect(find(windowId, "work")).resolves.toEqual({
      repository: { owner: "acme", name: "notes" },
    });
    await find(windowId, "work");
    expect(remotes).toHaveBeenCalledTimes(1);
    clock = 61_000;
    remotes.mockResolvedValue([
      remote("git@github.com:acme/notes.git"),
      remote("git@github.com:other/notes.git"),
    ]);
    await expect(find(windowId, "work")).resolves.toEqual({});
  });

  it("answers nothing for a Project the window does not hold", async () => {
    const find = createTrackerMentionProjects({ projects: projects([]), remotes: vi.fn() });

    await expect(find(windowId, "elsewhere")).resolves.toBeUndefined();
  });
});
