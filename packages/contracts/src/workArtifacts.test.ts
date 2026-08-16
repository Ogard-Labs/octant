import { describe, expect, it } from "vitest";
import {
  decodeWorkArtifactId,
  decodeWorkArtifactIdentity,
  decodeWorkArtifactMutationFrame,
  decodeWorkArtifactRef,
  decodeWorkArtifactVersion,
  decodeWorkArtifactVersionId,
  decodeWorkCapabilityReport,
  decodeWorkExportHandoff,
  decodeWorkFidelity,
  decodeWorkMutationReply,
  decodeWorkMutationRequest,
  decodeWorkMutationRequestId,
} from "./workArtifacts";

const ids = {
  artifact: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
  host: "55555555-5555-4555-8555-555555555555",
  target: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
} as const;

const sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
const observedAt = "2026-07-22T08:00:00.000Z";
const createdAt = "2026-07-22T08:00:01.000Z";
const producedAt = "2026-07-22T08:00:02.000Z";

const sourceVersion = { contentSha256: sha256, byteSize: 1024, observedAt } as const;

const artifactIdentity = {
  artifactId: ids.artifact,
  projectId: ids.project,
  format: "markdown",
  artifactRef: "opaque-artifact-token-1",
  displayName: "notes.md",
  createdAt,
} as const;

const artifactVersion = {
  versionId: ids.version,
  artifactId: ids.artifact,
  projectId: ids.project,
  format: "markdown",
  sourceVersion,
  createdBy: { kind: "local-user", actorId: ids.actor },
  createdAt,
  sequence: 1,
} as const;

const previewTarget = {
  targetId: ids.target,
  projectId: ids.project,
  hostId: ids.host,
  kind: "artifact-version",
  opaqueRef: "opaque-artifact-token-1",
  displayName: "notes.md",
} as const;

const fullCapabilities = {
  canRead: true,
  canCreate: true,
  canMutate: true,
  canRoundTrip: true,
  canExport: true,
  canVersion: true,
} as const;

describe("WorkArtifactId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkArtifactId(ids.artifact)).toEqual(ids.artifact);
  });

  it("rejects a non-UUID", () => {
    expect(() => decodeWorkArtifactId("not-a-uuid")).toThrow();
  });
});

describe("WorkArtifactRef", () => {
  it("decodes a valid opaque token", () => {
    expect(decodeWorkArtifactRef("opaque-artifact-token-1")).toEqual("opaque-artifact-token-1");
  });

  it("rejects a ref containing a path separator", () => {
    expect(() => decodeWorkArtifactRef("folder/report")).toThrow();
    expect(() => decodeWorkArtifactRef("a\\b")).toThrow();
  });

  it("rejects a ref that looks like a file URL", () => {
    expect(() => decodeWorkArtifactRef("file:///secret")).toThrow();
  });

  it("rejects an empty or whitespace ref", () => {
    expect(() => decodeWorkArtifactRef("  ")).toThrow();
  });
});

describe("WorkArtifactIdentity", () => {
  it("round-trips a valid artifact identity", () => {
    expect(decodeWorkArtifactIdentity(artifactIdentity)).toEqual(artifactIdentity);
  });

  it("rejects an identity carrying an excess hostPath field", () => {
    expect(() =>
      decodeWorkArtifactIdentity({ ...artifactIdentity, hostPath: "/Users/example/secret.md" }),
    ).toThrow();
  });

  it("rejects a displayName containing a path separator", () => {
    expect(() =>
      decodeWorkArtifactIdentity({ ...artifactIdentity, displayName: "folder/notes.md" }),
    ).toThrow();
  });

  it("rejects an unknown format", () => {
    expect(() => decodeWorkArtifactIdentity({ ...artifactIdentity, format: "rtf" })).toThrow();
  });
});

describe("WorkArtifactVersion", () => {
  it("round-trips a valid versioned artifact", () => {
    expect(decodeWorkArtifactVersion(artifactVersion)).toEqual(artifactVersion);
  });

  it("rejects a version with a zero sequence", () => {
    expect(() => decodeWorkArtifactVersion({ ...artifactVersion, sequence: 0 })).toThrow();
  });

  it("rejects a version carrying raw source bytes", () => {
    expect(() => decodeWorkArtifactVersion({ ...artifactVersion, rawBytes: "AAA" })).toThrow();
  });
});

