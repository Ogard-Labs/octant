import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts/projects";
import {
  decodePreviewTarget,
  decodePreviewTargetId,
  decodePreviewHostId,
  decodePreviewSourceVersion,
  type PreviewSourceVersion,
  type PreviewTarget,
} from "@octant/contracts/previews";

import { PreviewService, type PreviewAuthorityContext } from "./previewService";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "./previewTestFixtures";

const previewParserMocks = vi.hoisted(() => ({
  parsePdf: vi.fn(),
  parseWorkbook: vi.fn(),
  parseDocument: vi.fn(),
  parseSlides: vi.fn(),
}));

vi.mock("./previewPdfChunker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previewPdfChunker")>();
  previewParserMocks.parsePdf.mockImplementation(actual.parsePdf);
  return { ...actual, parsePdf: previewParserMocks.parsePdf };
});

vi.mock("./previewWorkbookChunker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previewWorkbookChunker")>();
  previewParserMocks.parseWorkbook.mockImplementation(actual.parseWorkbook);
  return { ...actual, parseWorkbook: previewParserMocks.parseWorkbook };
});

vi.mock("./previewDocumentChunker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previewDocumentChunker")>();
  previewParserMocks.parseDocument.mockImplementation(actual.parseDocument);
  return { ...actual, parseDocument: previewParserMocks.parseDocument };
});

vi.mock("./previewSlidesChunker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previewSlidesChunker")>();
  previewParserMocks.parseSlides.mockImplementation(actual.parseSlides);
  return { ...actual, parseSlides: previewParserMocks.parseSlides };
});

function target(overrides: Record<string, unknown> = {}): PreviewTarget {
  return decodePreviewTarget({
    targetId: ids.target,
    projectId: ids.project,
    hostId: ids.host,
    kind: "file",
    opaqueRef: "opaque-token-1",
    displayName: "notes.txt",
    ...overrides,
  });
}

function sourceVersion(sha: string, byteSize: number): PreviewSourceVersion {
  return decodePreviewSourceVersion({ contentSha256: sha, byteSize, observedAt });
}

const ids = {
  target: decodePreviewTargetId("11111111-1111-4111-8111-111111111111"),
  project: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  host: decodePreviewHostId("33333333-3333-4333-8333-333333333333"),
  otherHost: decodePreviewHostId("44444444-4444-4444-8444-444444444444"),
  otherProject: decodeProjectId("55555555-5555-4555-8555-555555555555"),
} as const;

const shaA = "0000000000000000000000000000000000000000000000000000000000000000";
const observedAt = "2026-07-22T08:00:00.000Z";

function authority(overrides: Partial<PreviewAuthorityContext> = {}): PreviewAuthorityContext {
  return {
    mode: "work",
    projectType: "work",
    activeProjectId: ids.project,
    activeHostId: ids.host,
    posture: "approval-gated",
    ...overrides,
  };
}

function makeService(
  root: string,
  records: Map<string, { relativePath: string; displayName: string }>,
) {
  return new PreviewService({
    hostId: ids.host,
    budget: { maxSniffBytes: 4096, maxByteSize: 1024 * 1024, maxRenderBytes: 1024 * 1024 },
    textBudget: { maxLinesPerChunk: 4, maxBytesPerChunk: 1024 },
    targetResolver: {
      async resolve({ opaqueRef }) {
        const record = records.get(opaqueRef);
        if (record === undefined) return { ok: false, code: "not-found" };
        return { ok: true, ...record };
      },
    },
    projectRootResolver: {
      async resolve(projectId) {
        if (projectId !== ids.project) return { ok: false, code: "unavailable" };
        return { ok: true, canonicalRoot: root };
      },
    },
    uuid: () => "66666666-6666-4666-8666-666666666666",
  });
}

