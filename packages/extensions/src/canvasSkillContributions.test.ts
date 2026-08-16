import { describe, expect, it } from "vitest";
import type { CanvasSkillContribution } from "@octant/contracts/canvas-skill";
import {
  admitCanvasSkillContribution,
  filterCanvasSkillContributions,
  type CanvasSkillTrustFacts,
} from "./canvasSkillContributions";

const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const qualifiedId =
  `bundled:octant.bundled:report:${digest}` as CanvasSkillContribution["qualifiedId"];

const contribution: CanvasSkillContribution = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId,
  version: "1.2.0" as CanvasSkillContribution["version"],
  digest: digest as CanvasSkillContribution["digest"],
  sourceKind: "bundled",
  supportedSources: ["artifact"],
  layouts: [],
  presentationRules: [],
};

const trusted: CanvasSkillTrustFacts = {
  installed: true,
  trusted: true,
  desiredEnabled: true,
  effectiveState: { kind: "effective" },
};

describe("admitCanvasSkillContribution", () => {
  it("admits a trusted, enabled, effective skill contribution", () => {
    const result = admitCanvasSkillContribution({ contribution, facts: trusted });
    expect(result).toEqual({ kind: "admitted", contribution });
  });

  it("denies an installed but untrusted skill so installation never grants authority", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: { ...trusted, trusted: false },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "untrusted" });
  });

  it("denies a not-installed skill as untrusted", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: { ...trusted, installed: false },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "untrusted" });
  });

  it("denies a trusted but disabled skill so selection never grants authority", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: { ...trusted, desiredEnabled: false },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "not-enabled" });
  });

  it("denies a skill blocked by effective activation and surfaces the block reason", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: { ...trusted, effectiveState: { kind: "blocked", reason: "mode-prohibited" } },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "not-effective" });
    if (result.kind === "denied") expect(result.message).toContain("mode-prohibited");
  });

  it("denies when the expected qualified identity does not match", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: trusted,
      expected: {
        qualifiedId:
          `bundled:octant.bundled:other:${digest}` as CanvasSkillContribution["qualifiedId"],
      },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "identity-mismatch" });
  });

  it("denies when the expected digest does not match", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: trusted,
      expected: {
        digest:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111" as CanvasSkillContribution["digest"],
      },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "identity-mismatch" });
  });

  it("denies when the expected package version does not match", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: trusted,
      expected: { version: "2.0.0" as never },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "version-mismatch" });
  });

  it("denies when a version is pinned but the contribution omits its version", () => {
    const { version: _version, ...unversioned } = contribution;
    const result = admitCanvasSkillContribution({
      contribution: unversioned as CanvasSkillContribution,
      facts: trusted,
      expected: { version: "1.2.0" as never },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "version-mismatch" });
  });

  it("checks identity before trust so a mismatch never reveals trust state", () => {
    const result = admitCanvasSkillContribution({
      contribution,
      facts: { ...trusted, trusted: false },
      expected: {
        qualifiedId:
          `bundled:octant.bundled:other:${digest}` as CanvasSkillContribution["qualifiedId"],
      },
    });
    expect(result).toMatchObject({ kind: "denied", denialCode: "identity-mismatch" });
  });

  it("filters a set down to only admitted contributions", () => {
    const admitted = filterCanvasSkillContributions([
      { contribution, facts: trusted },
      { contribution, facts: { ...trusted, trusted: false } },
    ]);
    expect(admitted).toEqual([contribution]);
  });
});
