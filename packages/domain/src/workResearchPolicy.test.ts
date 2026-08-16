import { describe, expect, it } from "vitest";
import {
  classifyEvidenceLeakage,
  classifyExcerptSupport,
  classifyResearchAuthority,
  classifySourceFreshness,
  detectDuplicateSource,
  isClaimUnsupported,
  nextBriefStatus,
  validateCitationIntegrity,
} from "./workResearchPolicy";
import { decodePreviewSourceVersion, type PreviewSourceVersion } from "@octant/contracts/previews";
import { decodeWorkResearchBrief, type WorkResearchBrief } from "@octant/contracts/work-research";

const sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
const observedAt = "2026-07-24T08:00:00.000Z";
const sourceVersion: PreviewSourceVersion = decodePreviewSourceVersion({
  contentSha256: sha256,
  byteSize: 256,
  observedAt,
});
const changedVersion: PreviewSourceVersion = decodePreviewSourceVersion({
  contentSha256: "1111111111111111111111111111111111111111111111111111111111111111",
  byteSize: 300,
  observedAt,
});

const baseBrief: WorkResearchBrief = decodeWorkResearchBrief({
  briefId: "11111111-1111-4111-8111-111111111111",
  projectId: "77777777-7777-4777-8777-777777777777",
  questions: ["What are the tradeoffs?"],
  sourcePolicy: {
    allowedKinds: ["web", "file", "user-reference", "mail-export"],
    maxSources: 8,
    excerptByteBudget: 64_000,
  },
  notes: [],
  deliverables: ["report"],
  status: "gathering",
  createdBy: { kind: "local-user", actorId: "88888888-8888-4888-8888-888888888888" },
  createdAt: "2026-07-24T08:00:01.000Z",
  version: 2,
});

describe("classifySourceFreshness", () => {
  it("classifies a matching current observation as fresh", () => {
    expect(classifySourceFreshness({ known: sourceVersion, current: sourceVersion })).toEqual(
      "fresh",
    );
  });

  it("classifies a changed content hash as stale", () => {
    expect(classifySourceFreshness({ known: sourceVersion, current: changedVersion })).toEqual(
      "stale",
    );
  });

  it("classifies a missing current observation as unavailable", () => {
    expect(classifySourceFreshness({ known: sourceVersion, current: undefined })).toEqual(
      "unavailable",
    );
  });

  it("classifies a first observation as fresh", () => {
    expect(classifySourceFreshness({ known: undefined, current: sourceVersion })).toEqual("fresh");
  });
});

describe("detectDuplicateSource", () => {
  it("detects a duplicate by kind and normalized ref", () => {
    const existing = [{ kind: "web" as const, sourceRef: "Opaque-Token-1" }];
    expect(detectDuplicateSource(existing, { kind: "web", sourceRef: "opaque-token-1" })).toBe(
      true,
    );
  });

  it("distinguishes sources of different kinds with the same ref", () => {
    const existing = [{ kind: "web" as const, sourceRef: "opaque-token-1" }];
    expect(detectDuplicateSource(existing, { kind: "file", sourceRef: "opaque-token-1" })).toBe(
      false,
    );
  });

  it("treats a genuinely new source as not duplicate", () => {
    const existing = [{ kind: "web" as const, sourceRef: "opaque-token-1" }];
    expect(detectDuplicateSource(existing, { kind: "web", sourceRef: "opaque-token-2" })).toBe(
      false,
    );
  });
});

