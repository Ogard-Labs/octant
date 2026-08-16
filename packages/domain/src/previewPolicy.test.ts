import { describe, expect, it } from "vitest";
import type { UtcTimestamp } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeCodeThreadId } from "@octant/contracts/code";
import {
  decodeContentSha256,
  decodePreviewHostId,
  decodePreviewManifest,
  decodePreviewSelection,
  decodePreviewSourceVersion,
  decodePreviewTarget,
  decodePreviewTargetId,
  type PreviewCapabilityFlags,
  type PreviewManifest,
  type PreviewSourceVersion,
  type PreviewTarget,
} from "@octant/contracts/previews";
import {
  classifyFidelity,
  classifyPreviewTabAuthority,
  classifySourceAvailability,
  classifyViewerStateRestore,
  resolvePreviewCapabilities,
  validatePreviewSelection,
  authorizePreviewHandoff,
  authorizePreviewTarget,
} from "./previewPolicy";

const ids = {
  target: decodePreviewTargetId("11111111-1111-4111-8111-111111111111"),
  otherTarget: decodePreviewTargetId("55555555-5555-4555-8555-555555555555"),
  project: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  otherProject: decodeProjectId("33333333-3333-4333-8333-333333333333"),
  host: decodePreviewHostId("44444444-4444-4444-8444-444444444444"),
  otherHost: decodePreviewHostId("66666666-6666-4666-8666-666666666666"),
  codeThread: decodeCodeThreadId("77777777-7777-4777-8777-777777777777"),
  otherThread: decodeCodeThreadId("88888888-8888-4888-8888-888888888888"),
} as const;

const observedAt = "2026-07-22T08:00:00.000Z" as UtcTimestamp;
const producedAt = "2026-07-22T08:00:01.000Z" as UtcTimestamp;

const version: PreviewSourceVersion = decodePreviewSourceVersion({
  contentSha256: decodeContentSha256(
    "0000000000000000000000000000000000000000000000000000000000000000",
  ),
  byteSize: 1024,
  observedAt,
});
const changedVersion: PreviewSourceVersion = decodePreviewSourceVersion({
  contentSha256: decodeContentSha256(
    "1111111111111111111111111111111111111111111111111111111111111111",
  ),
  byteSize: 2048,
  observedAt,
});

const fullCapabilities: PreviewCapabilityFlags = {
  canSearch: true,
  canSelect: true,
  canZoom: true,
  canRevealInFinder: true,
  canOpenExternally: true,
  canQuickLook: true,
  canEditInMonaco: true,
};

function target(
  overrides: Partial<PreviewTarget> & { kind: PreviewTarget["kind"]; projectId?: string },
): PreviewTarget {
  const { kind, projectId, hostId, boundCodeThreadId, ...rest } = overrides;
  return decodePreviewTarget({
    targetId: ids.target,
    projectId: (projectId ?? ids.project) as PreviewTarget["projectId"],
    hostId: hostId ?? ids.host,
    kind,
    opaqueRef: "opaque-ref-token-1",
    displayName: "report.pdf",
    ...(boundCodeThreadId !== undefined ? { boundCodeThreadId } : {}),
    ...rest,
  });
}

function manifest(
  overrides: Partial<PreviewManifest> & { kind: PreviewManifest["kind"] },
): PreviewManifest {
  const { kind, ...rest } = overrides;
  return decodePreviewManifest({
    target: target({ kind: "file" }),
    sourceVersion: version,
    kind,
    sniffedMediaType: "application/pdf",
    byteSize: 1024,
    fidelity: { level: "full" },
    capabilities: fullCapabilities,
    bounds: { pages: 4 },
    producedAt,
    ...rest,
  });
}

