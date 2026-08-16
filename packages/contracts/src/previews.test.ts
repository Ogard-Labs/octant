import { describe, expect, it } from "vitest";
import {
  decodePreviewCancelReply,
  decodePreviewCancelRequest,
  decodePreviewChunksReply,
  decodePreviewChunksRequest,
  decodePreviewChunk,
  decodePreviewChunkDescriptor,
  decodePreviewContentBounds,
  decodePreviewHandoffReply,
  decodePreviewHandoffRequest,
  decodePreviewManifest,
  decodePreviewOpenRequest,
  decodePreviewOutcome,
  decodePreviewRefreshRequest,
  decodePreviewSelection,
  decodePreviewSourceVersion,
  decodePreviewTarget,
  decodePreviewViewerState,
} from "./previews";

const ids = {
  target: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  host: "33333333-3333-4333-8333-333333333333",
  otherProject: "44444444-4444-4444-8444-444444444444",
} as const;

const sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
const otherSha = "1111111111111111111111111111111111111111111111111111111111111111";
const observedAt = "2026-07-22T08:00:00.000Z";
const producedAt = "2026-07-22T08:00:01.000Z";

const sourceVersion = { contentSha256: sha256, byteSize: 1024, observedAt } as const;
const otherSourceVersion = { contentSha256: otherSha, byteSize: 1024, observedAt } as const;

const fileTarget = {
  targetId: ids.target,
  projectId: ids.project,
  hostId: ids.host,
  kind: "file",
  opaqueRef: "opaque-ref-token-1",
  displayName: "report.pdf",
} as const;

const fullCapabilities = {
  canSearch: true,
  canSelect: true,
  canZoom: true,
  canRevealInFinder: true,
  canOpenExternally: true,
  canQuickLook: true,
  canEditInMonaco: false,
} as const;

describe("PreviewTarget", () => {
  it("decodes a valid opaque file target", () => {
    expect(decodePreviewTarget(fileTarget)).toEqual(fileTarget);
  });

  it("rejects a target that leaks a host filesystem path field", () => {
    expect(() =>
      decodePreviewTarget({ ...fileTarget, path: "/Users/example/secrets/report.pdf" }),
    ).toThrow();
  });

  it("rejects a target whose opaqueRef is empty or whitespace", () => {
    expect(() => decodePreviewTarget({ ...fileTarget, opaqueRef: "  " })).toThrow();
  });

  it("rejects a target with an unknown kind", () => {
    expect(() => decodePreviewTarget({ ...fileTarget, kind: "remote-url" })).toThrow();
  });
});

describe("PreviewSourceVersion", () => {
  it("decodes a valid sha-256 content version", () => {
    expect(decodePreviewSourceVersion(sourceVersion)).toEqual(sourceVersion);
  });

  it("rejects a non-hex or wrong-length content hash", () => {
    expect(() =>
      decodePreviewSourceVersion({ contentSha256: "deadbeef", byteSize: 1, observedAt }),
    ).toThrow();
  });

  it("rejects a negative byte size", () => {
    expect(() =>
      decodePreviewSourceVersion({ contentSha256: sha256, byteSize: -1, observedAt }),
    ).toThrow();
  });
});

describe("PreviewManifest", () => {
  const manifest = {
    target: fileTarget,
    sourceVersion,
    kind: "pdf",
    sniffedMediaType: "application/pdf",
    byteSize: 1024,
    fidelity: { level: "full" },
    capabilities: fullCapabilities,
    bounds: { pages: 4 },
    producedAt,
  } as const;

  it("round-trips a valid manifest", () => {
    expect(decodePreviewManifest(manifest)).toEqual(manifest);
  });

  it("rejects a manifest carrying an excess hostPath field", () => {
    expect(() => decodePreviewManifest({ ...manifest, hostPath: "/secret" })).toThrow();
  });

  it("rejects a manifest with an unsupported fidelity level", () => {
    expect(() => decodePreviewManifest({ ...manifest, fidelity: { level: "perfect" } })).toThrow();
  });
});

describe("PreviewContentBounds", () => {
  it("accepts bounds with no counts for unbounded formats", () => {
    expect(decodePreviewContentBounds({})).toEqual({});
  });

  it("rejects a zero page count", () => {
    expect(() => decodePreviewContentBounds({ pages: 0 })).toThrow();
  });
});

