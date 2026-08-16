import { describe, expect, it } from "vitest";
import type { StandaloneSkillRecord } from "@octant/contracts/extensions";
import { buildSkillCatalog, filterSkillCatalogForScope } from "./skills";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function record(
  qualifiedId: string,
  sourceKind: "agents-skills-directory",
  digest: string,
): StandaloneSkillRecord {
  return {
    skill: {
      qualifiedId: qualifiedId as never,
      name: "review",
      sourceKind,
      digest: digest as never,
      available: true,
    },
    source: {
      kind: sourceKind,
      sourceRef: "project:fixture" as never,
    },
    displayName: "Review",
    provenance: { reviewed: false },
    contentBytes: 16,
    reviewed: false,
    desiredEnabled: false,
    effectiveState: { kind: "blocked", reason: "untrusted" },
  };
}

describe("standalone skill catalog", () => {
  it("keeps source collisions visible and leaves discovered skills disabled", () => {
    const result = buildSkillCatalog([
      record(
        `agents-skills-directory:project:review:${digestA}`,
        "agents-skills-directory",
        digestA,
      ),
      record(`agents-skills-directory:user:review:${digestB}`, "agents-skills-directory", digestB),
    ]);

    expect(result.skills.map((entry) => entry.skill.qualifiedId)).toEqual([
      `agents-skills-directory:project:review:${digestA}`,
      `agents-skills-directory:user:review:${digestB}`,
    ]);
    expect(result.collisions).toEqual([
      {
        name: "review",
        candidates: [
          `agents-skills-directory:project:review:${digestA}`,
          `agents-skills-directory:user:review:${digestB}`,
        ],
      },
    ]);
    expect(result.skills.every((entry) => entry.desiredEnabled === false)).toBe(true);
    expect(result.skills.every((entry) => entry.effectiveState.kind === "blocked")).toBe(true);
  });

  it("keeps root skills and filters nested skills to the exact thread scope", () => {
    const root = record(
      `agents-skills-directory:project-root:review:${digestA}`,
      "agents-skills-directory",
      digestA,
    );
    const nested = {
      ...record(
        `agents-skills-directory:thread-a:review:${digestB}`,
        "agents-skills-directory",
        digestB,
      ),
      scope: {
        mode: "code",
        projectId: "11111111-1111-4111-8111-111111111111" as never,
        threadRef: "22222222-2222-4222-8222-222222222222" as never,
      },
    } satisfies StandaloneSkillRecord;
    const catalog = buildSkillCatalog([root, nested]);

    expect(
      filterSkillCatalogForScope(catalog, {
        mode: "code",
        projectId: "11111111-1111-4111-8111-111111111111",
        threadRef: "22222222-2222-4222-8222-222222222222",
      }).skills,
    ).toHaveLength(2);
    expect(
      filterSkillCatalogForScope(catalog, {
        mode: "code",
        projectId: "11111111-1111-4111-8111-111111111111",
        threadRef: "33333333-3333-4333-8333-333333333333",
      }).skills,
    ).toEqual([root]);
    expect(
      filterSkillCatalogForScope(catalog, {
        mode: "chat",
        projectId: null,
        threadRef: "44444444-4444-4444-8444-444444444444",
      }).skills,
    ).toEqual([root]);
  });
});