describe("WorkMutationRequest", () => {
  it("decodes a create-artifact request", () => {
    const request = {
      kind: "create-artifact",
      requestId: ids.request,
      projectId: ids.project,
      format: "markdown",
      displayName: "notes.md",
      content: "# Hello",
    };
    expect(decodeWorkMutationRequest(request)).toEqual(request);
  });

  it("decodes a revise-artifact request with an expected version", () => {
    const request = {
      kind: "revise-artifact",
      requestId: ids.request,
      projectId: ids.project,
      artifactId: ids.artifact,
      content: "# Updated",
      expectedArtifactVersion: 3,
    };
    expect(decodeWorkMutationRequest(request)).toEqual(request);
  });

  it("decodes a transform-artifact request with an expected version", () => {
    const request = {
      kind: "transform-artifact",
      requestId: ids.request,
      projectId: ids.project,
      artifactId: ids.artifact,
      targetFormat: "markdown",
      expectedArtifactVersion: 1,
    };
    expect(decodeWorkMutationRequest(request)).toEqual(request);
  });

  it("decodes a delete-artifact request with an expected version", () => {
    const request = {
      kind: "delete-artifact",
      requestId: ids.request,
      projectId: ids.project,
      artifactId: ids.artifact,
      expectedArtifactVersion: 1,
    };
    expect(decodeWorkMutationRequest(request)).toEqual(request);
  });

  it("decodes an export-artifact request with an expected version", () => {
    const request = {
      kind: "export-artifact",
      requestId: ids.request,
      projectId: ids.project,
      artifactId: ids.artifact,
      exportFormat: "pdf",
      expectedArtifactVersion: 1,
    };
    expect(decodeWorkMutationRequest(request)).toEqual(request);
  });

  it("rejects unbacked handoff preferences on export requests", () => {
    expect(() =>
      decodeWorkMutationRequest({
        kind: "export-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        expectedArtifactVersion: 1,
        handoffPreference: "external-handoff",
      }),
    ).toThrow();
  });

  it("rejects a revise request that omits the required expectedArtifactVersion", () => {
    expect(() =>
      decodeWorkMutationRequest({
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: ids.artifact,
        content: "# Updated",
      }),
    ).toThrow();
  });

  it("rejects a transform request that omits the required expectedArtifactVersion", () => {
    expect(() =>
      decodeWorkMutationRequest({
        kind: "transform-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: ids.artifact,
        targetFormat: "markdown",
      }),
    ).toThrow();
  });

  it("rejects a delete request that omits the required expectedArtifactVersion", () => {
    expect(() =>
      decodeWorkMutationRequest({
        kind: "delete-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: ids.artifact,
      }),
    ).toThrow();
  });

  it("rejects a create request with a path-shaped displayName", () => {
    expect(() =>
      decodeWorkMutationRequest({
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "folder/notes.md",
        content: "# Hello",
      }),
    ).toThrow();
  });

  it("rejects an unknown mutation kind", () => {
    expect(() =>
      decodeWorkMutationRequest({
        kind: "archive-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: ids.artifact,
      }),
    ).toThrow();
  });
});

describe("WorkFidelity", () => {
  it("decodes a full fidelity report without a notice", () => {
    expect(decodeWorkFidelity({ level: "full" })).toEqual({ level: "full" });
  });

  it("decodes a limited fidelity report with a notice", () => {
    expect(decodeWorkFidelity({ level: "limited", notice: "Stored values only" })).toEqual({
      level: "limited",
      notice: "Stored values only",
    });
  });

  it("rejects a limited fidelity report without a notice", () => {
    expect(() => decodeWorkFidelity({ level: "limited" })).toThrow();
  });
});

