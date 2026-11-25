import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  derivePullRequestStacks,
  keepStacksTogether,
  pullRequestStackPlaces,
  type StackablePullRequest,
} from "./pullRequestStackPolicy";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

function pull(
  number: number,
  headBranch: string,
  baseBranch: string,
  overrides: Partial<StackablePullRequest> = {},
): StackablePullRequest {
  return {
    projectId,
    repositoryOwner: "octant",
    repositoryName: "octant",
    number,
    state: "open",
    headBranch,
    baseBranch,
    ...overrides,
  };
}

const numbers = (stacks: ReadonlyArray<ReadonlyArray<StackablePullRequest>>) =>
  stacks.map((stack) => stack.map((layer) => layer.number));

describe("pull-request stacks", () => {
  it("reads open pull requests that build on each other as one stack, bottom first", () => {
    expect(
      numbers(
        derivePullRequestStacks([
          pull(4, "d", "c"),
          pull(2, "b", "a"),
          pull(9, "alone", "main"),
          pull(3, "c", "b"),
          pull(1, "a", "main"),
        ]),
      ),
    ).toEqual([[1, 2, 3, 4]]);
  });

  it("starts the stack above a layer that has merged", () => {
    const rows = [
      pull(1, "a", "main", { state: "merged" }),
      pull(2, "b", "main"),
      pull(3, "c", "b"),
      pull(4, "d", "c", { state: "closed" }),
      pull(5, "e", "d", { state: "unknown" }),
    ];
    expect(numbers(derivePullRequestStacks(rows))).toEqual([[2, 3]]);
  });

  it("never stacks across repositories or Projects", () => {
    expect(
      derivePullRequestStacks([
        pull(1, "a", "main"),
        pull(2, "b", "a", { repositoryName: "site" }),
        pull(3, "c", "a", {
          projectId: decodeProjectId("10000000-0000-4000-8000-000000000002"),
        }),
      ]),
    ).toEqual([]);
  });

  it("reads one repository written in two cases as one repository", () => {
    expect(
      numbers(
        derivePullRequestStacks([
          pull(1, "a", "main"),
          pull(2, "b", "a", { repositoryOwner: "Octant" }),
        ]),
      ),
    ).toEqual([[1, 2]]);
  });

  it("leaves a fork's pull request out, whose head names a branch of another repository", () => {
    expect(
      derivePullRequestStacks([
        pull(1, "a", "main", { crossRepository: true }),
        pull(2, "b", "a"),
        pull(3, "c", "b", { crossRepository: true }),
      ]),
    ).toEqual([]);
  });

  it("is no stack where two pull requests are based on one, as on a long-lived branch", () => {
    expect(
      derivePullRequestStacks([
        pull(1, "development", "main"),
        pull(2, "feature-a", "development"),
        pull(3, "feature-b", "development"),
      ]),
    ).toEqual([]);
  });

  it("counts only open pull requests of the repository itself when a layer has one child", () => {
    expect(
      numbers(
        derivePullRequestStacks([
          pull(1, "a", "main"),
          pull(2, "b", "a"),
          pull(3, "old", "a", { state: "closed" }),
          pull(4, "fork", "a", { crossRepository: true }),
        ]),
      ),
    ).toEqual([[1, 2]]);
  });

  it("is no stack where two pull requests share the head branch", () => {
    expect(
      derivePullRequestStacks([pull(1, "a", "main"), pull(2, "a", "release"), pull(3, "b", "a")]),
    ).toEqual([]);
  });

  it("leaves out an upper layer whose head another pull request shares", () => {
    expect(
      derivePullRequestStacks([pull(1, "a", "main"), pull(2, "b", "a"), pull(3, "b", "release")]),
    ).toEqual([]);
  });

  it("leaves out an upper layer that several pull requests are based on", () => {
    expect(
      numbers(
        derivePullRequestStacks([
          pull(1, "a", "main"),
          pull(2, "b", "a"),
          pull(3, "c", "b"),
          pull(4, "d", "c"),
          pull(5, "e", "c"),
        ]),
      ),
    ).toEqual([[1, 2]]);
  });

  it("is no stack where the branches go round in a circle", () => {
    expect(
      derivePullRequestStacks([pull(1, "a", "b"), pull(2, "b", "a"), pull(3, "c", "c")]),
    ).toEqual([]);
  });

  it("says each layer's place and the layer below it", () => {
    const rows = [pull(1, "a", "main"), pull(2, "b", "a"), pull(3, "c", "b"), pull(9, "x", "main")];
    const places = pullRequestStackPlaces(derivePullRequestStacks(rows));
    expect(rows.map((row) => places.get(row))).toEqual([
      { position: 1, size: 3 },
      { position: 2, size: 3, parent: 1 },
      { position: 3, size: 3, parent: 2 },
      undefined,
    ]);
  });

  it("keeps the shown layers of a stack together, bottom first, where the first of them stood", () => {
    const top = pull(3, "c", "b");
    const bottom = pull(1, "a", "main");
    const middle = pull(2, "b", "a");
    const alone = pull(9, "x", "main");
    const other = pull(8, "y", "main");
    const all = [bottom, middle, top, alone, other];
    const order = (rows: ReadonlyArray<StackablePullRequest>) =>
      keepStacksTogether(rows, derivePullRequestStacks(all)).map((row) => row.number);

    expect(order([other, top, alone, bottom, middle])).toEqual([8, 1, 2, 3, 9]);
    // A filter hid the middle layer: the two that are left stay together.
    expect(order([top, alone, bottom])).toEqual([1, 3, 9]);
    expect(order([alone, other])).toEqual([9, 8]);
  });
});
