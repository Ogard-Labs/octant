import { describe, expect, it } from "vitest";
import type { UtcTimestamp } from "@octant/contracts/events";
import { decodeContentSha256 } from "@octant/contracts/previews";
import type {
  WorkArtifactFormat,
  WorkCapabilityFlags,
  WorkCapabilityReport,
  WorkFidelity,
} from "@octant/contracts/work-artifacts";
import {
  canonicalizeWorkRelativePath,
  classifyWorkFidelity,
  classifyWorkSourceAvailability,
  classifyDestructiveChange,
  classifyMutationAuthority,
  classifyPathContainment,
  classifySymlinkContainment,
  WorkConfinementRejected,
  detectMovedRoot,
  detectRevokedRoot,
  resolveWorkCapabilities,
} from "./workConfinementPolicy";

const sha = decodeContentSha256("0000000000000000000000000000000000000000000000000000000000000000");
const observedAt = "2026-07-22T08:00:00.000Z" as UtcTimestamp;

const fullCapabilities: WorkCapabilityFlags = {
  canRead: true,
  canCreate: true,
  canMutate: true,
  canRoundTrip: true,
  canExport: true,
  canVersion: true,
};

function report(
  format: WorkArtifactFormat,
  overrides: Partial<WorkCapabilityReport> = {},
): WorkCapabilityReport {
  return {
    format,
    capabilities: fullCapabilities,
    fidelity: { level: "full" },
    exportFormats: [],
    ...overrides,
  };
}

describe("canonicalizeWorkRelativePath", () => {
  it("canonicalizes a simple posix relative path", () => {
    expect(canonicalizeWorkRelativePath("reports/2026/q1.md")).toBe("reports/2026/q1.md");
  });

  it("collapses single-dot segments and rejects parent traversal", () => {
    expect(canonicalizeWorkRelativePath("reports/./q1.md")).toBe("reports/q1.md");
    expect(() => canonicalizeWorkRelativePath("reports/../secret.md")).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => canonicalizeWorkRelativePath("/etc/passwd")).toThrow();
  });

  it("rejects a backslash separator", () => {
    expect(() => canonicalizeWorkRelativePath("folder\\secret.md")).toThrow();
  });

  it("rejects a null byte", () => {
    expect(() => canonicalizeWorkRelativePath("repo\0rt.md")).toThrow();
  });

  it("rejects a trailing separator", () => {
    expect(() => canonicalizeWorkRelativePath("reports/")).toThrow();
  });

  it("rejects an empty path", () => {
    expect(() => canonicalizeWorkRelativePath("")).toThrow();
  });

  it("rejects a non-NFC path", () => {
    expect(() => canonicalizeWorkRelativePath("cafe\u0301.md")).toThrow();
  });
});

describe("classifyPathContainment", () => {
  const root = "/Users/example/Work/ProjectA";

  it("classifies a path strictly inside the root as contained", () => {
    expect(classifyPathContainment(root, `${root}/reports/q1.md`)).toBe("contained");
  });

  it("classifies the root itself as contained", () => {
    expect(classifyPathContainment(root, root)).toBe("contained");
  });

  it("rejects a sibling path that shares a prefix but is not inside the root", () => {
    expect(classifyPathContainment(root, "/Users/example/Work/ProjectA-secret/x.md")).toBe(
      "escapes-root",
    );
  });

  it("rejects a path outside the root entirely", () => {
    expect(classifyPathContainment(root, "/etc/passwd")).toBe("escapes-root");
  });

  it("treats a trailing-slash root equivalently", () => {
    expect(classifyPathContainment(`${root}/`, `${root}/x.md`)).toBe("contained");
  });

  it("rejects a filesystem-root canonical root as escapes-root for any candidate", () => {
    expect(classifyPathContainment("/", "/Users/example/secret.md")).toBe("escapes-root");
  });

  it("rejects a filesystem-root canonical root even for the root itself", () => {
    expect(classifyPathContainment("/", "/")).toBe("escapes-root");
  });
});

describe("classifySymlinkContainment", () => {
  const root = "/Users/example/Work/ProjectA";

  it("classifies a symlink whose target is inside the root as contained", () => {
    expect(classifySymlinkContainment(root, `${root}/linked/notes.md`)).toBe("contained");
  });

  it("rejects a symlink whose target escapes the root", () => {
    expect(classifySymlinkContainment(root, "/Users/example/secrets/notes.md")).toBe(
      "escapes-root",
    );
  });
});

