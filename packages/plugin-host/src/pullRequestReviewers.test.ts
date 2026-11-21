import { describe, expect, it } from "vitest";
import {
  decodePullRequestReviewerId,
  type PullRequestReviewer,
} from "@octant/plugin-api/pull-request-reviewer";
import { offerPullRequestReviewer, offeredPullRequestReviewers } from "./pullRequestReviewers";

const unused = async (): Promise<never> => {
  throw new Error("a withheld reviewer is never invoked");
};

const reviewer: PullRequestReviewer = {
  kind: "pull-request-reviewer",
  review: unused,
};

const ready = { installed: true, trusted: true, enabled: true };
const id = decodePullRequestReviewerId;

describe("pull request reviewers", () => {
  it("offers a pull request reviewer only once it is installed, trusted, and enabled", () => {
    expect(offerPullRequestReviewer(ready)).toEqual({ status: "offered" });
    expect(offerPullRequestReviewer({ ...ready, installed: false })).toEqual({
      status: "withheld",
      reason: "not-installed",
    });
    expect(offerPullRequestReviewer({ ...ready, trusted: false })).toEqual({
      status: "withheld",
      reason: "not-trusted",
    });
    expect(offerPullRequestReviewer({ ...ready, enabled: false })).toEqual({
      status: "withheld",
      reason: "disabled",
    });
  });

  it("omits a pull request reviewer from a disabled or untrusted plugin", () => {
    expect(
      offeredPullRequestReviewers([
        {
          reviewerId: id("example.review/disabled"),
          displayName: "Disabled",
          facts: { ...ready, enabled: false },
          reviewer,
        },
        {
          reviewerId: id("example.review/untrusted"),
          displayName: "Untrusted",
          facts: { ...ready, trusted: false },
          reviewer,
        },
      ]),
    ).toEqual([]);
  });

  it("withholds every pull request reviewer claiming a colliding id and sorts the rest deterministically", () => {
    const offered = offeredPullRequestReviewers([
      { reviewerId: id("z.plugin/review"), displayName: "Z", facts: ready, reviewer },
      { reviewerId: id("a.plugin/review"), displayName: "A1", facts: ready, reviewer },
      { reviewerId: id("a.plugin/review"), displayName: "A2", facts: ready, reviewer },
      { reviewerId: id("b.plugin/review"), displayName: "B", facts: ready, reviewer },
    ]);
    expect(offered.map((entry) => entry.reviewerId)).toEqual([
      "b.plugin/review",
      "z.plugin/review",
    ]);
  });

  it("refuses a contribution whose kind is not pull-request-reviewer", () => {
    expect(
      offeredPullRequestReviewers([
        {
          reviewerId: id("a.plugin/wrong-kind"),
          displayName: "Wrong kind",
          facts: ready,
          reviewer: { ...reviewer, kind: "cloud-machine-target" as never },
        },
      ]),
    ).toEqual([]);
  });
});
