import { describe, expect, it } from "vitest";
import {
  decodeCanvasExportApprovalCard,
  decodeCanvasExportContribution,
  decodeCanvasExportDecideRequest,
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

  it("accepts a link, a file path, or a remote id as a receipt", () => {
    expect(
      decodeCanvasExportReceipt({ kind: "link", href: "https://example.test/copy" }).kind,
    ).toBe("link");
    expect(
      decodeCanvasExportReceipt({ kind: "path", path: "/Users/example/Documents/copy.md" }).kind,
    ).toBe("path");
    expect(decodeCanvasExportReceipt({ kind: "remote-id", remoteId: "copy-1" }).kind).toBe(
      "remote-id",
    );
  });

  it("refuses a receipt path that is not an absolute file on this machine", () => {
    // A local destination reports where it wrote, so a bare name tells the
    // person nothing and is not the path of anything.
    expect(() => decodeCanvasExportReceipt({ kind: "path", path: "approved/copy.md" })).toThrow();
  });

  it("names the file on an approval card and refuses a replacement claim without one", () => {
    const card = {
      schemaVersion: 1,
      kind: "canvas-export-approval",
      approvalId,
      canvasId,
      versionId,
      sequence: 1,
      targetId: "folder-on-this-mac",
      destinationLabel: "A folder on this Mac",
      format: "markdown",
      title: "Launch plan",
      payload: "# Launch plan",
      payloadDigest: digest,
      byteLength: 14,
      expiresAt: "2026-08-01T21:10:00.000Z",
    } as const;

    const named = decodeCanvasExportApprovalCard({
      ...card,
      destinationPath: "/Users/example/Documents/Launch plan.md",
      replacesExisting: true,
    });
    expect(named.destinationPath).toBe("/Users/example/Documents/Launch plan.md");

    expect(() => decodeCanvasExportApprovalCard({ ...card, replacesExisting: true })).toThrow();
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

  it("journals the written path a local destination reported", () => {
    const recorded = decodeCanvasExportRecorded({
      schemaVersion: 1,
      kind: "canvas-export",
      exportId,
      canvasId,
      versionId,
      sequence: 1,
      targetId: "folder-on-this-mac",
      destinationLabel: "A folder on this Mac",
      format: "markdown",
      payloadDigest: digest,
      approvalId,
      outcome: {
        kind: "receipt",
        receipt: { kind: "path", path: "/Users/example/Documents/Launch plan.md" },
      },
    });

    expect(recorded.outcome).toEqual({
      kind: "receipt",
      receipt: { kind: "path", path: "/Users/example/Documents/Launch plan.md" },
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

  it("carries a remote id alongside a link so a gist's URL and id are one receipt", () => {
    const receipt = decodeCanvasExportReceipt({
      kind: "link",
      href: "https://gist.github.com/octocat/aa11bb22cc33dd44",
      remoteId: "aa11bb22cc33dd44",
    });

    expect(receipt).toEqual({
      kind: "link",
      href: "https://gist.github.com/octocat/aa11bb22cc33dd44",
      remoteId: "aa11bb22cc33dd44",
    });
  });

  it("names the account and the audience on an approval card for a remote destination", () => {
    const card = {
      schemaVersion: 1,
      kind: "canvas-export-approval",
      approvalId,
      canvasId,
      versionId,
      sequence: 1,
      targetId: "github-gist",
      destinationLabel: "GitHub Gist",
      format: "markdown",
      title: "Launch plan",
      destinationAccount: "octocat",
      destinationVisibility: "secret",
      destinationNote: "A public gist is visible to anyone on the internet.",
      payload: "# Launch plan",
      payloadDigest: digest,
      byteLength: 14,
      expiresAt: "2026-08-01T21:10:00.000Z",
    } as const;

    const decoded = decodeCanvasExportApprovalCard(card);

    expect(decoded.destinationAccount).toBe("octocat");
    expect(decoded.destinationVisibility).toBe("secret");
    expect(decoded.destinationNote).toContain("visible to anyone");
  });

  it("refuses a card note that carries a secret", () => {
    const card = {
      schemaVersion: 1,
      kind: "canvas-export-approval",
      approvalId,
      canvasId,
      versionId,
      sequence: 1,
      targetId: "github-gist",
      destinationLabel: "GitHub Gist",
      format: "markdown",
      title: "Launch plan",
      destinationNote: "token ghp_abcdefghijklmnopqrstuvwxyz012345",
      payload: "# Launch plan",
      payloadDigest: digest,
      byteLength: 14,
      expiresAt: "2026-08-01T21:10:00.000Z",
    } as const;

    expect(() => decodeCanvasExportApprovalCard(card)).toThrow();
  });

  it("carries the audience the person chose on a decide request, and omits it when unset", () => {
    const chosen = decodeCanvasExportDecideRequest({
      schemaVersion: 1,
      kind: "canvas-export-decision",
      canvasId,
      approvalId,
      decision: "approved",
      visibility: "public",
    });
    expect(chosen.visibility).toBe("public");

    const plain = decodeCanvasExportDecideRequest({
      schemaVersion: 1,
      kind: "canvas-export-decision",
      canvasId,
      approvalId,
      decision: "approved",
    });
    expect(plain.visibility).toBeUndefined();
  });
});