describe("detectMovedRoot", () => {
  it("reports moved when the canonical root changed since the artifact ref was minted", () => {
    expect(
      detectMovedRoot(
        { canonicalRoot: "/Users/example/Work/ProjectA" },
        { canonicalRoot: "/Users/example/Work/ProjectA-moved" },
      ),
    ).toBe(true);
  });

  it("reports not moved when the canonical root is unchanged", () => {
    expect(
      detectMovedRoot(
        { canonicalRoot: "/Users/example/Work/ProjectA" },
        { canonicalRoot: "/Users/example/Work/ProjectA" },
      ),
    ).toBe(false);
  });
});

describe("detectRevokedRoot", () => {
  it("reports revoked with binding-unavailable when the binding availability is unavailable", () => {
    expect(detectRevokedRoot({ availability: "unavailable", bindingSuperseded: false })).toEqual({
      status: "revoked",
      reason: "binding-unavailable",
    });
  });

  it("reports revoked with binding-superseded when the binding receipt was superseded", () => {
    expect(detectRevokedRoot({ availability: "available", bindingSuperseded: true })).toEqual({
      status: "revoked",
      reason: "binding-superseded",
    });
  });

  it("reports available when the binding is available and not superseded", () => {
    expect(detectRevokedRoot({ availability: "available", bindingSuperseded: false })).toEqual({
      status: "available",
    });
  });

  it("reports revoked with binding-unverified when the binding availability is unverified", () => {
    expect(detectRevokedRoot({ availability: "unverified", bindingSuperseded: false })).toEqual({
      status: "revoked",
      reason: "binding-unverified",
    });
  });

  it("reports revoked with binding-unverified even when the binding receipt was also superseded", () => {
    expect(detectRevokedRoot({ availability: "unverified", bindingSuperseded: true })).toEqual({
      status: "revoked",
      reason: "binding-unverified",
    });
  });
});

describe("classifyDestructiveChange", () => {
  it("classifies a delete as destructive and requiring approval", () => {
    const result = classifyDestructiveChange({ kind: "delete" });
    expect(result.change).toBe("destructive");
    expect(result.requiresApproval).toBe(true);
  });

  it("classifies a lossy transform (docx -> markdown) as lossy and requiring approval", () => {
    const result = classifyDestructiveChange({
      kind: "transform",
      format: "docx",
      targetFormat: "markdown",
    });
    expect(result.change).toBe("lossy");
    expect(result.requiresApproval).toBe(true);
  });

  it("classifies a same-format transform as safe", () => {
    const result = classifyDestructiveChange({
      kind: "transform",
      format: "markdown",
      targetFormat: "markdown",
    });
    expect(result.change).toBe("safe");
    expect(result.requiresApproval).toBe(false);
  });

  it("fails closed to lossy requiring approval when the source format is unknown", () => {
    const result = classifyDestructiveChange({
      kind: "transform",
      targetFormat: "markdown",
    });
    expect(result.requiresApproval).toBe(true);
  });

  it("fails closed to lossy requiring approval when the target format is unknown", () => {
    const result = classifyDestructiveChange({
      kind: "transform",
      format: "docx",
    });
    expect(result.requiresApproval).toBe(true);
  });

  it("classifies a create as safe and not requiring approval", () => {
    expect(classifyDestructiveChange({ kind: "create" })).toEqual({
      change: "safe",
      requiresApproval: false,
    });
  });

  it("classifies a revise as safe because prior versions are retained", () => {
    expect(classifyDestructiveChange({ kind: "revise" }).change).toBe("safe");
  });

  it("classifies an export as safe because it produces a derived copy", () => {
    expect(classifyDestructiveChange({ kind: "export" }).change).toBe("safe");
  });

  it("classifies a rename as safe", () => {
    expect(classifyDestructiveChange({ kind: "rename" }).change).toBe("safe");
  });

  it("classifies a version snapshot as safe", () => {
    expect(classifyDestructiveChange({ kind: "version" }).change).toBe("safe");
  });
});