describe("authorizePreviewTarget", () => {
  it("allows a Work file target inside the active Work Project", () => {
    expect(
      authorizePreviewTarget({
        mode: "work",
        projectType: "work",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", projectId: ids.project }),
      }),
    ).toBe("allow");
  });

  it("allows a Code repository file target inside the active Code Project", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", projectId: ids.project }),
      }),
    ).toBe("allow");
  });

  it("allows a Chat attachment target inside the active Chat Project", () => {
    expect(
      authorizePreviewTarget({
        mode: "chat",
        projectType: "chat",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "attachment", projectId: ids.project }),
      }),
    ).toBe("allow");
  });

  it("denies a Chat file target because Chat has no implicit filesystem access", () => {
    expect(
      authorizePreviewTarget({
        mode: "chat",
        projectType: "chat",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", projectId: ids.project }),
      }),
    ).toBe("deny");
  });

  it("denies a target belonging to a different Project than the active one", () => {
    expect(
      authorizePreviewTarget({
        mode: "work",
        projectType: "work",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", projectId: ids.otherProject }),
      }),
    ).toBe("deny");
  });

  it("denies when the active mode does not match the Project type", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "work",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", projectId: ids.project }),
      }),
    ).toBe("deny");
  });

  it("allows a validation-evidence target in Code and Work but not Chat", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "validation-evidence", projectId: ids.project }),
      }),
    ).toBe("allow");
    expect(
      authorizePreviewTarget({
        mode: "chat",
        projectType: "chat",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "validation-evidence", projectId: ids.project }),
      }),
    ).toBe("deny");
  });
});

describe("authorizePreviewHandoff", () => {
  const authorized = {
    mode: "work" as const,
    projectType: "work" as const,
    activeProjectId: ids.project,
    activeHostId: ids.host,
    target: target({ kind: "file", projectId: ids.project }),
  };

  it("allows a handoff from a local window with a non-plan posture", () => {
    expect(
      authorizePreviewHandoff({
        ...authorized,
        posture: "approval-gated",
        principalKind: "local-window",
      }),
    ).toBe("allow");
    expect(
      authorizePreviewHandoff({
        ...authorized,
        posture: "full",
        principalKind: "local-window",
      }),
    ).toBe("allow");
  });

  it("fails closed in plan mode even for a fully authorized local target", () => {
    expect(
      authorizePreviewHandoff({
        ...authorized,
        posture: "plan",
        principalKind: "local-window",
      }),
    ).toBe("deny");
  });

  it("fails closed for remote least-authority principals even outside plan mode", () => {
    expect(
      authorizePreviewHandoff({
        ...authorized,
        posture: "full",
        principalKind: "remote-device",
      }),
    ).toBe("deny");
  });

  it("fails closed in plan mode for remote principals", () => {
    expect(
      authorizePreviewHandoff({
        ...authorized,
        posture: "plan",
        principalKind: "remote-device",
      }),
    ).toBe("deny");
  });

  it("fails closed when the underlying target authority denies", () => {
    expect(
      authorizePreviewHandoff({
        ...authorized,
        target: target({ kind: "file", projectId: ids.otherProject }),
        posture: "full",
        principalKind: "local-window",
      }),
    ).toBe("deny");
  });

  it("fails closed when the active mode does not match the Project type", () => {
    expect(
      authorizePreviewHandoff({
        ...authorized,
        mode: "code",
        projectType: "work",
        posture: "full",
        principalKind: "local-window",
      }),
    ).toBe("deny");
  });

  it("fails closed for a Code target bound to a different active thread", () => {
    expect(
      authorizePreviewHandoff({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        activeThreadId: ids.codeThread,
        target: target({
          kind: "file",
          projectId: ids.project,
          boundCodeThreadId: ids.otherThread,
        }),
        posture: "full",
        principalKind: "local-window",
      }),
    ).toBe("deny");
    expect(
      authorizePreviewHandoff({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({
          kind: "file",
          projectId: ids.project,
          boundCodeThreadId: ids.codeThread,
        }),
        posture: "full",
        principalKind: "local-window",
      }),
    ).toBe("deny");
  });
});

