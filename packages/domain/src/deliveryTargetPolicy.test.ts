import { describe, expect, it } from "vitest";
import {
  CODE_DELIVERY_OUTCOME_ORDER,
  classifyCodeDeliveryOutcomeProposal,
  codeDeliveryOutcomeRank,
  evaluateCodeDeliveryOutcomeProposal,
  evaluateCodeDeliverySatisfaction,
  suggestCodeDeliveryOutcome,
  type DeliveryTargetEvidence,
} from "./deliveryTargetPolicy";
import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";

describe("suggestCodeDeliveryOutcome", () => {
  it("suggests an investigation result for research/diagnosis prompts", () => {
    for (const prompt of [
      "Investigate why the nightly build fails",
      "Research caching options for the API",
      "Analyze the slow query and explain the root cause",
      "Figure out how the scheduler works",
    ]) {
      expect(suggestCodeDeliveryOutcome(prompt)).toBe("investigation-result");
    }
  });

  it("suggests an opened PR when the prompt asks to open/submit a pull request", () => {
    for (const prompt of [
      "Open a PR for the refactor",
      "Submit a pull request that adds tests",
      "Raise a pull request for the fix",
    ]) {
      expect(suggestCodeDeliveryOutcome(prompt)).toBe("opened-pr");
    }
  });

  it("suggests a merged PR when the prompt asks to merge", () => {
    for (const prompt of [
      "Merge the release PR",
      "Get this change merged into development",
      "Open a PR and merge it once CI is green",
    ]) {
      expect(suggestCodeDeliveryOutcome(prompt)).toBe("merged-pr");
    }
  });

  it("defaults to a local implementation for ordinary coding prompts and empty prompts", () => {
    for (const prompt of ["Fix the null pointer bug", "Implement the login form", "", "   "]) {
      expect(suggestCodeDeliveryOutcome(prompt)).toBe("local-implementation");
    }
  });
});

describe("code delivery outcome ordering and proposals", () => {
  it("orders outcomes from least to most ambitious", () => {
    expect(CODE_DELIVERY_OUTCOME_ORDER).toEqual([
      "investigation-result",
      "local-implementation",
      "opened-pr",
      "merged-pr",
    ]);
    expect(codeDeliveryOutcomeRank("investigation-result")).toBeLessThan(
      codeDeliveryOutcomeRank("local-implementation"),
    );
    expect(codeDeliveryOutcomeRank("opened-pr")).toBeLessThan(codeDeliveryOutcomeRank("merged-pr"));
  });

  it("classifies a proposal relative to the confirmed outcome", () => {
    expect(classifyCodeDeliveryOutcomeProposal("opened-pr", "opened-pr")).toBe("unchanged");
    expect(classifyCodeDeliveryOutcomeProposal("local-implementation", "merged-pr")).toBe("raise");
    expect(classifyCodeDeliveryOutcomeProposal("merged-pr", "investigation-result")).toBe("lower");
  });

  it("never lets an agent proposal redefine or lower the outcome without user confirmation", () => {
    // A raise still requires explicit user confirmation and is never auto-applied.
    const raise = evaluateCodeDeliveryOutcomeProposal("local-implementation", "opened-pr");
    expect(raise.admissible).toBe(true);
    expect(raise.direction).toBe("raise");
    expect(raise.requiresUserConfirmation).toBe(true);

    // A lower/redefine likewise requires user confirmation; it is never applied by the agent.
    const lower = evaluateCodeDeliveryOutcomeProposal("merged-pr", "investigation-result");
    expect(lower.admissible).toBe(true);
    expect(lower.direction).toBe("lower");
    expect(lower.requiresUserConfirmation).toBe(true);

    // A no-op proposal is inadmissible: there is nothing to confirm.
    const unchanged = evaluateCodeDeliveryOutcomeProposal("opened-pr", "opened-pr");
    expect(unchanged.admissible).toBe(false);
    expect(unchanged.direction).toBe("unchanged");
  });
});

const fresh = "fresh" as const;
const stale = "stale" as const;

describe("evaluateCodeDeliverySatisfaction — investigation result", () => {
  const kind: CodeDeliveryOutcomeKind = "investigation-result";

  it("is done once a fresh investigation result has been delivered", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        investigation: { resultDelivered: true, freshness: fresh },
      }),
    ).toBe("done");
  });

  it("is pending before a result is delivered", () => {
    expect(evaluateCodeDeliverySatisfaction(kind, {})).toBe("pending");
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        investigation: { resultDelivered: false, freshness: fresh },
      }),
    ).toBe("pending");
  });

  it("is waiting, never done, when the result evidence is stale", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        investigation: { resultDelivered: true, freshness: stale },
      }),
    ).toBe("waiting");
  });
});