describe("classifyWorkFidelity", () => {
  it("classifies office formats as inherently limited", () => {
    expect(classifyWorkFidelity("docx", false).level).toBe("limited");
    expect(classifyWorkFidelity("xlsx", false).level).toBe("limited");
    expect(classifyWorkFidelity("pptx", false).level).toBe("limited");
  });

  it("classifies plain formats as full when no budget is exceeded", () => {
    expect(classifyWorkFidelity("markdown", false)).toEqual<WorkFidelity>({ level: "full" });
    expect(classifyWorkFidelity("csv", false)).toEqual<WorkFidelity>({ level: "full" });
    expect(classifyWorkFidelity("image", false)).toEqual<WorkFidelity>({ level: "full" });
  });

  it("downgrades to limited with a notice when a configured budget is exceeded", () => {
    const fidelity = classifyWorkFidelity("markdown", true);
    expect(fidelity.level).toBe("limited");
    expect(fidelity.notice).toBeDefined();
  });

  it("carries an actionable notice for inherently limited office formats", () => {
    const fidelity = classifyWorkFidelity("xlsx", false);
    expect(fidelity.level).toBe("limited");
    expect(fidelity.notice).toBeDefined();
  });
});

describe("resolveWorkCapabilities", () => {
  it("preserves all base capabilities in full posture", () => {
    expect(resolveWorkCapabilities({ posture: "full", base: fullCapabilities })).toEqual(
      fullCapabilities,
    );
  });

  it("preserves read and version capabilities in approval-gated posture but reports mutation capabilities for approval", () => {
    const resolved = resolveWorkCapabilities({
      posture: "approval-gated",
      base: fullCapabilities,
    });
    expect(resolved.canRead).toBe(true);
    expect(resolved.canVersion).toBe(true);
    expect(resolved.canCreate).toBe(true);
    expect(resolved.canMutate).toBe(true);
    expect(resolved.canExport).toBe(true);
  });

  it("never reports a capability the base format does not support", () => {
    const resolved = resolveWorkCapabilities({
      posture: "full",
      base: { ...fullCapabilities, canRoundTrip: false, canExport: false },
    });
    expect(resolved.canRoundTrip).toBe(false);
    expect(resolved.canExport).toBe(false);
  });
});

