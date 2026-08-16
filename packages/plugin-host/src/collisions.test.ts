import { describe, expect, it } from "vitest";
import type { SourceQualifiedSkill } from "@octant/contracts/extensions";
import { decodeSourceQualifiedSkill } from "@octant/contracts/extensions";
import { resolveSkillCollision } from "./collisions";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const digestD = `sha256:${"d".repeat(64)}`;

function skill(
  qualifiedId: string,
  sourceKind: SourceQualifiedSkill["sourceKind"],
): SourceQualifiedSkill {
  return decodeSourceQualifiedSkill({
    qualifiedId,
    name: "review",
    sourceKind,
    digest: qualifiedId.endsWith(digestA)
      ? digestA
      : qualifiedId.endsWith(digestB)
        ? digestB
        : qualifiedId.endsWith(digestC)
          ? digestC
          : digestD,
    available: true,
  });
}

describe("source-qualified skill collisions", () => {
  const project = skill(
    `agents-skills-directory:project:review:${digestA}`,
    "agents-skills-directory",
  );
  const plugin = skill(`plugin-package:plugin:review:${digestB}`, "plugin-package");

  it("preserves visible deterministic ambiguity instead of shadowing", () => {
    expect(resolveSkillCollision("review", [plugin, project])).toEqual({
      kind: "ambiguous",
      name: "review",
      candidates: [project, plugin],
    });
  });

  it("resolves explicit qualified identities and reports missing entries", () => {
    expect(resolveSkillCollision(project.qualifiedId, [plugin, project])).toEqual({
      kind: "resolved",
      skill: project,
    });
    expect(resolveSkillCollision("missing", [project])).toEqual({
      kind: "not-found",
      query: "missing",
    });
  });
});

describe("bundled, provider-native, and plugin-contributed source collisions", () => {
  // These source kinds are distinct from agents-skills-directory (project
  // ancestry + user-global). Project ancestry + user-global are NOT
  // substitutes for bundled, provider-native, or plugin-contributed coverage.
  const bundled = skill(`bundled:app:review:${digestA}`, "bundled");
  const providerNative = skill(`provider-native:openai:review:${digestB}`, "provider-native");
  const pluginContributed = skill(
    `plugin-package:build-ios-apps:review:${digestC}`,
    "plugin-package",
  );
  const agentsDir = skill(
    `agents-skills-directory:project:review:${digestD}`,
    "agents-skills-directory",
  );

  it("preserves visible ambiguity between bundled and provider-native sources", () => {
    // Source order: provider-native (2) before bundled (3).
    expect(resolveSkillCollision("review", [bundled, providerNative])).toEqual({
      kind: "ambiguous",
      name: "review",
      candidates: [providerNative, bundled],
    });
  });

  it("preserves visible ambiguity between bundled and plugin-contributed sources", () => {
    // Source order: plugin-package (1) before bundled (3).
    expect(resolveSkillCollision("review", [bundled, pluginContributed])).toEqual({
      kind: "ambiguous",
      name: "review",
      candidates: [pluginContributed, bundled],
    });
  });

  it("preserves visible ambiguity between provider-native and plugin-contributed sources", () => {
    // Source order: plugin-package (1) before provider-native (2).
    expect(resolveSkillCollision("review", [providerNative, pluginContributed])).toEqual({
      kind: "ambiguous",
      name: "review",
      candidates: [pluginContributed, providerNative],
    });
  });

  it("preserves visible ambiguity across all four source kinds", () => {
    // Source order: agents-skills-directory (0), plugin-package (1),
    // provider-native (2), bundled (3).
    const result = resolveSkillCollision("review", [
      bundled,
      providerNative,
      pluginContributed,
      agentsDir,
    ]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(4);
      expect(result.candidates[0]?.sourceKind).toBe("agents-skills-directory");
      expect(result.candidates[1]?.sourceKind).toBe("plugin-package");
      expect(result.candidates[2]?.sourceKind).toBe("provider-native");
      expect(result.candidates[3]?.sourceKind).toBe("bundled");
    }
  });

  it("resolves explicit qualified identity for each source kind", () => {
    expect(resolveSkillCollision(bundled.qualifiedId, [bundled, providerNative])).toEqual({
      kind: "resolved",
      skill: bundled,
    });
    expect(resolveSkillCollision(providerNative.qualifiedId, [bundled, providerNative])).toEqual({
      kind: "resolved",
      skill: providerNative,
    });
    expect(
      resolveSkillCollision(pluginContributed.qualifiedId, [
        bundled,
        providerNative,
        pluginContributed,
      ]),
    ).toEqual({ kind: "resolved", skill: pluginContributed });
  });
});
