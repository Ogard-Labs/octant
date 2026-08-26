import { describe, expect, it, vi } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { StandaloneSkillRecord } from "@octant/contracts/extensions";
import { createCodeProfileSkillResolver } from "./codeProfileSkillResolver";

const digest = `sha256:${"a".repeat(64)}`;
const qualifiedId = `agents-skills-directory:project:code-reviewer:${digest}`;

function skill(overrides: Partial<StandaloneSkillRecord> = {}): StandaloneSkillRecord {
  return {
    skill: {
      qualifiedId: qualifiedId as never,
      name: "code-reviewer",
      sourceKind: "agents-skills-directory",
      digest: digest as never,
      available: true,
    },
    source: { kind: "agents-skills-directory", sourceRef: "project:fixture" as never },
    displayName: "Code reviewer",
    provenance: { reviewed: true },
    contentBytes: 16,
    reviewed: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    ...overrides,
  };
}

function snapshot(
  skills: ReadonlyArray<StandaloneSkillRecord>,
): Pick<ExtensionSnapshot, "packages" | "skills" | "collisions"> {
  return {
    packages: [],
    collisions: [],
    skills,
  };
}

describe("createCodeProfileSkillResolver", () => {
  it("loads an approved skill the host already treats as effective", async () => {
    const loadSkillText = vi.fn(async () => "Review diffs in isolation.");
    const resolve = createCodeProfileSkillResolver({
      snapshot: () => snapshot([skill()]),
      loadSkillText,
    });

    await expect(
      resolve({
        approvedSkillIds: ["code-reviewer"],
        threadId: "22222222-2222-4222-8222-222222222222",
        projectId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual([
      {
        qualifiedId,
        displayName: "Code reviewer",
        text: "Review diffs in isolation.",
      },
    ]);
    expect(loadSkillText).toHaveBeenCalledOnce();
  });

  it("does not activate an approved skill that is not installed", async () => {
    const loadSkillText = vi.fn(async () => "should never load");
    const resolve = createCodeProfileSkillResolver({
      snapshot: () => snapshot([]),
      loadSkillText,
    });

    await expect(
      resolve({
        approvedSkillIds: ["code-reviewer"],
        threadId: "22222222-2222-4222-8222-222222222222",
        projectId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual([]);
    expect(loadSkillText).not.toHaveBeenCalled();
  });

  it("does not activate an approved skill the host has not trusted", async () => {
    const loadSkillText = vi.fn(async () => "should never load");
    const resolve = createCodeProfileSkillResolver({
      snapshot: () =>
        snapshot([
          skill({
            reviewed: false,
            desiredEnabled: false,
            effectiveState: { kind: "blocked", reason: "untrusted" },
          }),
        ]),
      loadSkillText,
    });

    await expect(
      resolve({
        approvedSkillIds: ["code-reviewer"],
        threadId: "22222222-2222-4222-8222-222222222222",
        projectId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual([]);
    expect(loadSkillText).not.toHaveBeenCalled();
  });
});
