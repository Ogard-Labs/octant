import { describe, expect, it } from "vitest";
import { decodeCanvasDefinition, type CanvasSkillContribution } from "@octant/contracts";
import { resolveCanvasSkillPresentation } from "./canvasSkillPolicy";

const ids = {
  source: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  project: "88888888-8888-4888-8888-888888888888",
  provider: "99999999-9999-4999-8999-999999999999",
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const definition = decodeCanvasDefinition({
  schemaVersion: 1,
  title: "Audit",
  provenance: {
    mode: "chat",
    hostId: "local",
    projectId: ids.project,
    threadId: ids.thread,
    actor: { kind: "local-user", actorId: ids.actor },
    providerInstanceId: ids.provider,
    modelId: "model",
    createdAt: "2026-08-03T10:00:00.000Z",
  },
  sourceManifest: [
    {
      sourceId: ids.source,
      kind: "artifact",
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "artifact:one",
      displayName: "Artifact",
    },
  ],
  blocks: [
    { blockId: "heading", schemaVersion: 1, kind: "heading", level: 1, text: "Audit" },
    {
      blockId: "status",
      schemaVersion: 1,
      kind: "status",
      label: "Build",
      value: "green",
      tone: "success",
    },
  ],
});

const contribution: CanvasSkillContribution = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId: `bundled:octant.bundled:report:${digest}` as CanvasSkillContribution["qualifiedId"],
  digest: digest as CanvasSkillContribution["digest"],
  sourceKind: "bundled",
  supportedSources: ["artifact", "thread"],
  layouts: [
    {
      layoutId: "audit" as never,
      title: "Audit",
      slots: [
        { blockKind: "heading" },
        { blockKind: "artifact-reference", sourceKind: "artifact" },
      ],
    },
  ],
  presentationRules: [
    {
      ruleId: "emphasize-status" as never,
      kind: "emphasis",
      target: "status",
      directive: "danger-first",
    },
    {
      ruleId: "annotate-chart" as never,
      kind: "annotation",
      target: "chart",
      directive: "show-legend",
    },
  ],
};

describe("resolveCanvasSkillPresentation", () => {
  it("presents layouts and only the rules that target blocks present in the canvas", () => {
    const result = resolveCanvasSkillPresentation({ contribution, definition });
    expect(result.kind).toBe("presentable");
    if (result.kind !== "presentable") return;
    expect(result.layouts).toEqual(contribution.layouts);
    // Only the status rule applies; the chart rule targets a block kind that
    // is not present, so it is inert.
    expect(result.appliedRules.map((rule) => String(rule.ruleId))).toEqual(["emphasize-status"]);
    expect(result.coveredSourceKinds).toEqual(["artifact"]);
  });

  it("returns no source references, proving a contribution grants no authority", () => {
    const result = resolveCanvasSkillPresentation({ contribution, definition });
    expect(JSON.stringify(result)).not.toContain(ids.source);
    expect(JSON.stringify(result)).not.toContain("opaqueRef");
    expect(JSON.stringify(result)).not.toContain("artifact:one");
  });

  it("denies when a canvas source kind is not within the skill's supported sources", () => {
    const narrow: CanvasSkillContribution = { ...contribution, supportedSources: ["thread"] };
    const result = resolveCanvasSkillPresentation({ contribution: narrow, definition });
    expect(result).toMatchObject({ kind: "denied", denialCode: "unsupported-source" });
  });

  it("denies when a layout slot declares a source kind the contribution does not support", () => {
    const inconsistent: CanvasSkillContribution = {
      ...contribution,
      supportedSources: ["artifact"],
      layouts: [
        {
          layoutId: "bad" as never,
          title: "Bad",
          slots: [{ blockKind: "file-reference", sourceKind: "file" }],
        },
      ],
    };
    const result = resolveCanvasSkillPresentation({ contribution: inconsistent, definition });
    expect(result).toMatchObject({ kind: "denied", denialCode: "unsupported-source" });
  });
});
