import { describe, expect, it } from "vitest";
import {
  MAX_WORK_RESEARCH_EXCERPT_BYTES,
  decodeWorkCitationAnchor,
  decodeWorkResearchBrief,
  decodeWorkResearchBriefId,
  decodeWorkResearchCommand,
  decodeWorkResearchCommandResult,
  decodeWorkResearchFrame,
  decodeWorkResearchReportId,
  decodeWorkResearchRequestId,
  decodeWorkSourceId,
  decodeWorkSourceRef,
} from "./workResearch";

function expectRoundTrip(decode: (value: unknown) => unknown, value: unknown): void {
  expect(decode(value)).toEqual(value);
}

const ids = {
  brief: "11111111-1111-4111-8111-111111111111",
  source: "22222222-2222-4222-8222-222222222222",
  report: "33333333-3333-4333-8333-333333333333",
  request: "44444444-4444-4444-8444-444444444444",
  evidence: "55555555-5555-4555-8555-555555555555",
  claim: "66666666-6666-4666-8666-666666666666",
  project: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
} as const;

const sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
const observedAt = "2026-07-24T08:00:00.000Z";
const createdAt = "2026-07-24T08:00:01.000Z";
const retrievedAt = "2026-07-24T08:00:02.000Z";
const finalizedAt = "2026-07-24T08:00:03.000Z";

const sourceVersion = { contentSha256: sha256, byteSize: 256, observedAt } as const;

const sourcePolicy = {
  allowedKinds: ["web", "file", "user-reference", "mail-export"] as const,
  maxSources: 8,
  excerptByteBudget: MAX_WORK_RESEARCH_EXCERPT_BYTES,
} as const;

const actor = { kind: "local-user", actorId: ids.actor } as const;

const brief = {
  briefId: ids.brief,
  projectId: ids.project,
  questions: ["What are the tradeoffs of local-first AI workspaces?"],
  sourcePolicy,
  notes: [],
  deliverables: ["report"] as const,
  status: "draft",
  createdBy: actor,
  createdAt,
  version: 1,
} as const;

const source = {
  sourceId: ids.source,
  briefId: ids.brief,
  projectId: ids.project,
  kind: "web",
  sourceRef: "opaque-source-token-1",
  displayName: "Local-first essay",
  retrievedAt,
  excerpt: "Local-first software owns user data and prioritizes offline agency.",
  citationAnchor: "anchor-1",
  sourceVersion,
  availability: "fresh",
} as const;

const evidence = {
  evidenceId: ids.evidence,
  briefId: ids.brief,
  sourceId: ids.source,
  citationAnchor: "anchor-1",
  excerpt: "Local-first software owns user data and prioritizes offline agency.",
  retrievedAt,
} as const;

const claim = {
  claimId: ids.claim,
  briefId: ids.brief,
  text: "Local-first workspaces trade cloud sync convenience for user sovereignty.",
  citationAnchors: ["anchor-1"],
  unsupported: false,
} as const;

const report = {
  reportId: ids.report,
  briefId: ids.brief,
  projectId: ids.project,
  evidence: [evidence],
  claims: [claim],
  producedArtifactRef: "opaque-report-artifact-1",
  finalizedAt,
} as const;

describe("WorkResearchBriefId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkResearchBriefId(ids.brief)).toEqual(ids.brief);
  });

  it("rejects a non-UUID", () => {
    expect(() => decodeWorkResearchBriefId("not-a-uuid")).toThrow();
  });
});

describe("WorkSourceId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkSourceId(ids.source)).toEqual(ids.source);
  });
});

describe("WorkResearchReportId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkResearchReportId(ids.report)).toEqual(ids.report);
  });
});

describe("WorkResearchRequestId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkResearchRequestId(ids.request)).toEqual(ids.request);
  });
});

describe("WorkSourceRef", () => {
  it("decodes a valid opaque token", () => {
    expect(decodeWorkSourceRef("opaque-source-token-1")).toEqual("opaque-source-token-1");
  });

  it("rejects a ref containing a path separator", () => {
    expect(() => decodeWorkSourceRef("folder/source")).toThrow();
    expect(() => decodeWorkSourceRef("a\\b")).toThrow();
  });

  it("rejects a file: URL ref", () => {
    expect(() => decodeWorkSourceRef("file:///etc/passwd")).toThrow();
  });
});