describe("WorkCapabilityReport", () => {
  it("round-trips a valid capability report with export fallback formats", () => {
    const report = {
      format: "docx",
      capabilities: { ...fullCapabilities, canRoundTrip: false },
      fidelity: { level: "limited", notice: "Round-trip may lose layout" },
      exportFormats: ["markdown", "pdf"],
    };
    expect(decodeWorkCapabilityReport(report)).toEqual(report);
  });

  it("rejects a report carrying an excess field", () => {
    expect(() =>
      decodeWorkCapabilityReport({
        format: "markdown",
        capabilities: fullCapabilities,
        fidelity: { level: "full" },
        exportFormats: [],
        hostPath: "/secret",
      }),
    ).toThrow();
  });
});

describe("WorkExportHandoff", () => {
  it("decodes an in-app-version handoff feeding the preview surface", () => {
    const handoff = {
      requestId: ids.request,
      artifactId: ids.artifact,
      exportFormat: "pdf",
      handoffKind: "in-app-version",
      producedVersion: { ...artifactVersion, format: "pdf" },
      previewTarget,
      producedAt,
    };
    expect(decodeWorkExportHandoff(handoff)).toEqual(handoff);
  });

  it("decodes an external-handoff carrying an opaque export ref", () => {
    const handoff = {
      requestId: ids.request,
      artifactId: ids.artifact,
      exportFormat: "pdf",
      handoffKind: "external-handoff",
      exportRef: "opaque-export-token-1",
      producedAt,
    };
    expect(decodeWorkExportHandoff(handoff)).toEqual(handoff);
  });

  it("rejects an export ref containing a path separator", () => {
    expect(() =>
      decodeWorkExportHandoff({
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "external-handoff",
        exportRef: "folder/export.pdf",
        producedAt,
      }),
    ).toThrow();
  });

  it("rejects an in-app-version handoff whose producedVersion artifactId differs", () => {
    expect(() =>
      decodeWorkExportHandoff({
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "in-app-version",
        producedVersion: {
          ...artifactVersion,
          artifactId: "99999999-9999-4999-8999-999999999999",
        },
        previewTarget,
        producedAt,
      }),
    ).toThrow();
  });

  it("rejects an in-app-version handoff whose producedVersion format differs from exportFormat", () => {
    expect(() =>
      decodeWorkExportHandoff({
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "in-app-version",
        producedVersion: { ...artifactVersion, format: "markdown" },
        previewTarget,
        producedAt,
      }),
    ).toThrow();
  });

  it("rejects an in-app-version handoff whose previewTarget belongs to a different Project", () => {
    expect(() =>
      decodeWorkExportHandoff({
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "in-app-version",
        producedVersion: { ...artifactVersion, format: "pdf" },
        previewTarget: {
          ...previewTarget,
          projectId: "99999999-9999-4999-8999-999999999999",
        },
        producedAt,
      }),
    ).toThrow();
  });

  it("rejects an external-handoff that carries producedVersion (discriminated union)", () => {
    expect(() =>
      decodeWorkExportHandoff({
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "external-handoff",
        exportRef: "opaque-export-token-1",
        producedVersion: { ...artifactVersion, format: "pdf" },
        producedAt,
      }),
    ).toThrow();
  });

  it("rejects an external-handoff that carries previewTarget (discriminated union)", () => {
    expect(() =>
      decodeWorkExportHandoff({
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "external-handoff",
        exportRef: "opaque-export-token-1",
        previewTarget,
        producedAt,
      }),
    ).toThrow();
  });
});

