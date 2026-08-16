import { describe, expect, it } from "vitest";
import {
  CANVAS_SKILL_MAX_LAYOUTS,
  CANVAS_SKILL_MAX_PRESENTATION_RULES,
  CANVAS_SKILL_MAX_SLOTS,
  decodeCanvasSkillContribution,
  decodeCanvasSkillContributionResolution,
} from "./canvasSkill";

const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const qualifiedId = `bundled:octant.bundled:report:${digest}`;

const contribution = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId,
  version: "1.2.0",
  digest,
  sourceKind: "bundled",
  supportedSources: ["artifact", "thread"],
  layouts: [
    {
      layoutId: "audit-summary",
      title: "Audit summary",
      slots: [
        { blockKind: "heading", label: "Title" },
        { blockKind: "artifact-reference", sourceKind: "artifact" },
        { blockKind: "summary" },
      ],
    },
  ],
  presentationRules: [
    {
      ruleId: "emphasize-status",
      kind: "emphasis",
      target: "status",
      directive: "highlight-danger",
    },
    {
      ruleId: "order-metrics",
      kind: "ordering",
      target: "metric",
      directive: "descending-by-value",
    },
  ],
} as const;

describe("CanvasSkillContribution contract", () => {
  it("round-trips a valid trusted skill contribution", () => {
    const decoded = decodeCanvasSkillContribution(contribution);
    expect(decoded.qualifiedId).toBe(qualifiedId);
    expect(decoded.supportedSources).toEqual(["artifact", "thread"]);
    expect(decoded.layouts).toHaveLength(1);
    expect(decoded.presentationRules).toHaveLength(2);
  });

  it("accepts a contribution without an explicit package version", () => {
    const { version: _version, ...withoutVersion } = contribution;
    const decoded = decodeCanvasSkillContribution(withoutVersion);
    expect(decoded.version).toBeUndefined();
  });

  it("rejects an unknown schema version so a future contribution fails closed", () => {
    expect(() => decodeCanvasSkillContribution({ ...contribution, schemaVersion: 2 })).toThrow();
  });

  it("rejects excess properties that could smuggle authority into a contribution", () => {
    expect(() =>
      decodeCanvasSkillContribution({
        ...contribution,
        // A skill contribution must never carry authority, capabilities, or
        // concrete source references. Excess fields fail closed.
        grantedAuthority: { filesystem: true },
      }),
    ).toThrow();
  });

  it("rejects a presentation rule with an excess field", () => {
    expect(() =>
      decodeCanvasSkillContribution({
        ...contribution,
        presentationRules: [
          {
            ruleId: "rogue",
            kind: "emphasis",
            target: "status",
            directive: "x",
            execute: "rm -rf /",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a contribution whose sourceKind disagrees with the qualified identity", () => {
    expect(() =>
      // qualifiedId encodes `bundled`, but the standalone field claims another
      // source kind, which would spoof audit provenance.
      decodeCanvasSkillContribution({ ...contribution, sourceKind: "catalog" }),
    ).toThrow();
  });

  it("rejects a contribution whose digest disagrees with the qualified identity", () => {
    expect(() =>
      decodeCanvasSkillContribution({
        ...contribution,
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      }),
    ).toThrow();
  });

  it("rejects a contribution with no supported sources", () => {
    expect(() =>
      decodeCanvasSkillContribution({ ...contribution, supportedSources: [] }),
    ).toThrow();
  });

  it("rejects duplicate supported source kinds", () => {
    expect(() =>
      decodeCanvasSkillContribution({
        ...contribution,
        supportedSources: ["artifact", "artifact"],
      }),
    ).toThrow();
  });

  it("rejects a layout slot referencing an unknown block kind", () => {
    expect(() =>
      decodeCanvasSkillContribution({
        ...contribution,
        layouts: [{ layoutId: "bad", title: "Bad", slots: [{ blockKind: "iframe" }] }],
      }),
    ).toThrow();
  });

  it("keeps layout and rule counts within bounded budgets", () => {
    expect(CANVAS_SKILL_MAX_LAYOUTS).toBeGreaterThan(0);
    expect(CANVAS_SKILL_MAX_PRESENTATION_RULES).toBeGreaterThan(0);
    expect(CANVAS_SKILL_MAX_SLOTS).toBeGreaterThan(0);
  });

  it("decodes an admitted resolution", () => {
    const resolution = decodeCanvasSkillContributionResolution({
      kind: "admitted",
      contribution,
    });
    expect(resolution.kind).toBe("admitted");
  });

  it("decodes a denied resolution with a typed code", () => {
    const resolution = decodeCanvasSkillContributionResolution({
      kind: "denied",
      denialCode: "untrusted",
      message: "Skill is not trusted.",
    });
    expect(resolution).toMatchObject({ kind: "denied", denialCode: "untrusted" });
  });
});