describe("validateCitationIntegrity", () => {
  const evidence = [
    { citationAnchor: "anchor-1", sourceId: "source-1" },
    { citationAnchor: "anchor-2", sourceId: "source-2" },
  ];
  const sources = [
    { sourceId: "source-1", availability: "fresh" as const },
    { sourceId: "source-2", availability: "fresh" as const },
  ];

  it("validates claims whose anchors resolve to fresh-source evidence", () => {
    expect(
      validateCitationIntegrity({
        evidence,
        sources,
        claims: [{ citationAnchors: ["anchor-1", "anchor-2"] }],
      }),
    ).toEqual({ kind: "valid" });
  });

  it("flags claims with a dangling anchor as unsupported", () => {
    const result = validateCitationIntegrity({
      evidence,
      sources,
      claims: [{ citationAnchors: ["anchor-1", "anchor-missing"] }],
    });
    expect(result.kind).toEqual("unsupported");
    if (result.kind === "unsupported") {
      expect(result.danglingAnchors).toEqual(["anchor-missing"]);
    }
  });

  it("flags claims whose only evidence is on a stale source as unsupported", () => {
    const result = validateCitationIntegrity({
      evidence,
      sources: [
        { sourceId: "source-1", availability: "stale" },
        { sourceId: "source-2", availability: "fresh" },
      ],
      claims: [{ citationAnchors: ["anchor-1"] }],
    });
    expect(result.kind).toEqual("unsupported");
  });

  it("flags claims whose only evidence is on a revoked source as unsupported", () => {
    const result = validateCitationIntegrity({
      evidence,
      sources: [
        { sourceId: "source-1", availability: "revoked" },
        { sourceId: "source-2", availability: "fresh" },
      ],
      claims: [{ citationAnchors: ["anchor-1"] }],
    });
    expect(result.kind).toEqual("unsupported");
  });
});

describe("isClaimUnsupported", () => {
  const evidence = [{ citationAnchor: "anchor-1", sourceId: "source-1" }];
  const sources = [{ sourceId: "source-1", availability: "fresh" as const }];

  it("marks a claim with no anchors as unsupported", () => {
    expect(isClaimUnsupported({ evidence, sources, claim: { citationAnchors: [] } })).toBe(true);
  });

  it("marks a claim with a resolvable anchor as supported", () => {
    expect(
      isClaimUnsupported({ evidence, sources, claim: { citationAnchors: ["anchor-1"] } }),
    ).toBe(false);
  });
});

