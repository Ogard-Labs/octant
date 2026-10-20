import { describe, expect, it } from "vitest";
import { decodeCanvasExportDecideRequest, isCanvasExportImplementedFormat } from "./canvasExport";
import {
  decodeCanvasPublicShareCreateRequest,
  decodeCanvasPublicShareDocument,
  decodeCanvasPublicShareId,
  decodeCanvasPublicShareOwnerSecret,
  decodeCanvasPublicShareServiceUrl,
} from "./canvasPublicShare";
import { CANVAS_SHARE_SCHEMA_VERSION } from "./canvasShare";

const document = {
  schemaVersion: 1,
  kind: "canvas-public-share-document",
  shareSchemaVersion: CANVAS_SHARE_SCHEMA_VERSION,
  title: "Launch plan",
  publishedAt: "2026-10-20T10:00:00.000Z",
  blocks: [{ blockId: "intro", schemaVersion: 1, kind: "heading", level: 1, text: "Launch" }],
};

describe("a public share document", () => {
  it("carries the shared blocks and no host, Project, thread, or Canvas identity", () => {
    expect(decodeCanvasPublicShareDocument(document).blocks).toHaveLength(1);
    for (const field of ["canvasId", "hostId", "projectId", "provenance", "sourceManifest"]) {
      expect(() => decodeCanvasPublicShareDocument({ ...document, [field]: "x" })).toThrow();
    }
  });

  it("refuses an action block", () => {
    const action = { blockId: "go", schemaVersion: 1, kind: "action", label: "Run" };
    expect(() => decodeCanvasPublicShareDocument({ ...document, blocks: [action] })).toThrow();
  });

  it("refuses a title that names a file on the host", () => {
    expect(() =>
      decodeCanvasPublicShareDocument({ ...document, title: "See /Users/someone/notes.md" }),
    ).toThrow();
  });
});

describe("public share identities", () => {
  it("accepts only 22-character URL-safe ids, which hold 128 bits", () => {
    expect(String(decodeCanvasPublicShareId("AbCdEfGhIjKlMnOpQrSt_-"))).toHaveLength(22);
    expect(() => decodeCanvasPublicShareId("short")).toThrow();
    expect(() => decodeCanvasPublicShareId("AbCdEfGhIjKlMnOpQrSt+/")).toThrow();
  });

  it("accepts only 43-character owner secrets", () => {
    expect(() => decodeCanvasPublicShareOwnerSecret("a".repeat(43))).not.toThrow();
    expect(() => decodeCanvasPublicShareOwnerSecret("a".repeat(42))).toThrow();
  });
});

describe("a public share service address", () => {
  it("is https, or http only on the loopback address", () => {
    expect(() => decodeCanvasPublicShareServiceUrl("https://canvas.octant.sh")).not.toThrow();
    expect(() => decodeCanvasPublicShareServiceUrl("http://127.0.0.1:4100")).not.toThrow();
    expect(() => decodeCanvasPublicShareServiceUrl("http://canvas.example")).toThrow();
    expect(() => decodeCanvasPublicShareServiceUrl("https://user:pw@canvas.example")).toThrow();
  });
});

describe("link terms on the wire", () => {
  it("bounds the expiry at 365 days and the password at 8 characters", () => {
    const create = { schemaVersion: 1, kind: "canvas-public-share-create", document };
    expect(() =>
      decodeCanvasPublicShareCreateRequest({ ...create, expiry: { kind: "days", days: 30 } }),
    ).not.toThrow();
    expect(() =>
      decodeCanvasPublicShareCreateRequest({ ...create, expiry: { kind: "never" } }),
    ).not.toThrow();
    expect(() =>
      decodeCanvasPublicShareCreateRequest({ ...create, expiry: { kind: "days", days: 366 } }),
    ).toThrow();
    expect(() =>
      decodeCanvasPublicShareCreateRequest({
        ...create,
        expiry: { kind: "days", days: 30 },
        password: "short",
      }),
    ).toThrow();
  });

  it("lets the export decision carry the person's expiry and password", () => {
    const decided = decodeCanvasExportDecideRequest({
      schemaVersion: 1,
      kind: "canvas-export-decision",
      canvasId: "11111111-1111-4111-8111-111111111111",
      approvalId: "44444444-4444-4444-8444-444444444444",
      decision: "approved",
      link: { expiry: { kind: "never" }, password: "correct horse" },
    });
    expect(decided.link?.expiry.kind).toBe("never");
    expect(isCanvasExportImplementedFormat("share-document")).toBe(true);
  });
});