describe("WorkMutationReply", () => {
  it("decodes a created reply that feeds the artifact-version preview target", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "created",
        artifact: artifactIdentity,
        version: artifactVersion,
        previewTarget,
      },
      capability: {
        format: "markdown",
        capabilities: fullCapabilities,
        fidelity: { level: "full" },
        exportFormats: [],
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("rejects a created reply whose refreshed capability format differs from the artifact format", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: artifactVersion,
          previewTarget,
        },
        capability: {
          format: "xlsx",
          capabilities: fullCapabilities,
          fidelity: { level: "limited", notice: "limited" },
          exportFormats: [],
        },
      }),
    ).toThrow();
  });

  it("rejects a created reply whose preview target is not an artifact-version", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: artifactVersion,
          previewTarget: { ...previewTarget, kind: "file" },
        },
      }),
    ).toThrow();
  });

  it("rejects a created reply whose preview target belongs to a different Project", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: artifactVersion,
          previewTarget: {
            ...previewTarget,
            projectId: "99999999-9999-4999-8999-999999999999",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a created reply whose version artifactId differs from the artifact", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: {
            ...artifactVersion,
            artifactId: "99999999-9999-4999-8999-999999999999",
          },
          previewTarget,
        },
      }),
    ).toThrow();
  });

  it("rejects a created reply whose version projectId differs from the artifact", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: {
            ...artifactVersion,
            projectId: "99999999-9999-4999-8999-999999999999",
          },
          previewTarget,
        },
      }),
    ).toThrow();
  });

  it("rejects a created reply whose version format differs from the artifact", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: { ...artifactVersion, format: "csv" },
          previewTarget,
        },
      }),
    ).toThrow();
  });

  it("rejects a created reply whose previewTarget displayName differs from the artifact", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: artifactVersion,
          previewTarget: { ...previewTarget, displayName: "different.md" },
        },
      }),
    ).toThrow();
  });

  it("decodes a revised reply carrying the new version and preview target", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "revised",
        artifact: artifactIdentity,
        version: { ...artifactVersion, sequence: 2 },
        previewTarget,
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("decodes an exported reply carrying the export handoff", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "exported",
        handoff: {
          requestId: ids.request,
          artifactId: ids.artifact,
          exportFormat: "pdf",
          handoffKind: "in-app-version",
          producedVersion: { ...artifactVersion, format: "pdf" },
          previewTarget,
          producedAt,
        },
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("rejects an exported reply whose handoff requestId differs from the reply requestId", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "exported",
          handoff: {
            requestId: "99999999-9999-4999-8999-999999999999",
            artifactId: ids.artifact,
            exportFormat: "pdf",
            handoffKind: "in-app-version",
            producedVersion: { ...artifactVersion, format: "pdf" },
            previewTarget,
            producedAt,
          },
        },
      }),
    ).toThrow();
  });

  it("decodes a deleted reply carrying the artifact id and last version evidence", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "deleted",
        artifactId: ids.artifact,
        projectId: ids.project,
        lastVersion: artifactVersion,
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("rejects a deleted reply whose lastVersion artifactId differs", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "deleted",
          artifactId: ids.artifact,
          projectId: ids.project,
          lastVersion: {
            ...artifactVersion,
            artifactId: "99999999-9999-4999-8999-999999999999",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a deleted reply whose lastVersion projectId differs", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "deleted",
          artifactId: ids.artifact,
          projectId: ids.project,
          lastVersion: {
            ...artifactVersion,
            projectId: "99999999-9999-4999-8999-999999999999",
          },
        },
      }),
    ).toThrow();
  });

  it("decodes an unauthorized reply that exposes no content-derived metadata", () => {
    const reply = { requestId: ids.request, outcome: { kind: "unauthorized" } };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: { kind: "unauthorized", displayName: "secret" },
      }),
    ).toThrow();
  });

  it("decodes a stale reply referencing the known source version", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "stale",
        artifactId: ids.artifact,
        knownVersion: sourceVersion,
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("decodes a locked reply without persisting a password", () => {
    const reply = {
      requestId: ids.request,
      outcome: { kind: "locked", artifactId: ids.artifact, canOpenExternally: true },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "locked",
          artifactId: ids.artifact,
          canOpenExternally: true,
          password: "hunter2",
        },
      }),
    ).toThrow();
  });

  it("decodes an unsupported reply naming the format and external handoff flag", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "unsupported",
        format: "docx",
        canOpenExternally: true,
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("decodes an interrupted reply with a retry flag", () => {
    const reply = {
      requestId: ids.request,
      outcome: { kind: "interrupted", artifactId: ids.artifact, canRetry: true },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("decodes a failed reply with a bounded reason code and sanitized message", () => {
    const reply = {
      requestId: ids.request,
      outcome: {
        kind: "failed",
        artifactId: ids.artifact,
        reason: "write-failed",
        message: "Disk full",
      },
    };
    expect(decodeWorkMutationReply(reply)).toEqual(reply);
  });

  it("rejects a failed reply whose message leaks a path", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "failed",
          artifactId: ids.artifact,
          reason: "write-failed",
          message: "/Users/example/secret/report.pdf",
        },
      }),
    ).toThrow();
  });

  it("rejects a failed reply with an unknown reason code", () => {
    expect(() =>
      decodeWorkMutationReply({
        requestId: ids.request,
        outcome: {
          kind: "failed",
          artifactId: ids.artifact,
          reason: "disk-on-fire",
          message: "Disk full",
        },
      }),
    ).toThrow();
  });
});