describe("resolvePreviewCapabilities", () => {
  it("preserves in-renderer read-only capabilities in plan mode but removes edit and all host handoff", () => {
    const resolved = resolvePreviewCapabilities({
      mode: "code",
      posture: "plan",
      kind: "text",
      baseCapabilities: fullCapabilities,
    });
    expect(resolved.canSearch).toBe(true);
    expect(resolved.canSelect).toBe(true);
    expect(resolved.canZoom).toBe(true);
    expect(resolved.canRevealInFinder).toBe(false);
    expect(resolved.canQuickLook).toBe(false);
    expect(resolved.canEditInMonaco).toBe(false);
    expect(resolved.canOpenExternally).toBe(false);
  });

  it("enables Monaco edit only for text in full posture, never in plan mode", () => {
    expect(
      resolvePreviewCapabilities({
        mode: "code",
        posture: "full",
        kind: "text",
        baseCapabilities: fullCapabilities,
      }).canEditInMonaco,
    ).toBe(true);
    expect(
      resolvePreviewCapabilities({
        mode: "code",
        posture: "approval-gated",
        kind: "text",
        baseCapabilities: fullCapabilities,
      }).canEditInMonaco,
    ).toBe(false);
    expect(
      resolvePreviewCapabilities({
        mode: "code",
        posture: "full",
        kind: "pdf",
        baseCapabilities: fullCapabilities,
      }).canEditInMonaco,
    ).toBe(false);
  });

  it("never reports a capability the base format does not support", () => {
    const resolved = resolvePreviewCapabilities({
      mode: "work",
      posture: "full",
      kind: "image",
      baseCapabilities: { ...fullCapabilities, canEditInMonaco: false, canSearch: false },
    });
    expect(resolved.canEditInMonaco).toBe(false);
    expect(resolved.canSearch).toBe(false);
  });
});

describe("classifyFidelity", () => {
  it("classifies unsupported kinds as limited with a fallback notice", () => {
    expect(classifyFidelity("unsupported", false)).toEqual({
      level: "limited",
      notice: "No safe in-app viewer for this format",
    });
  });

  it("classifies office formats as inherently limited", () => {
    expect(classifyFidelity("workbook", false).level).toBe("limited");
    expect(classifyFidelity("document", false).level).toBe("limited");
    expect(classifyFidelity("slides", false).level).toBe("limited");
  });

  it("classifies text and image as full when no budget is exceeded", () => {
    expect(classifyFidelity("text", false)).toEqual({ level: "full" });
    expect(classifyFidelity("image", false)).toEqual({ level: "full" });
  });

  it("downgrades to limited when a configured budget is exceeded", () => {
    expect(classifyFidelity("text", true).level).toBe("limited");
  });
});

describe("validatePreviewSelection", () => {
  it("accepts an in-bounds text selection bound to the manifest source version", () => {
    const selection = decodePreviewSelection({
      kind: "text",
      targetId: ids.target,
      sourceVersion: version,
      startLine: 1,
      endLine: 4,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "text" }))).toEqual({ ok: true });
  });

  it("rejects a selection whose source version differs from the manifest", () => {
    const selection = decodePreviewSelection({
      kind: "text",
      targetId: ids.target,
      sourceVersion: changedVersion,
      startLine: 1,
      endLine: 4,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "text" }))).toEqual({
      ok: false,
      code: "source-version-mismatch",
    });
  });

  it("rejects a pdf page selection beyond the manifest page count", () => {
    const selection = decodePreviewSelection({
      kind: "pdf",
      targetId: ids.target,
      sourceVersion: version,
      page: 99,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "pdf" }))).toEqual({
      ok: false,
      code: "out-of-bounds",
    });
  });

  it("rejects a workbook row selection beyond the manifest row count", () => {
    const selection = decodePreviewSelection({
      kind: "workbook",
      targetId: ids.target,
      sourceVersion: version,
      worksheet: 1,
      startRow: 1,
      endRow: 5000,
      startColumn: 1,
      endColumn: 1,
    });
    expect(
      validatePreviewSelection(
        selection,
        manifest({ kind: "workbook", bounds: { rows: 100, worksheets: 1 } }),
      ),
    ).toEqual({ ok: false, code: "out-of-bounds" });
  });
});

describe("classifyViewerStateRestore", () => {
  it("restores when the persisted state matches the current target and source version", () => {
    expect(
      classifyViewerStateRestore(
        { targetId: ids.target, sourceVersion: version },
        ids.target,
        version,
      ),
    ).toBe("restorable");
  });

  it("reports stale when the source version changed since the state was persisted", () => {
    expect(
      classifyViewerStateRestore(
        { targetId: ids.target, sourceVersion: version },
        ids.target,
        changedVersion,
      ),
    ).toBe("stale");
  });
});

