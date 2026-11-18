import { describe, expect, it } from "vitest";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "../ui/icons";
import { pullRequestRowStateMark, pullRequestStateMark } from "./pullRequestState";

describe("pull request state mark", () => {
  it("gives each state its own glyph, words and colour role", () => {
    expect(pullRequestStateMark("open")).toEqual({
      label: "Open",
      tone: "open",
      Icon: GitPullRequest,
    });
    expect(pullRequestStateMark("merged")).toEqual({
      label: "Merged",
      tone: "merged",
      Icon: GitMerge,
    });
    expect(pullRequestStateMark("closed")).toEqual({
      label: "Closed",
      tone: "closed",
      Icon: GitPullRequestClosed,
    });
    expect(pullRequestStateMark("draft")).toEqual({
      label: "Draft",
      tone: "draft",
      Icon: GitPullRequestDraft,
    });
  });

  it("reads a draft row as a draft only while it is open", () => {
    expect(pullRequestRowStateMark({ state: "open", draft: true }).tone).toBe("draft");
    expect(pullRequestRowStateMark({ state: "merged", draft: true }).tone).toBe("merged");
    expect(pullRequestRowStateMark({ state: "closed", draft: false }).tone).toBe("closed");
  });
});