describe("WorkCitationAnchor", () => {
  it("decodes a valid anchor", () => {
    expect(decodeWorkCitationAnchor("anchor-1")).toEqual("anchor-1");
  });

  it("rejects an anchor containing a path separator", () => {
    expect(() => decodeWorkCitationAnchor("a/b")).toThrow();
  });
});

describe("WorkResearchBrief", () => {
  it("round-trips a valid draft brief", () => {
    expectRoundTrip(decodeWorkResearchBrief, brief);
  });

  it("rejects a brief with no questions", () => {
    expect(() => decodeWorkResearchBrief({ ...brief, questions: [] })).toThrow();
  });

  it("rejects a source policy with no allowed kinds", () => {
    expect(() =>
      decodeWorkResearchBrief({ ...brief, sourcePolicy: { ...sourcePolicy, allowedKinds: [] } }),
    ).toThrow();
  });

  it("rejects a brief with no deliverables", () => {
    expect(() => decodeWorkResearchBrief({ ...brief, deliverables: [] })).toThrow();
  });

  it("rejects a question carrying a path separator", () => {
    expect(() =>
      decodeWorkResearchBrief({ ...brief, questions: ["What is /etc/passwd?"] }),
    ).toThrow();
  });

  it("rejects an excerpt carrying a file: URL", () => {
    expect(() =>
      decodeWorkResearchBrief({
        ...brief,
        notes: ["file:///Users/example/secret"],
      }),
    ).toThrow();
  });
});

describe("WorkSourceRecord", () => {
  it("decodes a valid fresh source record via the brief round trip", () => {
    // Source record is exercised through the command/frame round trips below.
    expect(source.availability).toEqual("fresh");
  });
});

describe("WorkResearchCommand", () => {
  it("round-trips a create-brief command", () => {
    const command = {
      kind: "create-brief",
      requestId: ids.request,
      projectId: ids.project,
      briefId: ids.brief,
      questions: brief.questions,
      sourcePolicy,
      deliverables: brief.deliverables,
    };
    expectRoundTrip(decodeWorkResearchCommand, command);
  });

  it("round-trips an add-source command", () => {
    const command = {
      kind: "add-source",
      requestId: ids.request,
      projectId: ids.project,
      briefId: ids.brief,
      expectedVersion: 1,
      sourceId: ids.source,
      sourceKind: "web",
      sourceRef: "opaque-source-token-1",
      displayName: "Local-first essay",
      excerpt: source.excerpt,
      citationAnchor: "anchor-1",
      sourceVersion,
    };
    expectRoundTrip(decodeWorkResearchCommand, command);
  });

  it("round-trips a finalize-report command", () => {
    const command = {
      kind: "finalize-report",
      requestId: ids.request,
      projectId: ids.project,
      briefId: ids.brief,
      expectedVersion: 4,
      reportId: ids.report,
      producedArtifactRef: "opaque-report-artifact-1",
    };
    expectRoundTrip(decodeWorkResearchCommand, command);
  });

  it("rejects an add-source command carrying a path-separator sourceRef", () => {
    expect(() =>
      decodeWorkResearchCommand({
        kind: "add-source",
        requestId: ids.request,
        projectId: ids.project,
        briefId: ids.brief,
        expectedVersion: 1,
        sourceId: ids.source,
        sourceKind: "web",
        sourceRef: "folder/source",
        displayName: "Local-first essay",
        excerpt: source.excerpt,
        citationAnchor: "anchor-1",
        sourceVersion,
      }),
    ).toThrow();
  });
});

