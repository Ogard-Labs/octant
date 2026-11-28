import { describe, expect, it } from "vitest";
import {
  PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
  type PullRequestGuideWriter,
} from "@octant/plugin-api/pull-request-guide-writer";
import {
  offerPullRequestGuideWriter,
  offeredPullRequestGuideWriters,
} from "./pullRequestGuideWriters";

const writer: PullRequestGuideWriter = {
  kind: PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
  write: async () => ({ status: "written", stops: [] }),
};

describe("pull request guide writer activation", () => {
  it("keeps installation, trust, and enablement as separate preconditions", () => {
    expect(offerPullRequestGuideWriter({ installed: false, trusted: true, enabled: true })).toEqual(
      { status: "withheld", reason: "not-installed" },
    );
    expect(offerPullRequestGuideWriter({ installed: true, trusted: false, enabled: true })).toEqual(
      { status: "withheld", reason: "not-trusted" },
    );
    expect(offerPullRequestGuideWriter({ installed: true, trusted: true, enabled: false })).toEqual(
      { status: "withheld", reason: "disabled" },
    );
    expect(offerPullRequestGuideWriter({ installed: true, trusted: true, enabled: true })).toEqual({
      status: "offered",
    });
  });

  it("offers only installed, trusted, enabled, non-colliding guide writers in id order", () => {
    const offered = offeredPullRequestGuideWriters([
      {
        writerId: "octant/bundled-pull-request-guide-writer",
        displayName: "Bundled writer",
        facts: { installed: true, trusted: true, enabled: true },
        writer,
      },
      {
        writerId: "acme/custom-guide-writer",
        displayName: "Custom writer",
        facts: { installed: true, trusted: true, enabled: true },
        writer,
      },
      {
        writerId: "acme/discovered-only",
        displayName: "Discovered only",
        facts: { installed: true, trusted: false, enabled: true },
        writer,
      },
      {
        writerId: "acme/colliding",
        displayName: "Collider A",
        facts: { installed: true, trusted: true, enabled: true },
        writer,
      },
      {
        writerId: "acme/colliding",
        displayName: "Collider B",
        facts: { installed: true, trusted: true, enabled: true },
        writer,
      },
    ]);
    expect(offered.map((entry) => entry.writerId)).toEqual([
      "acme/custom-guide-writer",
      "octant/bundled-pull-request-guide-writer",
    ]);
  });

  it("refuses a contribution whose kind is not pull-request-guide-writer", () => {
    const wrongKind = {
      ...writer,
      kind: "pull-request-reviewer",
    } as unknown as PullRequestGuideWriter;
    expect(
      offeredPullRequestGuideWriters([
        {
          writerId: "acme/wrong-kind",
          displayName: "Wrong kind",
          facts: { installed: true, trusted: true, enabled: true },
          writer: wrongKind,
        },
      ]),
    ).toEqual([]);
  });
});