describe("PreviewService.open", () => {
  let root: string;
  let records: Map<string, { relativePath: string; displayName: string }>;
  let service: PreviewService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "preview-service-open-"));
    records = new Map([["opaque-token-1", { relativePath: "notes.md", displayName: "notes.md" }]]);
    writeFileSync(join(root, "notes.md"), "# Title\nbody line\n");
    service = makeService(root, records);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("opens a markdown source as ready with a manifest and no host path", async () => {
    const outcome = await service.open({ authority: authority(), target: target() });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.manifest.kind).toBe("markdown");
      expect(outcome.manifest.target.opaqueRef).toBe("opaque-token-1");
      expect(outcome.manifest.target.displayName).toBe("notes.md");
      expect(JSON.stringify(outcome)).not.toContain(root);
    }
  });

  it("denies a target minted for a different host as unauthorized with only the target id", async () => {
    const outcome = await service.open({
      authority: authority(),
      target: target({ hostId: ids.otherHost }),
    });
    expect(outcome).toEqual({ kind: "unauthorized", targetId: ids.target });
  });

  it("denies a target belonging to another project as unauthorized", async () => {
    const outcome = await service.open({
      authority: authority(),
      target: target({ projectId: ids.otherProject }),
    });
    expect(outcome).toEqual({ kind: "unauthorized", targetId: ids.target });
  });

  it("denies a target whose opaque ref is not registered, indistinguishable from denial", async () => {
    const outcome = await service.open({
      authority: authority(),
      target: target({ opaqueRef: "unknown-ref" }),
    });
    expect(outcome).toEqual({ kind: "unauthorized", targetId: ids.target });
  });

  it("surfaces unavailable when the source file is missing", async () => {
    records.set("missing", { relativePath: "absent.txt", displayName: "absent.txt" });
    const outcome = await service.open({
      authority: authority(),
      target: target({ opaqueRef: "missing" }),
    });
    expect(outcome.kind).toBe("unavailable");
  });

  it("surfaces stale when the known version no longer matches the source", async () => {
    const first = await service.open({ authority: authority(), target: target() });
    if (first.kind !== "ready") throw new Error("expected ready");
    const staleVersion = sourceVersion(shaA, first.manifest.sourceVersion.byteSize);
    const outcome = await service.open({
      authority: authority(),
      target: target(),
      knownVersion: staleVersion,
    });
    expect(outcome.kind).toBe("stale");
  });

  it("surfaces too-large with byte size and limit when the source exceeds the budget", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));
    records.set("big", { relativePath: "big.txt", displayName: "big.txt" });
    const bigService = new PreviewService({
      hostId: ids.host,
      budget: { maxSniffBytes: 4096, maxByteSize: 4, maxRenderBytes: 4 },
      textBudget: { maxLinesPerChunk: 4, maxBytesPerChunk: 1024 },
      targetResolver: {
        async resolve({ opaqueRef }) {
          const record = records.get(opaqueRef);
          if (record === undefined) return { ok: false, code: "not-found" };
          return { ok: true, ...record };
        },
      },
      projectRootResolver: {
        async resolve(projectId) {
          if (projectId !== ids.project) return { ok: false, code: "unavailable" };
          return { ok: true, canonicalRoot: root };
        },
      },
      uuid: () => "66666666-6666-4666-8666-666666666666",
    });
    const outcome = await bigService.open({
      authority: authority(),
      target: target({ opaqueRef: "big" }),
    });
    expect(outcome.kind).toBe("too-large");
    if (outcome.kind === "too-large") {
      expect(outcome.byteSize).toBe(2048);
      expect(outcome.limit).toBe(4);
    }
  });
});