describe("classifyMutationAuthority", () => {
  const baseInput = {
    posture: "full" as const,
    mutationKind: "create" as const,
    capability: report("markdown"),
    change: { change: "safe" as const, requiresApproval: false },
    rootRevocation: { status: "available" as const },
    pathContainment: "contained" as const,
    rootMoved: false,
    sourceAvailability: "available" as const,
    transformTarget: undefined as WorkArtifactFormat | undefined,
    exportFormat: undefined as WorkArtifactFormat | undefined,
  };

  it("allows a safe, supported, contained create in full posture", () => {
    expect(classifyMutationAuthority(baseInput)).toBe("allow");
  });

  it("denies when the root has been revoked", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        rootRevocation: { status: "revoked", reason: "binding-unavailable" },
      }),
    ).toBe("deny");
  });

  it("denies when the candidate path escapes the root", () => {
    expect(classifyMutationAuthority({ ...baseInput, pathContainment: "escapes-root" })).toBe(
      "deny",
    );
  });

  it("denies when the format does not support the mutation kind", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "create",
        capability: report("markdown", {
          capabilities: { ...fullCapabilities, canCreate: false },
        }),
      }),
    ).toBe("deny");
  });

  it("requires approval for a destructive delete even in full posture", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "delete",
        change: { change: "destructive", requiresApproval: true },
      }),
    ).toBe("needs-approval");
  });

  it("requires approval for a lossy transform even in full posture", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "transform",
        capability: report("docx", {
          capabilities: { ...fullCapabilities, canRoundTrip: false },
          exportFormats: ["markdown"],
        }),
        transformTarget: "markdown",
        change: { change: "lossy", requiresApproval: true },
      }),
    ).toBe("needs-approval");
  });

  it("denies export when the format reports canExport false", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "export",
        capability: report("pdf", {
          capabilities: { ...fullCapabilities, canExport: false },
        }),
      }),
    ).toBe("deny");
  });

  it("requires approval for a safe create in approval-gated posture (agent-initiated side effects need approval)", () => {
    expect(classifyMutationAuthority({ ...baseInput, posture: "approval-gated" })).toBe(
      "needs-approval",
    );
  });

  it("requires approval for a safe revise in approval-gated posture", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        posture: "approval-gated",
        mutationKind: "revise",
      }),
    ).toBe("needs-approval");
  });

  it("denies when the Work root has moved since the artifact reference was minted", () => {
    expect(classifyMutationAuthority({ ...baseInput, rootMoved: true })).toBe("deny");
  });

  it("denies a transform to an unsupported target format not in exportFormats and not same-format", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "transform",
        capability: report("docx", {
          capabilities: { ...fullCapabilities, canRoundTrip: false },
          exportFormats: ["markdown", "pdf"],
        }),
        transformTarget: "xlsx",
        change: { change: "safe", requiresApproval: false },
      }),
    ).toBe("deny");
  });

  it("allows a transform to an advertised export format", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "transform",
        capability: report("docx", {
          capabilities: { ...fullCapabilities, canRoundTrip: false },
          exportFormats: ["markdown", "pdf"],
        }),
        transformTarget: "markdown",
        change: { change: "lossy", requiresApproval: true },
      }),
    ).toBe("needs-approval");
  });

  it("allows a same-format transform when canRoundTrip is true", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "transform",
        capability: report("docx", {
          capabilities: fullCapabilities,
          exportFormats: [],
        }),
        transformTarget: "docx",
        change: { change: "safe", requiresApproval: false },
      }),
    ).toBe("allow");
  });

  it("denies a same-format transform when canRoundTrip is false", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "transform",
        capability: report("docx", {
          capabilities: { ...fullCapabilities, canRoundTrip: false },
          exportFormats: [],
        }),
        transformTarget: "docx",
        change: { change: "safe", requiresApproval: false },
      }),
    ).toBe("deny");
  });

  it("denies a non-create mutation when the source is stale", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "revise",
        sourceAvailability: "stale",
      }),
    ).toBe("deny");
  });

  it("denies a non-create mutation when the source is unavailable", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "delete",
        sourceAvailability: "unavailable",
      }),
    ).toBe("deny");
  });

  it("allows a create mutation regardless of source availability (no prior source)", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "create",
        sourceAvailability: "unavailable",
      }),
    ).toBe("allow");
  });

  it("denies an export to a format not in exportFormats", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "export",
        capability: report("docx", {
          capabilities: fullCapabilities,
          exportFormats: ["markdown", "pdf"],
        }),
        exportFormat: "xlsx",
      }),
    ).toBe("deny");
  });

  it("allows an export to an advertised export format", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "export",
        capability: report("docx", {
          capabilities: fullCapabilities,
          exportFormats: ["markdown", "pdf"],
        }),
        exportFormat: "pdf",
      }),
    ).toBe("allow");
  });

  it("denies an export when exportFormat is not supplied", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "export",
        capability: report("docx", {
          capabilities: fullCapabilities,
          exportFormats: ["markdown"],
        }),
      }),
    ).toBe("deny");
  });

  it("requires approval for a safe revise on a limited-fidelity format in full posture", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "revise",
        capability: report("docx", {
          capabilities: fullCapabilities,
          fidelity: { level: "limited", notice: "Office round-trip is limited" },
          exportFormats: [],
        }),
        change: { change: "safe", requiresApproval: false },
      }),
    ).toBe("needs-approval");
  });

  it("requires approval for a safe create on a limited-fidelity format in full posture", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "create",
        capability: report("xlsx", {
          capabilities: fullCapabilities,
          fidelity: { level: "limited", notice: "Workbook round-trip is limited" },
          exportFormats: [],
        }),
      }),
    ).toBe("needs-approval");
  });

  it("allows a safe revise on a full-fidelity format in full posture", () => {
    expect(
      classifyMutationAuthority({
        ...baseInput,
        mutationKind: "revise",
        capability: report("markdown", {
          capabilities: fullCapabilities,
          fidelity: { level: "full" },
          exportFormats: [],
        }),
      }),
    ).toBe("allow");
  });
});

describe("WorkConfinementRejected", () => {
  it("carries a typed rejection code", () => {
    try {
      canonicalizeWorkRelativePath("../escape");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkConfinementRejected);
      expect((error as WorkConfinementRejected).code).toBe("traversal-rejected");
    }
  });
});

describe("classifyWorkSourceAvailability", () => {
  const version = { contentSha256: sha, byteSize: 1024, observedAt };
  const changed = {
    contentSha256: decodeContentSha256(
      "1111111111111111111111111111111111111111111111111111111111111111",
    ),
    byteSize: 2048,
    observedAt,
  };

  it("reports unavailable when no current source version exists", () => {
    expect(classifyWorkSourceAvailability(undefined, version)).toBe("unavailable");
  });

  it("reports available when current matches the known version", () => {
    expect(classifyWorkSourceAvailability(version, version)).toBe("available");
  });

  it("reports stale when current differs from the known version", () => {
    expect(classifyWorkSourceAvailability(changed, version)).toBe("stale");
  });
});