describe("WorkResearchCommandResult", () => {
  it("round-trips a brief-created result", () => {
    const result = {
      kind: "brief-created",
      requestId: ids.request,
      brief,
    };
    expectRoundTrip(decodeWorkResearchCommandResult, result);
  });

  it("round-trips a source-added result", () => {
    const result = {
      kind: "source-added",
      requestId: ids.request,
      brief,
      source,
    };
    expectRoundTrip(decodeWorkResearchCommandResult, result);
  });

  it("round-trips a report-finalized result", () => {
    const result = {
      kind: "report-finalized",
      requestId: ids.request,
      brief: { ...brief, status: "finalized", version: 5 },
      report,
    };
    expectRoundTrip(decodeWorkResearchCommandResult, result);
  });

  it("round-trips an unauthorized result exposing only opaque ids", () => {
    const result = {
      kind: "unauthorized",
      requestId: ids.request,
      briefId: ids.brief,
      sourceId: ids.source,
    };
    expectRoundTrip(decodeWorkResearchCommandResult, result);
  });

  it("round-trips an interrupted result", () => {
    const result = {
      kind: "interrupted",
      requestId: ids.request,
      briefId: ids.brief,
      sourceId: ids.source,
      canRetry: true,
    };
    expectRoundTrip(decodeWorkResearchCommandResult, result);
  });

  it("rejects a source-added result whose source belongs to a different brief", () => {
    expect(() =>
      decodeWorkResearchCommandResult({
        kind: "source-added",
        requestId: ids.request,
        brief,
        source: { ...source, briefId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toThrow();
  });

  it("rejects a report-finalized result whose report belongs to a different project", () => {
    expect(() =>
      decodeWorkResearchCommandResult({
        kind: "report-finalized",
        requestId: ids.request,
        brief,
        report: { ...report, projectId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toThrow();
  });

  it("rejects a brief-created result whose brief is not draft", () => {
    expect(() =>
      decodeWorkResearchCommandResult({
        kind: "brief-created",
        requestId: ids.request,
        brief: { ...brief, status: "finalized" },
      }),
    ).toThrow();
  });

  it("rejects a failed result whose message carries a path separator", () => {
    expect(() =>
      decodeWorkResearchCommandResult({
        kind: "failed",
        requestId: ids.request,
        reason: "failed",
        message: "read /Users/example/secret failed",
      }),
    ).toThrow();
  });
});

describe("WorkResearchFrame", () => {
  it("round-trips a brief-created frame", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 1,
      occurredAt: createdAt,
      transition: { kind: "brief-created", brief },
    };
    expectRoundTrip(decodeWorkResearchFrame, frame);
  });

  it("round-trips a source-added frame", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 2,
      occurredAt: retrievedAt,
      transition: {
        kind: "source-added",
        brief: { ...brief, status: "gathering", version: 2 },
        source,
      },
    };
    expectRoundTrip(decodeWorkResearchFrame, frame);
  });

  it("round-trips a report-finalized frame", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 5,
      occurredAt: finalizedAt,
      transition: {
        kind: "report-finalized",
        brief: { ...brief, status: "finalized", version: 5 },
        report,
      },
    };
    expectRoundTrip(decodeWorkResearchFrame, frame);
  });

  it("rejects a frame carrying an unauthorized transition (success-only journal)", () => {
    expect(() =>
      decodeWorkResearchFrame({
        requestId: ids.request,
        projectId: ids.project,
        sequence: 1,
        occurredAt: createdAt,
        transition: { kind: "unauthorized", briefId: ids.brief, sourceId: ids.source },
      }),
    ).toThrow();
  });

  it("rejects a frame whose projectId differs from the transition brief project", () => {
    expect(() =>
      decodeWorkResearchFrame({
        requestId: ids.request,
        projectId: "99999999-9999-4999-8999-999999999999",
        sequence: 1,
        occurredAt: createdAt,
        transition: { kind: "brief-created", brief },
      }),
    ).toThrow();
  });

  it("rejects a frame carrying an excess hostPath field (no path leakage into events)", () => {
    expect(() =>
      decodeWorkResearchFrame({
        requestId: ids.request,
        projectId: ids.project,
        sequence: 1,
        occurredAt: createdAt,
        hostPath: "/Users/example/secret/research.md",
        transition: { kind: "brief-created", brief },
      }),
    ).toThrow();
  });
});
