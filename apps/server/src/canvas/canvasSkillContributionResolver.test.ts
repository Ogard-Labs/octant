import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts";
import type { CanvasRefreshRequest, CanvasRefreshSkill } from "@octant/contracts/canvas-refresh";
import type { CanvasSkillContribution } from "@octant/contracts/canvas-skill";
import type { CanvasSkillTrustFacts } from "@octant/plugin-host";
import { createCanvasSkillContributionResolver } from "./canvasSkillContributionResolver";

const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const qualifiedId =
  `agents-skills-directory:project:review:${digest}` as CanvasSkillContribution["qualifiedId"];

const ids = {
  source: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
} as const;

const definition: CanvasDefinition = decodeCanvasDefinition({
  schemaVersion: CANVAS_SCHEMA_VERSION,
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
    {
      blockId: "heading",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "heading",
      level: 1,
      text: "Audit",
    },
  ],
});

const contribution: CanvasSkillContribution = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId,
  version: "1.0.0" as CanvasSkillContribution["version"],
  digest: digest as CanvasSkillContribution["digest"],
  sourceKind: "agents-skills-directory",
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

const skill: CanvasRefreshSkill = {
  qualifiedId,
  version: "1.0.0" as CanvasRefreshSkill["version"],
};

const request = { recipe: { skill } } as unknown as CanvasRefreshRequest;

describe("createCanvasSkillContributionResolver", () => {
  it("admits a trusted, enabled contribution that supports the canvas sources", () => {
    const resolve = createCanvasSkillContributionResolver({
      lookup: () => ({ contribution, facts: trusted }),
    });
    expect(resolve(skill, request, definition)).toEqual({ kind: "admitted", contribution });
  });

  it("returns undefined (refresh proceeds) when the skill declares no contribution", () => {
    const resolve = createCanvasSkillContributionResolver({ lookup: () => undefined });
    expect(resolve(skill, request, definition)).toBeUndefined();
  });

  it("denies when the registered skill is not trusted", () => {
    const resolve = createCanvasSkillContributionResolver({
      lookup: () => ({ contribution, facts: { ...trusted, trusted: false } }),
    });
    expect(resolve(skill, request, definition)).toMatchObject({
      kind: "denied",
      denialCode: "untrusted",
    });
  });

  it("denies when the registered skill is not enabled", () => {
    const resolve = createCanvasSkillContributionResolver({
      lookup: () => ({ contribution, facts: { ...trusted, desiredEnabled: false } }),
    });
    expect(resolve(skill, request, definition)).toMatchObject({
      kind: "denied",
      denialCode: "not-enabled",
    });
  });

  it("denies when the contribution does not support a canvas source kind", () => {
    const resolve = createCanvasSkillContributionResolver({
      lookup: () => ({
        contribution: { ...contribution, supportedSources: ["thread"] },
        facts: trusted,
      }),
    });
    expect(resolve(skill, request, definition)).toMatchObject({
      kind: "denied",
      denialCode: "unsupported-source",
    });
  });

  it("denies when the registered contribution identity does not match the recipe skill", () => {
    const resolve = createCanvasSkillContributionResolver({
      lookup: () => ({
        contribution: {
          ...contribution,
          qualifiedId:
            `agents-skills-directory:project:other:${digest}` as CanvasSkillContribution["qualifiedId"],
        },
        facts: trusted,
      }),
    });
    expect(resolve(skill, request, definition)).toMatchObject({
      kind: "denied",
      denialCode: "identity-mismatch",
    });
  });
});
