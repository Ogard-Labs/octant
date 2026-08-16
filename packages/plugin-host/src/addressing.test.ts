import { describe, expect, it } from "vitest";
import {
  resolveDraftExtensionReference,
  resolveStructuredPluginReference,
  revalidateExtensionSelection,
  type ExtensionAddressingCatalog,
} from "./addressing";

const extensionId = "10000000-0000-4000-8000-000000000001";
const collidingExtensionId = "10000000-0000-4000-8000-000000000002";
const packageId = "11000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const catalogEpoch = `sha256:${"c".repeat(64)}`;
const otherCatalogEpoch = `sha256:${"d".repeat(64)}`;
const skillId = `agents-skills-directory:project~skills:review:${digest}`;
const collidingSkillId = `plugin-package:catalog~review:review:${otherDigest}`;

function catalog(overrides: Partial<ExtensionAddressingCatalog> = {}): ExtensionAddressingCatalog {
  return {
    epoch: catalogEpoch as never,
    plugins: [
      {
        extensionId: extensionId as never,
        packageId: packageId as never,
        slug: "build-tools" as never,
        packageVersion: "1.2.3" as never,
        packageDigest: digest as never,
        primaryComponentId: "instructions" as never,
        components: [
          {
            componentId: "instructions" as never,
            label: "Build guidance",
            effectiveState: { kind: "effective" },
          },
          {
            componentId: "server" as never,
            label: "Build server",
            effectiveState: { kind: "blocked", reason: "component-disabled" },
          },
        ],
      },
    ],
    skills: [
      {
        skillId: skillId as never,
        name: "review",
        label: "Project review",
        packageDigest: digest as never,
        effectiveState: { kind: "effective" },
      },
    ],
    ...overrides,
  };
}

describe("structured extension addressing", () => {
  it("normalizes exact plugin and explicit skill references into immutable draft selections", () => {
    expect(resolveDraftExtensionReference("@build-tools", catalog(), "draft-1")).toMatchObject({
      kind: "selected",
      label: "Build guidance",
      selection: {
        kind: "plugin",
        extensionId,
        packageId,
        componentId: "instructions",
        packageVersion: "1.2.3",
        packageDigest: digest,
        catalogEpoch,
        origin: { kind: "draft", reference: "draft-1" },
      },
    });
    expect(resolveDraftExtensionReference(`$${skillId}`, catalog(), "draft-2")).toMatchObject({
      kind: "selected",
      label: "Project review",
      selection: {
        kind: "skill",
        skillId,
        packageDigest: digest,
        catalogEpoch,
      },
    });
  });

  it("keeps collisions and blocked effective state visible without silently retargeting", () => {
    const duplicatePlugin = {
      ...catalog().plugins[0]!,
      extensionId: collidingExtensionId as never,
      packageDigest: otherDigest as never,
    };
    const duplicateSkill = {
      ...catalog().skills[0]!,
      skillId: collidingSkillId as never,
      packageDigest: otherDigest as never,
    };
    const collisions = catalog({
      plugins: [...catalog().plugins, duplicatePlugin],
      skills: [...catalog().skills, duplicateSkill],
    });

    expect(resolveDraftExtensionReference("@build-tools", collisions, "draft-3")).toMatchObject({
      kind: "ambiguous",
      candidates: [extensionId, collidingExtensionId],
    });
    expect(resolveDraftExtensionReference("$review", collisions, "draft-4")).toMatchObject({
      kind: "ambiguous",
      candidates: [skillId, collidingSkillId],
    });
    expect(
      resolveDraftExtensionReference("@build-tools/server", catalog(), "draft-5"),
    ).toMatchObject({ kind: "blocked", reason: "component-disabled" });
    expect(resolveDraftExtensionReference("person@example.com", catalog(), "draft-6")).toEqual({
      kind: "plain-text",
      text: "person@example.com",
    });
    expect(resolveDraftExtensionReference("@missing", catalog(), "draft-6a")).toEqual({
      kind: "blocked",
      reason: "not-found",
    });
    expect(resolveDraftExtensionReference("@missing/component", catalog(), "draft-6b")).toEqual({
      kind: "blocked",
      reason: "not-found",
    });
    expect(resolveDraftExtensionReference("$missing", catalog(), "draft-6c")).toEqual({
      kind: "blocked",
      reason: "not-found",
    });
    expect(
      resolveDraftExtensionReference("ordinary @missing prose", catalog(), "draft-6d"),
    ).toEqual({
      kind: "plain-text",
      text: "ordinary @missing prose",
    });
  });

  it("supports source-qualified palette selection and fails closed at send, resume, replay, and handoff", () => {
    const draft = resolveStructuredPluginReference(
      { extensionId: extensionId as never, componentId: "instructions" as never },
      catalog(),
      "draft-7",
    );
    expect(draft.kind).toBe("selected");
    if (draft.kind !== "selected") throw new Error("Expected selected draft");

    expect(revalidateExtensionSelection(draft.selection, catalog(), "send")).toMatchObject({
      kind: "selected",
      phase: "send",
    });
    for (const phase of ["resume", "replay", "provider-handoff"] as const) {
      expect(
        revalidateExtensionSelection(
          draft.selection,
          catalog({ epoch: otherCatalogEpoch as never }),
          phase,
        ),
      ).toEqual({ kind: "blocked", phase, reason: "stale-catalog-epoch" });
    }
    expect(
      revalidateExtensionSelection(
        draft.selection,
        catalog({
          plugins: [
            {
              ...catalog().plugins[0]!,
              components: [
                {
                  ...catalog().plugins[0]!.components[0]!,
                  effectiveState: { kind: "blocked", reason: "project-prohibited" },
                },
              ],
            },
          ],
        }),
        "send",
      ),
    ).toMatchObject({ kind: "blocked", reason: "project-prohibited" });
  });
});
