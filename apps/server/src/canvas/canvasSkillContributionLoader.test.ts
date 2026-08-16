import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts";
import type { CanvasRefreshRequest, CanvasRefreshSkill } from "@octant/contracts/canvas-refresh";
import type { StandaloneSkillRecord } from "@octant/contracts/extensions";
import { createCanvasSkillContributionResolver } from "./canvasSkillContributionResolver";
import {
  canvasSkillTrustFactsFromRecord,
  createCanvasSkillContributionLookup,
} from "./canvasSkillContributionLoader";

const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const qualifiedId = `agents-skills-directory:project:review:${digest}`;

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

// A raw, provider-published contribution document as it would be carried on the
// reconciled skill record before the server re-validates it.
const contributionDocument = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId,
  version: "1.0.0",
  digest,
  sourceKind: "agents-skills-directory",
  supportedSources: ["artifact"],
  layouts: [],
  presentationRules: [],
} as const;

const skill: CanvasRefreshSkill = {
  qualifiedId: qualifiedId as CanvasRefreshSkill["qualifiedId"],
  version: "1.0.0" as CanvasRefreshSkill["version"],
};

const request = { recipe: { skill } } as unknown as CanvasRefreshRequest;

function record(overrides: Partial<StandaloneSkillRecord> = {}): StandaloneSkillRecord {
  return {
    skill: {
      qualifiedId: qualifiedId as StandaloneSkillRecord["skill"]["qualifiedId"],
      name: "review" as StandaloneSkillRecord["skill"]["name"],
      sourceKind: "agents-skills-directory",
      digest: digest as StandaloneSkillRecord["skill"]["digest"],
      available: true,
    },
    source: { kind: "agents-skills-directory", sourceRef: "skills/review" },
    version: "1.0.0" as StandaloneSkillRecord["version"],
    displayName: "Review",
    provenance: { reviewed: true },
    contentBytes: 0,
    reviewed: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    canvasContribution: contributionDocument,
    ...overrides,
  } as StandaloneSkillRecord;
}

describe("createCanvasSkillContributionLookup", () => {
  it("derives trust facts from the authoritative record, never the document", () => {
    expect(canvasSkillTrustFactsFromRecord(record())).toEqual({
      installed: true,
      trusted: true,
      desiredEnabled: true,
      effectiveState: { kind: "effective" },
    });
    expect(
      canvasSkillTrustFactsFromRecord(record({ reviewed: false, desiredEnabled: false })),
    ).toEqual({
      installed: true,
      trusted: false,
      desiredEnabled: false,
      effectiveState: { kind: "effective" },
    });
  });

  it("returns undefined when the skill is not reconciled/in scope", () => {
    const lookup = createCanvasSkillContributionLookup({
      findSkillRecord: () => undefined,
      readContributionDocument: (candidate) => candidate.canvasContribution,
    });
    expect(lookup(skill, request)).toBeUndefined();
  });

  it("returns undefined when a reconciled skill publishes no contribution document", () => {
    const lookup = createCanvasSkillContributionLookup({
      findSkillRecord: () => record({ canvasContribution: undefined }),
      readContributionDocument: (candidate) => candidate.canvasContribution,
    });
    expect(lookup(skill, request)).toBeUndefined();
  });

  it("treats a malformed published document as no contribution (fail closed)", () => {
    const lookup = createCanvasSkillContributionLookup({
      findSkillRecord: () => record({ canvasContribution: { kind: "not-a-contribution" } }),
      readContributionDocument: (candidate) => candidate.canvasContribution,
    });
    expect(lookup(skill, request)).toBeUndefined();
  });

  it("decodes a published document and pairs it with the record's trust facts", () => {
    const lookup = createCanvasSkillContributionLookup({
      findSkillRecord: () => record(),
      readContributionDocument: (candidate) => candidate.canvasContribution,
    });
    const source = lookup(skill, request);
    expect(source?.facts).toEqual({
      installed: true,
      trusted: true,
      desiredEnabled: true,
      effectiveState: { kind: "effective" },
    });
    expect(source?.contribution.qualifiedId).toBe(qualifiedId);
  });
});

describe("Canvas skill contribution production path (loader + resolver)", () => {
  function resolveWith(overrides: Partial<StandaloneSkillRecord> = {}) {
    const resolve = createCanvasSkillContributionResolver({
      lookup: createCanvasSkillContributionLookup({
        findSkillRecord: () => record(overrides),
        readContributionDocument: (candidate) => candidate.canvasContribution,
      }),
    });
    return resolve(skill, request, definition);
  }

  it("admits a trusted, enabled skill that publishes a supported contribution", () => {
    const resolution = resolveWith();
    expect(resolution?.kind).toBe("admitted");
  });

  it("denies an installed but untrusted skill so publishing never grants authority", () => {
    expect(resolveWith({ reviewed: false })).toMatchObject({
      kind: "denied",
      denialCode: "untrusted",
    });
  });

  it("denies a trusted but disabled skill", () => {
    expect(resolveWith({ desiredEnabled: false })).toMatchObject({
      kind: "denied",
      denialCode: "not-enabled",
    });
  });

  it("denies a skill blocked by effective activation", () => {
    expect(
      resolveWith({ effectiveState: { kind: "blocked", reason: "mode-prohibited" } }),
    ).toMatchObject({
      kind: "denied",
      denialCode: "not-effective",
    });
  });
});