describe("evaluateCodeDeliverySatisfaction — local implementation", () => {
  const kind: CodeDeliveryOutcomeKind = "local-implementation";

  it("is done when committed work is ahead of base and the working tree is clean", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        localChanges: { committedAhead: 3, workingTreeClean: true, freshness: fresh },
      }),
    ).toBe("done");
  });

  it("is pending with no committed work", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        localChanges: { committedAhead: 0, workingTreeClean: true, freshness: fresh },
      }),
    ).toBe("pending");
  });

  it("is waiting (ambiguous) with uncommitted working-tree changes", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        localChanges: { committedAhead: 2, workingTreeClean: false, freshness: fresh },
      }),
    ).toBe("waiting");
  });

  it("is waiting, never done, when local change evidence is stale", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        localChanges: { committedAhead: 2, workingTreeClean: true, freshness: stale },
      }),
    ).toBe("waiting");
  });
});

describe("evaluateCodeDeliverySatisfaction — opened PR", () => {
  const kind: CodeDeliveryOutcomeKind = "opened-pr";

  it("is done when a fresh matching PR is open or merged", () => {
    for (const presence of ["open", "merged"] as const) {
      expect(
        evaluateCodeDeliverySatisfaction(kind, {
          pullRequest: { presence, matchesDeliveryBranch: true, freshness: fresh },
        }),
      ).toBe("done");
    }
  });

  it("is pending when no PR exists", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "none", matchesDeliveryBranch: false, freshness: fresh },
      }),
    ).toBe("pending");
  });

  it("is waiting when a PR was closed without merging", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "closed", matchesDeliveryBranch: true, freshness: fresh },
      }),
    ).toBe("waiting");
  });

  it("is waiting when the PR does not match the delivery branch (ambiguous)", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "open", matchesDeliveryBranch: false, freshness: fresh },
      }),
    ).toBe("waiting");
  });

  it("is waiting, never done, when the PR metadata is stale", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "open", matchesDeliveryBranch: true, freshness: stale },
      }),
    ).toBe("waiting");
  });
});

describe("evaluateCodeDeliverySatisfaction — merged PR", () => {
  const kind: CodeDeliveryOutcomeKind = "merged-pr";

  it("is done only when a fresh matching PR is merged", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "merged", matchesDeliveryBranch: true, freshness: fresh },
      }),
    ).toBe("done");
  });

  it("is pending when the PR is open but not yet merged", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "open", matchesDeliveryBranch: true, freshness: fresh },
      }),
    ).toBe("pending");
  });

  it("is waiting when the PR was closed without merging", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "closed", matchesDeliveryBranch: true, freshness: fresh },
      }),
    ).toBe("waiting");
  });

  it("is waiting, never done, when merge metadata is stale", () => {
    expect(
      evaluateCodeDeliverySatisfaction(kind, {
        pullRequest: { presence: "merged", matchesDeliveryBranch: true, freshness: stale },
      }),
    ).toBe("waiting");
  });
});

describe("evaluateCodeDeliverySatisfaction — child-agent outcomes", () => {
  const satisfied: DeliveryTargetEvidence = {
    pullRequest: { presence: "merged", matchesDeliveryBranch: true, freshness: fresh },
  };

  it("downgrades an otherwise-done target to waiting while a child agent is still active", () => {
    expect(
      evaluateCodeDeliverySatisfaction("merged-pr", {
        ...satisfied,
        childAgents: { active: 1, unacknowledgedResults: 0 },
      }),
    ).toBe("waiting");
  });

  it("downgrades to waiting while a child agent result is unacknowledged (ambiguous)", () => {
    expect(
      evaluateCodeDeliverySatisfaction("merged-pr", {
        ...satisfied,
        childAgents: { active: 0, unacknowledgedResults: 1 },
      }),
    ).toBe("waiting");
  });

  it("stays done when all child agents are terminal and acknowledged", () => {
    expect(
      evaluateCodeDeliverySatisfaction("merged-pr", {
        ...satisfied,
        childAgents: { active: 0, unacknowledgedResults: 0 },
      }),
    ).toBe("done");
  });
});