describe("classifyResearchAuthority", () => {
  it("allows a new fresh source within policy", () => {
    expect(
      classifyResearchAuthority({
        brief: baseBrief,
        recordedSourceCount: 1,
        candidateSourceKind: "web",
        candidateAvailability: "fresh",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("denies a revoked source with source-revoked", () => {
    expect(
      classifyResearchAuthority({
        brief: baseBrief,
        recordedSourceCount: 1,
        candidateSourceKind: "web",
        candidateAvailability: "revoked",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "denied", reason: "source-revoked" });
  });

  it("denies a stale source with source-stale", () => {
    expect(
      classifyResearchAuthority({
        brief: baseBrief,
        recordedSourceCount: 1,
        candidateSourceKind: "web",
        candidateAvailability: "stale",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "denied", reason: "source-stale" });
  });

  it("denies a source kind outside the brief policy", () => {
    const brief = {
      ...baseBrief,
      sourcePolicy: { ...baseBrief.sourcePolicy, allowedKinds: ["file"] },
    } as const;
    expect(
      classifyResearchAuthority({
        brief,
        recordedSourceCount: 0,
        candidateSourceKind: "web",
        candidateAvailability: "fresh",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "denied", reason: "source-kind-not-allowed" });
  });

  it("denies when the source budget is exceeded", () => {
    const brief = {
      ...baseBrief,
      sourcePolicy: { ...baseBrief.sourcePolicy, maxSources: 2 },
    } as const;
    expect(
      classifyResearchAuthority({
        brief,
        recordedSourceCount: 2,
        candidateSourceKind: "web",
        candidateAvailability: "fresh",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "denied", reason: "source-budget-exceeded" });
  });

  it("denies when the brief is missing", () => {
    expect(
      classifyResearchAuthority({
        brief: undefined,
        recordedSourceCount: 0,
        candidateSourceKind: "web",
        candidateAvailability: "fresh",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "denied", reason: "brief-not-found" });
  });

  it("denies when the brief is finalized", () => {
    expect(
      classifyResearchAuthority({
        brief: { ...baseBrief, status: "finalized" },
        recordedSourceCount: 1,
        candidateSourceKind: "web",
        candidateAvailability: "fresh",
        isExistingSource: false,
      }),
    ).toEqual({ kind: "denied", reason: "brief-finalized" });
  });

  it("allows an existing source even when the budget is met", () => {
    const brief = {
      ...baseBrief,
      sourcePolicy: { ...baseBrief.sourcePolicy, maxSources: 2 },
    } as const;
    expect(
      classifyResearchAuthority({
        brief,
        recordedSourceCount: 2,
        candidateSourceKind: "web",
        candidateAvailability: "fresh",
        isExistingSource: true,
      }),
    ).toEqual({ kind: "allowed" });
  });
});

describe("classifyEvidenceLeakage", () => {
  it("classifies a clean excerpt as clean", () => {
    expect(classifyEvidenceLeakage("Local-first software owns user data.")).toEqual("clean");
  });

  it("classifies a host path as leaked", () => {
    expect(classifyEvidenceLeakage("see /Users/example/secret/notes.md")).toEqual("leaked");
  });

  it("classifies an email address as leaked", () => {
    expect(classifyEvidenceLeakage("contact ada@example.com for details")).toEqual("leaked");
  });

  it("classifies an AWS key id as leaked", () => {
    expect(classifyEvidenceLeakage("key AKIAIOSFODNN7EXAMPLE was used")).toEqual("leaked");
  });

  it("classifies a Bearer token as leaked", () => {
    expect(classifyEvidenceLeakage("Authorization: Bearer abc123.def456")).toEqual("leaked");
  });
});

describe("classifyExcerptSupport", () => {
  const sourceText =
    "# Notes\n\nLocal-first software owns user data\nand prioritizes offline agency.\n";

  it("supports an excerpt the source states, even across a line break", () => {
    expect(
      classifyExcerptSupport({
        sourceText,
        excerpt: "Local-first software owns user data and prioritizes offline agency.",
      }),
    ).toEqual("present");
  });

  it("refuses an excerpt the source never states", () => {
    expect(
      classifyExcerptSupport({
        sourceText,
        excerpt: "Local-first software eliminates every cloud outage.",
      }),
    ).toEqual("absent");
  });

  it("refuses an excerpt that only reorders the source's words", () => {
    expect(
      classifyExcerptSupport({
        sourceText,
        excerpt: "owns user data Local-first software",
      }),
    ).toEqual("absent");
  });

  it("refuses an excerpt whose casing differs from the source", () => {
    expect(
      classifyExcerptSupport({ sourceText, excerpt: "local-first software owns user data" }),
    ).toEqual("absent");
  });

  it("refuses an excerpt that is only whitespace", () => {
    expect(classifyExcerptSupport({ sourceText, excerpt: "   " })).toEqual("absent");
  });
});

describe("nextBriefStatus", () => {
  it("moves draft to gathering on source-added", () => {
    expect(nextBriefStatus("draft", "source-added")).toEqual("gathering");
  });

  it("keeps gathering on source-added", () => {
    expect(nextBriefStatus("gathering", "source-added")).toEqual("gathering");
  });

  it("moves draft to gathering on evidence-recorded", () => {
    expect(nextBriefStatus("draft", "evidence-recorded")).toEqual("gathering");
  });

  it("moves gathering to analyzing on claim-recorded", () => {
    expect(nextBriefStatus("gathering", "claim-recorded")).toEqual("analyzing");
  });

  it("moves to finalized on report-finalized", () => {
    expect(nextBriefStatus("analyzing", "report-finalized")).toEqual("finalized");
  });

  it("keeps status on retrieval-cancelled", () => {
    expect(nextBriefStatus("gathering", "retrieval-cancelled")).toEqual("gathering");
  });
});