describe("classifySourceAvailability", () => {
  it("reports unavailable when no current source version exists", () => {
    expect(classifySourceAvailability(undefined, version)).toBe("unavailable");
  });

  it("reports available when current matches the known version", () => {
    expect(classifySourceAvailability(version, version)).toBe("available");
  });

  it("reports stale when current differs from the known version", () => {
    expect(classifySourceAvailability(changedVersion, version)).toBe("stale");
  });

  it("reports available when there is no prior known version to compare", () => {
    expect(classifySourceAvailability(version, undefined)).toBe("available");
  });
});

describe("classifyPreviewTabAuthority", () => {
  it("reports bound when the active context is bound to the tab's Project", () => {
    expect(
      classifyPreviewTabAuthority({
        tabProjectId: ids.project,
        activeProjectId: ids.project,
      }),
    ).toBe("bound");
  });

  it("reports unavailable when the active context is bound to a different Project", () => {
    expect(
      classifyPreviewTabAuthority({
        tabProjectId: ids.project,
        activeProjectId: ids.otherProject,
      }),
    ).toBe("unavailable");
  });

  it("reports unavailable when the active context has no bound Project", () => {
    expect(classifyPreviewTabAuthority({ tabProjectId: ids.project, activeProjectId: null })).toBe(
      "unavailable",
    );
  });
});

describe("authorizePreviewTarget host identity", () => {
  it("denies a target whose host differs from the active authoritative host", () => {
    expect(
      authorizePreviewTarget({
        mode: "work",
        projectType: "work",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", hostId: ids.otherHost }),
      }),
    ).toBe("deny");
  });

  it("allows when the target host matches the active host", () => {
    expect(
      authorizePreviewTarget({
        mode: "work",
        projectType: "work",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file" }),
      }),
    ).toBe("allow");
  });
});

describe("authorizePreviewTarget Code thread scoping", () => {
  it("denies a Code target bound to a different active thread", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        activeThreadId: ids.codeThread,
        target: target({ kind: "file", boundCodeThreadId: ids.otherThread }),
      }),
    ).toBe("deny");
  });

  it("allows a Code target bound to the active thread", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        activeThreadId: ids.codeThread,
        target: target({ kind: "file", boundCodeThreadId: ids.codeThread }),
      }),
    ).toBe("allow");
  });

  it("allows a Code target without a bound thread when no active thread is supplied", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file" }),
      }),
    ).toBe("allow");
  });
});

describe("resolvePreviewCapabilities plan-mode host handoff", () => {
  it("hides Finder reveal and Quick Look in plan mode", () => {
    const resolved = resolvePreviewCapabilities({
      mode: "code",
      posture: "plan",
      kind: "text",
      baseCapabilities: fullCapabilities,
    });
    expect(resolved.canRevealInFinder).toBe(false);
    expect(resolved.canQuickLook).toBe(false);
    expect(resolved.canOpenExternally).toBe(false);
    expect(resolved.canEditInMonaco).toBe(false);
  });

  it("preserves Finder reveal and Quick Look outside plan mode", () => {
    const resolved = resolvePreviewCapabilities({
      mode: "code",
      posture: "full",
      kind: "text",
      baseCapabilities: fullCapabilities,
    });
    expect(resolved.canRevealInFinder).toBe(true);
    expect(resolved.canQuickLook).toBe(true);
  });
});

describe("validatePreviewSelection target and kind agreement", () => {
  it("rejects a selection whose targetId differs from the manifest target", () => {
    const selection = decodePreviewSelection({
      kind: "text",
      targetId: ids.otherTarget,
      sourceVersion: version,
      startLine: 1,
      endLine: 4,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "text" }))).toEqual({
      ok: false,
      code: "target-mismatch",
    });
  });

  it("rejects a text selection against a PDF manifest with matching target and version", () => {
    const selection = decodePreviewSelection({
      kind: "text",
      targetId: ids.target,
      sourceVersion: version,
      startLine: 1,
      endLine: 4,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "pdf" }))).toEqual({
      ok: false,
      code: "kind-mismatch",
    });
  });

  it("rejects a pdf selection against a text manifest", () => {
    const selection = decodePreviewSelection({
      kind: "pdf",
      targetId: ids.target,
      sourceVersion: version,
      page: 1,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "text" }))).toEqual({
      ok: false,
      code: "kind-mismatch",
    });
  });
});

