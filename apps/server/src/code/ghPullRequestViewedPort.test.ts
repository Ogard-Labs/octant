import { describe, expect, it } from "vitest";
import type { GhCommandPort } from "./ghPullRequestPort";
import { GhPullRequestViewedPort } from "./ghPullRequestViewedPort";

/** A stand-in for GitHub that keeps each file's viewerViewedState between calls. */
function fakeGitHub(initial: Record<string, "VIEWED" | "UNVIEWED" | "DISMISSED">) {
  const states = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const field = (args: readonly string[], name: string) =>
    args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const command: GhCommandPort = {
    run: async (args) => {
      calls.push([...args]);
      const query = field(args, "query") ?? "";
      if (query.startsWith("mutation")) {
        const path = field(args, "path") ?? "";
        if (field(args, "id") !== "PR_node42") return { exitCode: 1, stdout: "" };
        states.set(path, query.includes("unmarkFileAsViewed") ? "UNVIEWED" : "VIEWED");
        return { exitCode: 0, stdout: "{}" };
      }
      if (args.includes("--jq")) return { exitCode: 0, stdout: "PR_node42\n" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_node42",
                files: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [...states].map(([path, viewerViewedState]) => ({
                    path,
                    viewerViewedState,
                  })),
                },
              },
            },
          },
        }),
      };
    },
  };
  return { command, calls };
}

const PULL_REQUEST = { owner: "ogard-labs", name: "octant", number: 42 };

describe("Viewed files on GitHub", () => {
  it("Viewed survives a reload, and a file GitHub dismissed shows Changed", async () => {
    const github = fakeGitHub({
      "src/auth.ts": "UNVIEWED",
      "src/session.ts": "DISMISSED",
    });
    const signal = new AbortController().signal;
    const marked = await new GhPullRequestViewedPort({ command: github.command }).write(
      { ...PULL_REQUEST, path: "src/auth.ts", viewed: true },
      signal,
    );
    expect(marked).toEqual({ status: "done" });

    // A new port holds nothing of its own: what it reads is GitHub's state.
    const reloaded = await new GhPullRequestViewedPort({ command: github.command }).read(
      PULL_REQUEST,
      signal,
    );
    expect(reloaded).toEqual({
      status: "read",
      files: [
        { path: "src/auth.ts", state: "viewed" },
        { path: "src/session.ts", state: "changed" },
      ],
    });
  });

  it("unmarks a file with GitHub's own mutation", async () => {
    const github = fakeGitHub({ "src/auth.ts": "VIEWED" });
    const port = new GhPullRequestViewedPort({ command: github.command });
    const signal = new AbortController().signal;
    await port.write({ ...PULL_REQUEST, path: "src/auth.ts", viewed: false }, signal);
    expect(github.calls.at(-1)?.some((arg) => arg.includes("unmarkFileAsViewed"))).toBe(true);
    expect(await port.read(PULL_REQUEST, signal)).toEqual({
      status: "read",
      files: [{ path: "src/auth.ts", state: "unviewed" }],
    });
  });
});