describe("PreviewChunkDescriptor", () => {
  it("decodes a text line-range descriptor", () => {
    const descriptor = { kind: "text", startLine: 1, endLine: 50 };
    expect(decodePreviewChunkDescriptor(descriptor)).toEqual(descriptor);
  });

  it("rejects an inverted text line range", () => {
    expect(() =>
      decodePreviewChunkDescriptor({ kind: "text", startLine: 50, endLine: 1 }),
    ).toThrow();
  });

  it("rejects a workbook descriptor with an inverted column range", () => {
    expect(() =>
      decodePreviewChunkDescriptor({
        kind: "workbook",
        worksheet: 1,
        startRow: 1,
        endRow: 10,
        startColumn: 5,
        endColumn: 2,
      }),
    ).toThrow();
  });

  it("decodes an image descriptor with no range fields", () => {
    const descriptor = { kind: "image" };
    expect(decodePreviewChunkDescriptor(descriptor)).toEqual(descriptor);
  });
});

describe("PreviewChunk", () => {
  const chunk = {
    chunkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetId: ids.target,
    sourceVersion,
    kind: "text",
    sequence: 0,
    descriptor: { kind: "text", startLine: 1, endLine: 50 },
    payload: { kind: "text", text: "hello world", encoding: "utf-8" },
    isFinal: false,
  } as const;

  it("round-trips a valid bounded chunk", () => {
    expect(decodePreviewChunk(chunk)).toEqual(chunk);
  });

  it("accepts a tab delimiter in a table payload", () => {
    const tableChunk = {
      ...chunk,
      kind: "table",
      descriptor: { kind: "table", startRow: 1, endRow: 1 },
      payload: { kind: "table", rows: [["name", "value"]], delimiter: "\t" },
    } as const;
    expect(decodePreviewChunk(tableChunk)).toEqual(tableChunk);
  });

  it("rejects a chunk whose payload kind disagrees with the chunk kind", () => {
    expect(() =>
      decodePreviewChunk({
        ...chunk,
        payload: {
          kind: "image",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      }),
    ).toThrow();
  });

  it("rejects a chunk carrying raw source bytes", () => {
    expect(() => decodePreviewChunk({ ...chunk, rawBytes: "AAA" })).toThrow();
  });
});

describe("PreviewSelection", () => {
  it("decodes a source-versioned text line selection", () => {
    const selection = {
      kind: "text",
      targetId: ids.target,
      sourceVersion,
      startLine: 10,
      endLine: 20,
    };
    expect(decodePreviewSelection(selection)).toEqual(selection);
  });

  it("rejects an inverted text selection range", () => {
    expect(() =>
      decodePreviewSelection({
        kind: "text",
        targetId: ids.target,
        sourceVersion,
        startLine: 20,
        endLine: 10,
      }),
    ).toThrow();
  });

  it("decodes a workbook cell-range selection", () => {
    const selection = {
      kind: "workbook",
      targetId: ids.target,
      sourceVersion,
      worksheet: 1,
      startRow: 1,
      endRow: 5,
      startColumn: 1,
      endColumn: 3,
    };
    expect(decodePreviewSelection(selection)).toEqual(selection);
  });

  it("rejects a selection that carries content bytes alongside the reference", () => {
    expect(() =>
      decodePreviewSelection({
        kind: "text",
        targetId: ids.target,
        sourceVersion,
        startLine: 1,
        endLine: 2,
        content: "leaked",
      }),
    ).toThrow();
  });
});

describe("PreviewViewerState", () => {
  it("round-trips restorable viewer state bound to a source version", () => {
    const state = {
      targetId: ids.target,
      sourceVersion,
      page: 2,
      zoom: 1.5,
      mode: "preview",
    };
    expect(decodePreviewViewerState(state)).toEqual(state);
  });

  it("rejects viewer state carrying a non-positive zoom", () => {
    expect(() =>
      decodePreviewViewerState({ targetId: ids.target, sourceVersion, zoom: 0 }),
    ).toThrow();
  });

  it("rejects viewer state with an unknown mode", () => {
    expect(() =>
      decodePreviewViewerState({ targetId: ids.target, sourceVersion, mode: "split" }),
    ).toThrow();
  });
});

describe("PreviewOutcome", () => {
  it("decodes a ready outcome carrying a manifest", () => {
    const outcome = {
      kind: "ready",
      manifest: {
        target: fileTarget,
        sourceVersion,
        kind: "pdf",
        sniffedMediaType: "application/pdf",
        byteSize: 1024,
        fidelity: { level: "full" },
        capabilities: fullCapabilities,
        bounds: { pages: 4 },
        producedAt,
      },
    };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("decodes an unauthorized outcome that exposes no content-derived metadata", () => {
    const outcome = { kind: "unauthorized", targetId: ids.target };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("rejects an unauthorized outcome that leaks a display name or media type", () => {
    expect(() =>
      decodePreviewOutcome({ kind: "unauthorized", targetId: ids.target, displayName: "secret" }),
    ).toThrow();
  });

  it("decodes a stale outcome referencing the known source version", () => {
    const outcome = { kind: "stale", target: fileTarget, knownVersion: otherSourceVersion };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("decodes a too-large outcome with byte size and configured limit", () => {
    const outcome = {
      kind: "too-large",
      target: fileTarget,
      byteSize: 50_000_000,
      limit: 10_000_000,
      canOpenExternally: true,
    };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("decodes a locked outcome without persisting a password", () => {
    const outcome = { kind: "locked", target: fileTarget, canOpenExternally: true };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
    expect(() => decodePreviewOutcome({ ...outcome, password: "hunter2" })).toThrow();
  });
});

describe("PreviewTarget path-shaped field rejection", () => {
  it("rejects an opaqueRef containing a path separator", () => {
    expect(() =>
      decodePreviewTarget({ ...fileTarget, opaqueRef: "/Users/example/secret.pdf" }),
    ).toThrow();
    expect(() => decodePreviewTarget({ ...fileTarget, opaqueRef: "a\\b\\c" })).toThrow();
  });

  it("rejects an opaqueRef that looks like a file URL", () => {
    expect(() => decodePreviewTarget({ ...fileTarget, opaqueRef: "file:///secret" })).toThrow();
  });

  it("rejects a displayName containing a path separator", () => {
    expect(() =>
      decodePreviewTarget({ ...fileTarget, displayName: "folder/report.pdf" }),
    ).toThrow();
    expect(() =>
      decodePreviewTarget({ ...fileTarget, displayName: "folder\\report.pdf" }),
    ).toThrow();
  });

  it("accepts a basename displayName and a token opaqueRef", () => {
    expect(decodePreviewTarget({ ...fileTarget, displayName: "report (final).pdf" })).toEqual({
      ...fileTarget,
      displayName: "report (final).pdf",
    });
  });
});

describe("PreviewTarget Code thread binding", () => {
  it("round-trips a Code target carrying a bound thread id", () => {
    const codeTarget = {
      ...fileTarget,
      boundCodeThreadId: "55555555-5555-4555-8555-555555555555",
    };
    expect(decodePreviewTarget(codeTarget)).toEqual(codeTarget);
  });

  it("accepts a target without a bound thread id", () => {
    expect(decodePreviewTarget(fileTarget)).toEqual(fileTarget);
  });

  it("rejects a bound thread id that is not a UUID", () => {
    expect(() => decodePreviewTarget({ ...fileTarget, boundCodeThreadId: "not-a-uuid" })).toThrow();
  });
});

describe("PreviewSelection markdown variant", () => {
  it("decodes a source-versioned markdown line selection", () => {
    const selection = {
      kind: "markdown",
      targetId: ids.target,
      sourceVersion,
      startLine: 5,
      endLine: 12,
    };
    expect(decodePreviewSelection(selection)).toEqual(selection);
  });

  it("rejects an inverted markdown line range", () => {
    expect(() =>
      decodePreviewSelection({
        kind: "markdown",
        targetId: ids.target,
        sourceVersion,
        startLine: 12,
        endLine: 5,
      }),
    ).toThrow();
  });
});

describe("PreviewOutcome limited-fidelity consistency", () => {
  const fullFidelityManifest = {
    target: fileTarget,
    sourceVersion,
    kind: "workbook",
    sniffedMediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteSize: 1024,
    fidelity: { level: "full" },
    capabilities: fullCapabilities,
    bounds: { worksheets: 1, rows: 10, columns: 5 },
    producedAt,
  } as const;

  it("rejects a limited-fidelity outcome whose manifest promises full fidelity", () => {
    expect(() =>
      decodePreviewOutcome({ kind: "limited-fidelity", manifest: fullFidelityManifest }),
    ).toThrow();
  });

  it("accepts a limited-fidelity outcome whose manifest reports limited fidelity", () => {
    const limitedManifest = {
      ...fullFidelityManifest,
      fidelity: { level: "limited", notice: "Stored values only" },
    };
    const outcome = { kind: "limited-fidelity", manifest: limitedManifest };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });
});

describe("PreviewOutcome ready fidelity and kind honesty", () => {
  const baseManifest = {
    target: fileTarget,
    sourceVersion,
    kind: "text",
    sniffedMediaType: "text/plain",
    byteSize: 1024,
    fidelity: { level: "full" },
    capabilities: fullCapabilities,
    bounds: {},
    producedAt,
  } as const;

  it("rejects a ready outcome whose manifest reports limited fidelity", () => {
    expect(() =>
      decodePreviewOutcome({
        kind: "ready",
        manifest: { ...baseManifest, fidelity: { level: "limited", notice: "truncated" } },
      }),
    ).toThrow();
  });

  it("rejects a ready outcome whose manifest kind is unsupported", () => {
    expect(() =>
      decodePreviewOutcome({
        kind: "ready",
        manifest: { ...baseManifest, kind: "unsupported" },
      }),
    ).toThrow();
  });

  it("accepts a ready outcome with a full-fidelity supported manifest", () => {
    const outcome = { kind: "ready", manifest: baseManifest };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });
});

describe("PreviewOutcome unavailable variant", () => {
  it("decodes an unavailable outcome referencing the target", () => {
    const outcome = { kind: "unavailable", target: fileTarget };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("rejects an unavailable outcome that leaks content-derived metadata", () => {
    expect(() =>
      decodePreviewOutcome({ kind: "unavailable", target: fileTarget, mediaType: "secret" }),
    ).toThrow();
  });
});

describe("PreviewFidelity notice required for limited", () => {
  it("rejects a limited fidelity without an actionable notice", () => {
    expect(() =>
      decodePreviewManifest({
        target: fileTarget,
        sourceVersion,
        kind: "workbook",
        sniffedMediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: 1024,
        fidelity: { level: "limited" },
        capabilities: fullCapabilities,
        bounds: { worksheets: 1, rows: 10, columns: 5 },
        producedAt,
      }),
    ).toThrow();
  });

  it("accepts a limited fidelity with a notice", () => {
    const manifest = {
      target: fileTarget,
      sourceVersion,
      kind: "workbook",
      sniffedMediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 1024,
      fidelity: { level: "limited", notice: "Stored values only" },
      capabilities: fullCapabilities,
      bounds: { worksheets: 1, rows: 10, columns: 5 },
      producedAt,
    };
    expect(decodePreviewManifest(manifest)).toEqual(manifest);
  });
});

describe("ImagePayload dataUrl safety", () => {
  const imageChunk = {
    chunkId: "11111111-1111-4111-8111-111111111112",
    targetId: ids.target,
    sourceVersion,
    kind: "image" as const,
    sequence: 0,
    descriptor: { kind: "image" },
    payload: {
      kind: "image",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    },
    isFinal: true,
  };

  it("accepts a base64 data:image URL", () => {
    expect(decodePreviewChunk(imageChunk)).toEqual(imageChunk);
  });

  it("rejects an https URL as dataUrl", () => {
    expect(() =>
      decodePreviewChunk({
        ...imageChunk,
        payload: { kind: "image", mediaType: "image/png", dataUrl: "https://evil.example/x.png" },
      }),
    ).toThrow();
  });

  it("rejects a file URL as dataUrl", () => {
    expect(() =>
      decodePreviewChunk({
        ...imageChunk,
        payload: { kind: "image", mediaType: "image/png", dataUrl: "file:///secret.png" },
      }),
    ).toThrow();
  });

  it("rejects a non-image data URL", () => {
    expect(() =>
      decodePreviewChunk({
        ...imageChunk,
        payload: { kind: "image", mediaType: "image/png", dataUrl: "data:text/html;base64,PHNj" },
      }),
    ).toThrow();
  });
});

describe("PreviewOutcome failed safe diagnostics", () => {
  it("decodes a failed outcome with a typed failure code", () => {
    const outcome = { kind: "failed", target: fileTarget, reason: "parse-failed" };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("rejects an arbitrary free-text reason", () => {
    expect(() =>
      decodePreviewOutcome({
        kind: "failed",
        target: fileTarget,
        reason: "open /Users/example/secret.pdf failed",
      }),
    ).toThrow();
  });

  it("rejects a reason carrying a file URL", () => {
    expect(() =>
      decodePreviewOutcome({ kind: "failed", target: fileTarget, reason: "file:///secret" }),
    ).toThrow();
  });

  it("accepts an optional sanitized message without path separators", () => {
    const outcome = {
      kind: "failed",
      target: fileTarget,
      reason: "parse-failed",
      message: "The preview could not be parsed",
    };
    expect(decodePreviewOutcome(outcome)).toEqual(outcome);
  });

  it("rejects a message containing a path separator", () => {
    expect(() =>
      decodePreviewOutcome({
        kind: "failed",
        target: fileTarget,
        reason: "parse-failed",
        message: "open folder/report.pdf failed",
      }),
    ).toThrow();
  });
});

describe("PreviewOpenRequest", () => {
  it("decodes an open request without a known version", () => {
    expect(decodePreviewOpenRequest({ target: fileTarget })).toEqual({ target: fileTarget });
  });

  it("decodes an open request with a known version for stale detection", () => {
    const request = { target: fileTarget, knownVersion: sourceVersion };
    expect(decodePreviewOpenRequest(request)).toEqual(request);
  });

  it("rejects an open request carrying an excess path field", () => {
    expect(() => decodePreviewOpenRequest({ target: fileTarget, path: "/host/secret" })).toThrow();
  });
});

describe("PreviewRefreshRequest", () => {
  it("requires a known version so refresh never starts a fresh preview", () => {
    expect(() => decodePreviewRefreshRequest({ target: fileTarget })).toThrow();
  });

  it("decodes a refresh request with a known version", () => {
    const request = { target: fileTarget, knownVersion: sourceVersion };
    expect(decodePreviewRefreshRequest(request)).toEqual(request);
  });
});

describe("PreviewChunksRequest", () => {
  it("decodes a chunks request with an after-sequence cursor", () => {
    const request = {
      target: fileTarget,
      sourceVersion,
      afterSequence: 0,
    };
    expect(decodePreviewChunksRequest(request)).toEqual(request);
  });

  it("rejects a negative after-sequence cursor", () => {
    expect(() =>
      decodePreviewChunksRequest({ target: fileTarget, sourceVersion, afterSequence: -1 }),
    ).toThrow();
  });

  it("rejects an excess path field", () => {
    expect(() =>
      decodePreviewChunksRequest({
        target: fileTarget,
        sourceVersion,
        afterSequence: 0,
        path: "/host/secret",
      }),
    ).toThrow();
  });
});

describe("PreviewCancelRequest", () => {
  it("decodes a cancel request carrying the full target for re-authorization", () => {
    expect(decodePreviewCancelRequest({ target: fileTarget })).toEqual({ target: fileTarget });
  });
});

describe("PreviewChunksReply", () => {
  const textChunk = {
    chunkId: "55555555-5555-4555-8555-555555555555",
    targetId: ids.target,
    sourceVersion,
    kind: "text",
    sequence: 0,
    descriptor: { kind: "text", startLine: 1, endLine: 1 },
    payload: { kind: "text", text: "hello", encoding: "utf-8" },
    isFinal: true,
  } as const;

  it("decodes a successful bounded chunks batch", () => {
    const reply = { kind: "chunks", chunks: [textChunk] };
    expect(decodePreviewChunksReply(reply)).toEqual(reply);
  });

  it("decodes an unauthorized reply that discloses only the target id", () => {
    const reply = { kind: "unauthorized", targetId: ids.target };
    expect(decodePreviewChunksReply(reply)).toEqual(reply);
  });

  it("decodes a stale reply carrying the known version", () => {
    const reply = { kind: "stale", target: fileTarget, knownVersion: sourceVersion };
    expect(decodePreviewChunksReply(reply)).toEqual(reply);
  });

  it("decodes an interrupted reply with a retry flag", () => {
    const reply = { kind: "interrupted", target: fileTarget, canRetry: true };
    expect(decodePreviewChunksReply(reply)).toEqual(reply);
  });

  it("rejects a failed reply that leaks a path in the message", () => {
    expect(() =>
      decodePreviewChunksReply({
        kind: "failed",
        target: fileTarget,
        reason: "read-failed",
        message: "open /host/secret failed",
      }),
    ).toThrow();
  });
});

describe("PreviewCancelReply", () => {
  it("decodes a cancelled confirmation", () => {
    expect(decodePreviewCancelReply({ kind: "cancelled" })).toEqual({ kind: "cancelled" });
  });

  it("decodes a not-found reply when no stream was active", () => {
    expect(decodePreviewCancelReply({ kind: "not-found" })).toEqual({ kind: "not-found" });
  });

  it("decodes an unauthorized cancel reply disclosing only the target id", () => {
    const reply = { kind: "unauthorized", targetId: ids.target };
    expect(decodePreviewCancelReply(reply)).toEqual(reply);
  });
});

describe("PreviewHandoffRequest", () => {
  it("round-trips an open-external request carrying only the opaque target", () => {
    const request = { target: fileTarget, kind: "open-external" };
    expect(decodePreviewHandoffRequest(request)).toEqual(request);
  });

  it("round-trips reveal-in-finder and quick-look kinds", () => {
    expect(decodePreviewHandoffRequest({ target: fileTarget, kind: "reveal-in-finder" })).toEqual({
      target: fileTarget,
      kind: "reveal-in-finder",
    });
    expect(decodePreviewHandoffRequest({ target: fileTarget, kind: "quick-look" })).toEqual({
      target: fileTarget,
      kind: "quick-look",
    });
  });

  it("rejects an unknown handoff kind", () => {
    expect(() => decodePreviewHandoffRequest({ target: fileTarget, kind: "shell-open" })).toThrow();
  });

  it("rejects a generic shell-open style kind", () => {
    expect(() =>
      decodePreviewHandoffRequest({ target: fileTarget, kind: "open-with-shell" }),
    ).toThrow();
  });

  it("rejects an excess path field", () => {
    expect(() =>
      decodePreviewHandoffRequest({
        target: fileTarget,
        kind: "reveal-in-finder",
        path: "/host/secret/notes.md",
      }),
    ).toThrow();
  });

  it("rejects a target whose opaque ref leaks a path", () => {
    expect(() =>
      decodePreviewHandoffRequest({
        target: { ...fileTarget, opaqueRef: "folder/secret.md" },
        kind: "quick-look",
      }),
    ).toThrow();
  });
});

describe("PreviewHandoffReply", () => {
  it("decodes a done reply confirming the handoff kind without any path", () => {
    const reply = { kind: "done", handoffKind: "reveal-in-finder" };
    expect(decodePreviewHandoffReply(reply)).toEqual(reply);
  });

  it("decodes an unauthorized reply disclosing only the target id", () => {
    const reply = { kind: "unauthorized", targetId: ids.target };
    expect(decodePreviewHandoffReply(reply)).toEqual(reply);
  });

  it("decodes an unavailable reply carrying the opaque target", () => {
    const reply = { kind: "unavailable", target: fileTarget };
    expect(decodePreviewHandoffReply(reply)).toEqual(reply);
  });

  it("decodes a cancelled failure reply", () => {
    const reply = { kind: "failed", reason: "cancelled" };
    expect(decodePreviewHandoffReply(reply)).toEqual(reply);
  });

  it("rejects a failed reply that leaks a path in the message", () => {
    expect(() =>
      decodePreviewHandoffReply({
        kind: "failed",
        reason: "read-failed",
        message: "open /host/secret/notes.md failed",
      }),
    ).toThrow();
  });

  it("rejects a done reply that carries a host path", () => {
    expect(() =>
      decodePreviewHandoffReply({ kind: "done", handoffKind: "open-external", path: "/x" }),
    ).toThrow();
  });
});