describe("WorkMutationRequestId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkMutationRequestId(ids.request)).toEqual(ids.request);
  });

  it("rejects a non-UUID", () => {
    expect(() => decodeWorkMutationRequestId("not-a-uuid")).toThrow();
  });
});

describe("WorkArtifactVersionId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkArtifactVersionId(ids.version)).toEqual(ids.version);
  });
});

describe("WorkArtifactMutationFrame", () => {
  it("round-trips a created mutation frame carrying the sanitized outcome", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 1,
      occurredAt: createdAt,
      outcome: {
        kind: "created" as const,
        artifact: artifactIdentity,
        version: artifactVersion,
        previewTarget,
      },
    };
    expect(decodeWorkArtifactMutationFrame(frame)).toEqual(frame);
  });

  it("round-trips a revised mutation frame carrying the new version", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 2,
      occurredAt: createdAt,
      outcome: {
        kind: "revised" as const,
        artifact: artifactIdentity,
        version: { ...artifactVersion, sequence: 2 },
        previewTarget,
      },
    };
    expect(decodeWorkArtifactMutationFrame(frame)).toEqual(frame);
  });

  it("round-trips a deleted mutation frame carrying the last version evidence", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 1,
      occurredAt: createdAt,
      outcome: {
        kind: "deleted" as const,
        artifactId: ids.artifact,
        projectId: ids.project,
        lastVersion: artifactVersion,
      },
    };
    expect(decodeWorkArtifactMutationFrame(frame)).toEqual(frame);
  });

  it("round-trips an exported mutation frame carrying the in-app-version handoff", () => {
    const frame = {
      requestId: ids.request,
      projectId: ids.project,
      sequence: 1,
      occurredAt: createdAt,
      outcome: {
        kind: "exported" as const,
        handoff: {
          requestId: ids.request,
          artifactId: ids.artifact,
          exportFormat: "pdf",
          handoffKind: "in-app-version",
          producedVersion: { ...artifactVersion, format: "pdf" },
          previewTarget,
          producedAt,
        },
      },
    };
    expect(decodeWorkArtifactMutationFrame(frame)).toEqual(frame);
  });

  it("rejects a frame carrying a failure outcome (success-only journal)", () => {
    expect(() =>
      decodeWorkArtifactMutationFrame({
        requestId: ids.request,
        projectId: ids.project,
        sequence: 1,
        occurredAt: createdAt,
        outcome: { kind: "failed", artifactId: ids.artifact, reason: "write-failed" },
      }),
    ).toThrow();
  });

  it("rejects a frame carrying an unsupported outcome (success-only journal)", () => {
    expect(() =>
      decodeWorkArtifactMutationFrame({
        requestId: ids.request,
        projectId: ids.project,
        sequence: 1,
        occurredAt: createdAt,
        outcome: { kind: "unsupported", format: "docx", canOpenExternally: true },
      }),
    ).toThrow();
  });

  it("rejects a frame whose projectId differs from the created artifact's project", () => {
    expect(() =>
      decodeWorkArtifactMutationFrame({
        requestId: ids.request,
        projectId: "99999999-9999-4999-8999-999999999999",
        sequence: 1,
        occurredAt: createdAt,
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: artifactVersion,
          previewTarget,
        },
      }),
    ).toThrow();
  });

  it("rejects a frame carrying an excess hostPath field (no path leakage into events)", () => {
    expect(() =>
      decodeWorkArtifactMutationFrame({
        requestId: ids.request,
        projectId: ids.project,
        sequence: 1,
        occurredAt: createdAt,
        hostPath: "/Users/example/secret/report.md",
        outcome: {
          kind: "created",
          artifact: artifactIdentity,
          version: artifactVersion,
          previewTarget,
        },
      }),
    ).toThrow();
  });
});