describe("PreviewService.readChunks", () => {
  let root: string;
  let records: Map<string, { relativePath: string; displayName: string }>;
  let service: PreviewService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "preview-service-chunks-"));
    records = new Map([
      ["opaque-token-1", { relativePath: "notes.txt", displayName: "notes.txt" }],
    ]);
    service = makeService(root, records);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("streams bounded text chunks and terminates with isFinal", async () => {
    writeFileSync(join(root, "notes.txt"), "line1\nline2\nline3\nline4\nline5\n");
    const first = await service.open({ authority: authority(), target: target() });
    if (first.kind !== "ready") throw new Error("expected ready");
    const reply = await service.readChunks({
      authority: authority(),
      target: target(),
      sourceVersion: first.manifest.sourceVersion,
      afterSequence: 0,
      maxChunks: 2,
    });
    expect(reply.kind).toBe("chunks");
    if (reply.kind === "chunks") {
      expect(reply.chunks.length).toBe(2);
      expect(reply.chunks[0]?.sequence).toBe(0);
      expect(reply.chunks[1]?.sequence).toBe(1);
    }
  });

  it("returns stale when the source version changed since open", async () => {
    writeFileSync(join(root, "notes.txt"), "line1\n");
    const first = await service.open({ authority: authority(), target: target() });
    if (first.kind !== "ready") throw new Error("expected ready");
    writeFileSync(join(root, "notes.txt"), "line1\nline2\n");
    const reply = await service.readChunks({
      authority: authority(),
      target: target(),
      sourceVersion: first.manifest.sourceVersion,
      afterSequence: 0,
    });
    expect(reply.kind).toBe("stale");
  });

  it("streams a single image chunk carrying a safe data URL", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    writeFileSync(join(root, "pic.png"), pngBytes);
    records.set("pic", { relativePath: "pic.png", displayName: "pic.png" });
    const imageTarget = target({ opaqueRef: "pic" });
    const first = await service.open({ authority: authority(), target: imageTarget });
    if (first.kind !== "ready") throw new Error("expected ready");
    const reply = await service.readChunks({
      authority: authority(),
      target: imageTarget,
      sourceVersion: first.manifest.sourceVersion,
      afterSequence: 0,
    });
    expect(reply.kind).toBe("chunks");
    if (reply.kind === "chunks") {
      expect(reply.chunks).toHaveLength(1);
      const payload = reply.chunks[0]?.payload;
      expect(payload?.kind).toBe("image");
      if (payload?.kind === "image") {
        expect(payload.dataUrl).toMatch(/^data:image\/png;base64,/);
      }
    }
  });

  it("denies chunk reads for an unauthorized target with only the target id", async () => {
    writeFileSync(join(root, "notes.txt"), "line1\n");
    const reply = await service.readChunks({
      authority: authority(),
      target: target({ hostId: ids.otherHost }),
      sourceVersion: sourceVersion(shaA, 6),
      afterSequence: 0,
    });
    expect(reply).toEqual({ kind: "unauthorized", targetId: ids.target });
  });

  it("surfaces unsupported for an Office container without streaming chunks", async () => {
    // OLE2 legacy Office container magic bytes — no native parser in this slice.
    writeFileSync(
      join(root, "doc.doc"),
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
    );
    records.set("doc", { relativePath: "doc.doc", displayName: "doc.doc" });
    const docTarget = target({ opaqueRef: "doc" });
    const first = await service.open({ authority: authority(), target: docTarget });
    if (first.kind !== "unsupported") throw new Error("expected unsupported at open");
    const reply = await service.readChunks({
      authority: authority(),
      target: docTarget,
      sourceVersion: sourceVersion(shaA, 10),
      afterSequence: 0,
    });
    expect(reply.kind).toBe("unsupported");
  });

  it("streams PDF and CSV so open and chunks agree for structured kinds", async () => {
    const { buildPdfFixture } = await import("./previewTestFixtures");
    writeFileSync(join(root, "page.pdf"), buildPdfFixture([["hello pdf"]]));
    records.set("pdf", { relativePath: "page.pdf", displayName: "page.pdf" });
    const pdfTarget = target({ opaqueRef: "pdf" });
    const pdfOpen = await service.open({ authority: authority(), target: pdfTarget });
    expect(["ready", "limited-fidelity"]).toContain(pdfOpen.kind);
    if (pdfOpen.kind !== "ready" && pdfOpen.kind !== "limited-fidelity") {
      throw new Error(`expected streamable pdf open, got ${pdfOpen.kind}`);
    }
    const pdfChunks = await service.readChunks({
      authority: authority(),
      target: pdfTarget,
      sourceVersion: pdfOpen.manifest.sourceVersion,
      afterSequence: 0,
    });
    expect(pdfChunks.kind).toBe("chunks");
    if (pdfChunks.kind === "chunks") {
      expect(pdfChunks.chunks.length).toBeGreaterThan(0);
      expect(pdfChunks.chunks[0]?.payload.kind).toBe("pdf");
    }

    writeFileSync(join(root, "rows.csv"), "a,b\n1,2\n");
    records.set("csv", { relativePath: "rows.csv", displayName: "rows.csv" });
    const csvTarget = target({ opaqueRef: "csv" });
    const csvOpen = await service.open({ authority: authority(), target: csvTarget });
    expect(["ready", "limited-fidelity"]).toContain(csvOpen.kind);
    if (csvOpen.kind !== "ready" && csvOpen.kind !== "limited-fidelity") {
      throw new Error(`expected streamable csv open, got ${csvOpen.kind}`);
    }
    const csvChunks = await service.readChunks({
      authority: authority(),
      target: csvTarget,
      sourceVersion: csvOpen.manifest.sourceVersion,
      afterSequence: 0,
    });
    expect(csvChunks.kind).toBe("chunks");
    if (csvChunks.kind === "chunks") {
      expect(csvChunks.chunks.length).toBeGreaterThan(0);
      expect(csvChunks.chunks[0]?.payload.kind).toBe("table");
    }
  });

  it("returns a typed parse failure for a malformed structured source", async () => {
    writeFileSync(join(root, "broken.pdf"), "%PDF-1.7\nnot a complete object");
    records.set("broken", { relativePath: "broken.pdf", displayName: "broken.pdf" });
    const brokenTarget = target({ opaqueRef: "broken", displayName: "broken.pdf" });
    const opened = await service.open({ authority: authority(), target: brokenTarget });
    expect(opened.kind).toBe("limited-fidelity");
    if (opened.kind !== "limited-fidelity") throw new Error("expected limited-fidelity open");

    const reply = await service.readChunks({
      authority: authority(),
      target: brokenTarget,
      sourceVersion: opened.manifest.sourceVersion,
      afterSequence: 0,
    });
    expect(reply).toMatchObject({ kind: "failed", reason: "parse-failed" });
  });

  it("returns a typed parse failure when a structured parser throws", async () => {
    const cases = [
      {
        opaqueRef: "throwing-pdf",
        fileName: "throwing.pdf",
        bytes: Buffer.from("%PDF-1.7\nparser input"),
        parser: previewParserMocks.parsePdf,
      },
      {
        opaqueRef: "throwing-xlsx",
        fileName: "throwing.xlsx",
        bytes: buildXlsxFixture([["parser input"]]),
        parser: previewParserMocks.parseWorkbook,
      },
      {
        opaqueRef: "throwing-docx",
        fileName: "throwing.docx",
        bytes: buildDocxFixture(["parser input"]),
        parser: previewParserMocks.parseDocument,
      },
      {
        opaqueRef: "throwing-pptx",
        fileName: "throwing.pptx",
        bytes: buildPptxFixture([{ title: "parser input", bullets: [] }]),
        parser: previewParserMocks.parseSlides,
      },
    ] as const;

    for (const fixture of cases) {
      writeFileSync(join(root, fixture.fileName), fixture.bytes);
      records.set(fixture.opaqueRef, {
        relativePath: fixture.fileName,
        displayName: fixture.fileName,
      });
      const throwingTarget = target({
        opaqueRef: fixture.opaqueRef,
        displayName: fixture.fileName,
      });
      fixture.parser.mockImplementationOnce(() => {
        throw new Error("parser-private-secret");
      });

      const reply = await service.readChunks({
        authority: authority(),
        target: throwingTarget,
        sourceVersion: sourceVersion(
          createHash("sha256").update(fixture.bytes).digest("hex"),
          fixture.bytes.length,
        ),
        afterSequence: 0,
      });

      expect(reply).toMatchObject({
        kind: "failed",
        reason: "parse-failed",
        message: "Preview source could not be decoded safely.",
      });
      expect(JSON.stringify(reply)).not.toContain("parser-private-secret");
    }
  });

  it("streams every representative format without mutation or network access", async () => {
    const fixtures = [
      {
        opaqueRef: "representative-pdf",
        fileName: "brief.pdf",
        bytes: buildPdfFixture([["PDF page one"], ["PDF page two"]]),
        kind: "pdf",
        payloadKind: "pdf",
        outcome: "limited-fidelity",
        bounds: { pages: 2 },
      },
      {
        opaqueRef: "representative-csv",
        fileName: "data.csv",
        bytes: Buffer.from("name,age\nAda,36\n"),
        kind: "table",
        payloadKind: "table",
        outcome: "ready",
        bounds: { rows: 2, columns: 2 },
      },
      {
        opaqueRef: "representative-tsv",
        fileName: "data.tsv",
        bytes: Buffer.from("name\tage\nAda\t36\n"),
        kind: "table",
        payloadKind: "table",
        outcome: "ready",
        bounds: { rows: 2, columns: 2 },
      },
      {
        opaqueRef: "representative-xlsx",
        fileName: "data.xlsx",
        bytes: buildXlsxFixture([
          ["name", "age"],
          ["Ada", "36"],
        ]),
        kind: "workbook",
        payloadKind: "workbook",
        outcome: "limited-fidelity",
        bounds: { worksheets: 1, rows: 2, columns: 2 },
      },
      {
        opaqueRef: "representative-docx",
        fileName: "brief.docx",
        bytes: buildDocxFixture(["Brief", "Document body"]),
        kind: "document",
        payloadKind: "document",
        outcome: "limited-fidelity",
        bounds: { blocks: 2 },
      },
      {
        opaqueRef: "representative-pptx",
        fileName: "brief.pptx",
        bytes: buildPptxFixture([
          { title: "Intro", bullets: ["First point"] },
          { title: "Close", bullets: ["Second point"] },
        ]),
        kind: "slides",
        payloadKind: "slides",
        outcome: "limited-fidelity",
        bounds: { slides: 2 },
      },
    ] as const;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      for (const fixture of fixtures) {
        const filePath = join(root, fixture.fileName);
        writeFileSync(filePath, fixture.bytes);
        records.set(fixture.opaqueRef, {
          relativePath: fixture.fileName,
          displayName: fixture.fileName,
        });
        const before = createHash("sha256").update(readFileSync(filePath)).digest("hex");
        const fixtureTarget = target({
          opaqueRef: fixture.opaqueRef,
          displayName: fixture.fileName,
        });

        const opened = await service.open({ authority: authority(), target: fixtureTarget });
        expect(opened.kind).toBe(fixture.outcome);
        if (opened.kind !== "ready" && opened.kind !== "limited-fidelity") {
          throw new Error(`expected an open outcome for ${fixture.fileName}`);
        }
        expect(opened.manifest.kind).toBe(fixture.kind);
        expect(opened.manifest.bounds).toMatchObject(fixture.bounds);
        if (fixture.outcome === "limited-fidelity") {
          expect(opened.manifest.fidelity.notice).toBeTruthy();
        }
        expect(JSON.stringify(opened)).not.toContain(root);

        const reply = await service.readChunks({
          authority: authority(),
          target: fixtureTarget,
          sourceVersion: opened.manifest.sourceVersion,
          afterSequence: 0,
        });
        expect(reply.kind).toBe("chunks");
        if (reply.kind !== "chunks") throw new Error(`expected chunks for ${fixture.fileName}`);
        expect(reply.chunks.length).toBeGreaterThan(0);
        expect(reply.chunks.some((chunk) => chunk.payload.kind === fixture.payloadKind)).toBe(true);
        expect(reply.chunks.at(-1)?.isFinal).toBe(true);
        expect(JSON.stringify(reply)).not.toContain(root);

        const after = createHash("sha256").update(readFileSync(filePath)).digest("hex");
        expect(after).toBe(before);
      }
    } finally {
      fetchSpy.mockRestore();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("PreviewService.cancel", () => {
  let root: string;
  let records: Map<string, { relativePath: string; displayName: string }>;
  let service: PreviewService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "preview-service-cancel-"));
    records = new Map([
      ["opaque-token-1", { relativePath: "notes.txt", displayName: "notes.txt" }],
    ]);
    writeFileSync(join(root, "notes.txt"), "line1\n");
    service = makeService(root, records);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns not-found when no stream is in flight", async () => {
    const reply = await service.cancel({ authority: authority(), target: target() });
    expect(reply).toEqual({ kind: "not-found" });
  });

  it("denies cancel for an unauthorized target with only the target id", async () => {
    const reply = await service.cancel({
      authority: authority(),
      target: target({ hostId: ids.otherHost }),
    });
    expect(reply).toEqual({ kind: "unauthorized", targetId: ids.target });
  });
});
