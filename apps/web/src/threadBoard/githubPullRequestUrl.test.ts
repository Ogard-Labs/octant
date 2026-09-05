import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { githubPullRequestUrl } from "./githubPullRequestUrl";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

describe("githubPullRequestUrl", () => {
  it("builds the exact github.com address for a pull-request identity", () => {
    expect(
      githubPullRequestUrl({
        projectId,
        repositoryOwner: "octant",
        repositoryName: "octant.app",
        number: 12,
      }),
    ).toBe("https://github.com/octant/octant.app/pull/12");
  });

  it("refuses an identity that would not decode or would leave github.com", () => {
    const attempts = [
      { repositoryOwner: "user:secret@evil.example", repositoryName: "octant", number: 12 },
      { repositoryOwner: "octant", repositoryName: "octant/../../settings", number: 12 },
      { repositoryOwner: "octant", repositoryName: "octant?tab=x", number: 12 },
      { repositoryOwner: "octant", repositoryName: "octant", number: 0 },
      { repositoryOwner: "octant", repositoryName: "octant", number: 1.5 },
      { repositoryOwner: "", repositoryName: "octant", number: 12 },
    ];
    for (const attempt of attempts) {
      expect(githubPullRequestUrl({ projectId, ...attempt })).toBeUndefined();
    }
  });
});