describe("validatePreviewSelection missing bounds fail closed", () => {
  it("rejects a pdf page selection when the manifest omits page count", () => {
    const selection = decodePreviewSelection({
      kind: "pdf",
      targetId: ids.target,
      sourceVersion: version,
      page: 1,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "pdf", bounds: {} }))).toEqual({
      ok: false,
      code: "out-of-bounds",
    });
  });

  it("rejects a workbook selection when the manifest omits row/column counts", () => {
    const selection = decodePreviewSelection({
      kind: "workbook",
      targetId: ids.target,
      sourceVersion: version,
      worksheet: 1,
      startRow: 1,
      endRow: 2,
      startColumn: 1,
      endColumn: 2,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "workbook", bounds: {} }))).toEqual(
      {
        ok: false,
        code: "out-of-bounds",
      },
    );
  });

  it("rejects a slides selection when the manifest omits slide count", () => {
    const selection = decodePreviewSelection({
      kind: "slides",
      targetId: ids.target,
      sourceVersion: version,
      slide: 1,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "slides", bounds: {} }))).toEqual({
      ok: false,
      code: "out-of-bounds",
    });
  });

  it("accepts a text selection without manifest bounds because text is unbounded", () => {
    const selection = decodePreviewSelection({
      kind: "text",
      targetId: ids.target,
      sourceVersion: version,
      startLine: 1,
      endLine: 4,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "text", bounds: {} }))).toEqual({
      ok: true,
    });
  });
});

describe("authorizePreviewTarget Code thread fail-closed", () => {
  it("denies a bound Code target when no active thread is supplied", () => {
    expect(
      authorizePreviewTarget({
        mode: "code",
        projectType: "code",
        activeProjectId: ids.project,
        activeHostId: ids.host,
        target: target({ kind: "file", boundCodeThreadId: ids.codeThread }),
      }),
    ).toBe("deny");
  });
});

describe("classifyViewerStateRestore target identity", () => {
  it("restores when target id and source version both match", () => {
    expect(
      classifyViewerStateRestore(
        { targetId: ids.target, sourceVersion: version },
        ids.target,
        version,
      ),
    ).toBe("restorable");
  });

  it("reports stale when the target id differs even if the source version matches", () => {
    expect(
      classifyViewerStateRestore(
        { targetId: ids.target, sourceVersion: version },
        ids.otherTarget,
        version,
      ),
    ).toBe("stale");
  });
});

describe("validatePreviewSelection document bounds", () => {
  it("rejects a document selection when the manifest omits block count", () => {
    const selection = decodePreviewSelection({
      kind: "document",
      targetId: ids.target,
      sourceVersion: version,
      blockIndex: 0,
    });
    expect(validatePreviewSelection(selection, manifest({ kind: "document", bounds: {} }))).toEqual(
      {
        ok: false,
        code: "out-of-bounds",
      },
    );
  });

  it("accepts an in-bounds document selection when block count is present", () => {
    const selection = decodePreviewSelection({
      kind: "document",
      targetId: ids.target,
      sourceVersion: version,
      blockIndex: 2,
    });
    expect(
      validatePreviewSelection(selection, manifest({ kind: "document", bounds: { blocks: 5 } })),
    ).toEqual({ ok: true });
  });

  it("rejects a document block index beyond the manifest block count", () => {
    const selection = decodePreviewSelection({
      kind: "document",
      targetId: ids.target,
      sourceVersion: version,
      blockIndex: 99,
    });
    expect(
      validatePreviewSelection(selection, manifest({ kind: "document", bounds: { blocks: 5 } })),
    ).toEqual({ ok: false, code: "out-of-bounds" });
  });
});
