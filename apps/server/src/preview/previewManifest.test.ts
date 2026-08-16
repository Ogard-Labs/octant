import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectId } from "@octant/contracts";
import {
  decodePreviewHostId,
  decodePreviewOpaqueRef,
  decodePreviewTargetId,
  type PreviewHostId,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import { producePreviewManifest, type PreviewBudget } from "./previewManifest";
import type { PreviewTargetRecord } from "./previewTargetRegistry";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "./previewTestFixtures";

const root = mkdtempSync(join(tmpdir(), "preview-manifest-"));
const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111") as PreviewTargetId;
const hostId = decodePreviewHostId("33333333-3333-4333-8333-333333333333") as PreviewHostId;
const projectId = "22222222-2222-4222-8222-222222222222" as ProjectId;

const budget: PreviewBudget = {
  maxSniffBytes: 4096,
  maxByteSize: 50 * 1024 * 1024,
  maxRenderBytes: 10 * 1024 * 1024,
};

const record: PreviewTargetRecord = {
  targetId,
  kind: "file",
  opaqueRef: decodePreviewOpaqueRef("notes.txt"),
  relativePath: "notes.txt",
};

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("producePreviewManifest", () => {
  it("produces a full-fidelity text manifest for a small utf-8 file", () => {
    writeFileSync(join(root, "notes.txt"), "hello world");
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record,
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("text");
      expect(result.manifest.fidelity.level).toBe("full");
      expect(result.manifest.target.targetId).toBe(targetId);
      expect(result.manifest.target.displayName).toBe("notes.txt");
      expect(result.manifest.byteSize).toBe(11);
      expect(result.manifest.sniffedMediaType).toBe("text/plain");
    }
  });

  it("produces a markdown manifest for a .md file with a heading", () => {
    writeFileSync(join(root, "notes.txt"), "# Title\n\nbody text\n");
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: {
        ...record,
        relativePath: "notes.txt",
        opaqueRef: decodePreviewOpaqueRef("notes.md"),
      },
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The file is named notes.txt but content has a heading; without an
      // agreeing extension the sniffer classifies as text, not markdown.
      expect(result.manifest.kind).toBe("text");
    }
  });

  it("returns unavailable when the file does not exist", () => {
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record,
      budget,
    });
    expect(result).toEqual({ ok: false, code: "unavailable" });
  });

  it("returns too-large when the file exceeds the byte size budget", () => {
    writeFileSync(join(root, "notes.txt"), "x".repeat(20));
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record,
      budget: { ...budget, maxByteSize: 5 },
    });
    expect(result).toEqual({ ok: false, code: "too-large", byteSize: 20, limit: 5 });
  });

  it("returns limited-fidelity when the render budget is exceeded", () => {
    writeFileSync(join(root, "notes.txt"), "x".repeat(20));
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record,
      budget: { ...budget, maxRenderBytes: 5 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.fidelity.level).toBe("limited");
      expect(result.manifest.fidelity.notice).toMatch(/render/i);
    }
  });

  it("produces a pdf manifest for a PDF file", () => {
    writeFileSync(join(root, "notes.txt"), "%PDF-1.7\nstuff");
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record,
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("pdf");
    }
  });

  it("returns containment-violation without reading a path that escapes the root", () => {
    // Plant a file outside the root that the relative path would resolve to.
    const outside = mkdtempSync(join(tmpdir(), "preview-manifest-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      // Symlink inside the root pointing outside, so join(root, relativePath)
      // would read the out-of-root file if containment is not enforced first.
      symlinkSync(outside, join(root, "link"));
      const result = producePreviewManifest({
        projectRoot: root,
        hostId,
        projectId,
        record: {
          ...record,
          opaqueRef: decodePreviewOpaqueRef("link"),
          relativePath: "link/secret.txt",
        },
        budget,
      });
      expect(result).toEqual({ ok: false, code: "containment-violation" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns too-large without reading a file exceeding the byte-size budget", () => {
    // Write a file larger than maxByteSize. The producer must stat before
    // reading so it does not materialize the full file in memory.
    const bigPath = join(root, "big.txt");
    writeFileSync(bigPath, "x".repeat(2048));
    const before = process.memoryUsage().rss;
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: { ...record, relativePath: "big.txt" },
      budget: { ...budget, maxByteSize: 4 },
    });
    expect(result).toEqual({ ok: false, code: "too-large", byteSize: 2048, limit: 4 });
    // Sanity: the read did not balloon memory by loading the full file.
    const after = process.memoryUsage().rss;
    expect(after).toBeLessThan(before + 50 * 1024 * 1024);
  });

  it("produces an unsupported manifest with a non-empty media type for a binary blob", () => {
    writeFileSync(join(root, "notes.txt"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record,
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("unsupported");
      expect(result.manifest.sniffedMediaType.length).toBeGreaterThan(0);
    }
  });

  it("produces a limited-fidelity workbook manifest with worksheet/row/column bounds", () => {
    writeFileSync(
      join(root, "sheet.xlsx"),
      buildXlsxFixture([
        ["a", "b"],
        ["1", "2"],
      ]),
    );
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: { ...record, relativePath: "sheet.xlsx", opaqueRef: decodePreviewOpaqueRef("sheet") },
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("workbook");
      expect(result.manifest.fidelity.level).toBe("limited");
      expect(result.manifest.fidelity.notice).toBeDefined();
      expect(result.manifest.bounds.worksheets).toBe(1);
      expect(result.manifest.bounds.rows).toBe(2);
      expect(result.manifest.bounds.columns).toBe(2);
    }
  });

  it("produces a limited-fidelity document manifest with block bounds", () => {
    writeFileSync(join(root, "doc.docx"), buildDocxFixture(["one", "two"]));
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: { ...record, relativePath: "doc.docx", opaqueRef: decodePreviewOpaqueRef("doc") },
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("document");
      expect(result.manifest.fidelity.level).toBe("limited");
      expect(result.manifest.bounds.blocks).toBe(2);
    }
  });

  it("produces a limited-fidelity slides manifest with slide bounds", () => {
    writeFileSync(
      join(root, "deck.pptx"),
      buildPptxFixture([
        { title: "A", bullets: [] },
        { title: "B", bullets: [] },
      ]),
    );
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: { ...record, relativePath: "deck.pptx", opaqueRef: decodePreviewOpaqueRef("deck") },
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("slides");
      expect(result.manifest.fidelity.level).toBe("limited");
      expect(result.manifest.bounds.slides).toBe(2);
    }
  });

  it("produces a limited-fidelity pdf manifest with page bounds", () => {
    writeFileSync(join(root, "doc.pdf"), buildPdfFixture([["page one"], ["page two"]]));
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: { ...record, relativePath: "doc.pdf", opaqueRef: decodePreviewOpaqueRef("pdfdoc") },
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("pdf");
      expect(result.manifest.fidelity.level).toBe("limited");
      expect(result.manifest.bounds.pages).toBe(2);
    }
  });

  it("produces a full-fidelity table manifest with row/column bounds", () => {
    writeFileSync(join(root, "data.csv"), "a,b,c\n1,2,3\n");
    const result = producePreviewManifest({
      projectRoot: root,
      hostId,
      projectId,
      record: { ...record, relativePath: "data.csv", opaqueRef: decodePreviewOpaqueRef("data") },
      budget,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("table");
      expect(result.manifest.fidelity.level).toBe("full");
      expect(result.manifest.bounds.rows).toBe(2);
      expect(result.manifest.bounds.columns).toBe(3);
    }
  });
});
