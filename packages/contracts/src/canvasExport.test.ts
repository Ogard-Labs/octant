import { describe, expect, it } from "vitest";
import {
  decodeCanvasExportContribution,
  decodeCanvasExportReceipt,
  decodeCanvasExportRecorded,
} from "./canvasExport";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const exportId = "33333333-3333-4333-8333-333333333333";
const approvalId = "44444444-4444-4444-8444-444444444444";
const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("canvas export contracts", () => {
  it("round-trips a destination contribution that names later formats without rendering them", () => {
    const contribution = decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: "reading-copy",
      label: "Reading copy",
      formats: ["markdown", "html", "pdf", "png"],
    });

    expect(contribution.formats).toEqual(["markdown", "html", "pdf", "png"]);
  });

  it("accepts a link, a path, or a remote id as a receipt", () => {
    expect(
      decodeCanvasExportReceipt({ kind: "link", href: "https://example.test/copy" }).kind,
    ).toBe("link");
    expect(decodeCanvasExportReceipt({ kind: "path", path: "approved/copy.md" }).kind).toBe("path");
    expect(decodeCanvasExportReceipt({ kind: "remote-id", remoteId: "copy-1" }).kind).toBe(
      "remote-id",
    );
  });

  it("round-trips a journaled export that names the approval and the receipt", () => {
    const recorded = decodeCanvasExportRecorded({
      schemaVersion: 1,
      kind: "canvas-export",
      exportId,
      canvasId,
      versionId,
      sequence: 1,
      targetId: "reading-copy",
      destinationLabel: "Reading copy",
      format: "markdown",
      payloadDigest: digest,
      approvalId,
      outcome: { kind: "receipt", receipt: { kind: "remote-id", remoteId: "copy-1" } },
    });

    expect(recorded.kind).toBe("canvas-export");
    expect(recorded.outcome).toEqual({
      kind: "receipt",
      receipt: { kind: "remote-id", remoteId: "copy-1" },
    });
  });

  it("refuses a receipt that carries a credential", () => {
    expect(() =>
      decodeCanvasExportReceipt({
        kind: "link",
        href: "https://user:secret@example.test/copy",
      }),
    ).toThrow();
  });
});
