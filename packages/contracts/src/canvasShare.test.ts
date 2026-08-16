import { describe, expect, it } from "vitest";
import {
  decodeCanvasStaticExportDocument,
  decodeCanvasStaticExportReceipt,
  decodeCanvasStaticExportRequest,
} from "./canvasShare";

const ids = {
  exportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  actor: "66666666-6666-4666-8666-666666666666",
  source: "77777777-7777-4777-8777-777777777777",
} as const;

const request = {
  schemaVersion: 1,
  kind: "canvas-static-export",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  expectedSequence: 1,
  hostId: "local",
  projectId: ids.project,
  channel: "static-export",
  consent: {
    acknowledgedOfflineSnapshot: true,
    acknowledgedNoCredentials: true,
    acknowledgedAt: "2026-08-04T12:00:00.000Z",
    acknowledgedBy: { kind: "local-user", actorId: ids.actor },
  },
  note: "Offline board pack for review",
} as const;

const document = {
  schemaVersion: 1,
  kind: "canvas-static-export-document",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  sequence: 1,
  exportedAt: "2026-08-04T12:00:01.000Z",
  title: "Weekly plan",
  channel: "static-export",
  sharingEnabled: true,
  provenance: {
    hostId: "local",
    projectId: ids.project,
    mode: "chat",
    threadId: ids.thread,
    createdAt: "2026-08-04T11:00:00.000Z",
    providerLabel: "provider",
    modelLabel: "model",
    actorKind: "local-user",
  },
  sourceManifest: [
    {
      sourceId: ids.source,
      kind: "artifact",
      displayName: "Artifact",
      opaqueRef: "artifact:one",
    },
  ],
  blocks: [
    {
      blockId: "heading-1",
      schemaVersion: 1,
      kind: "heading",
      level: 1,
      text: "Weekly plan",
    },
  ],
  threatModelId: "canvas-share-static-export-v1",
} as const;

describe("Canvas share contracts", () => {
  it("round-trips an explicit-consent static export request", () => {
    expect(decodeCanvasStaticExportRequest(request)).toEqual(request);
  });

  it("rejects missing consent acknowledgements", () => {
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        consent: {
          ...request.consent,
          acknowledgedOfflineSnapshot: false,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        consent: {
          acknowledgedOfflineSnapshot: true,
          acknowledgedAt: request.consent.acknowledgedAt,
          acknowledgedBy: request.consent.acknowledgedBy,
        },
      }),
    ).toThrow();
  });

  it("rejects system actors as consent principals", () => {
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        consent: {
          ...request.consent,
          acknowledgedBy: { kind: "system", actorId: ids.actor },
        },
      }),
    ).toThrow();
  });

  it("rejects export documents with unknown or source-bound block payloads", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "mystery-1",
            schemaVersion: 1,
            kind: "executable-plugin",
            payload: { token: "sk-1234567890abcdef" },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "source-1",
            schemaVersion: 1,
            kind: "source-reference",
            label: "Artifact",
            sourceId: ids.source,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects non-static channels and public-link shapes", () => {
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        channel: "authenticated-snapshot",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        publicUrl: "https://example.com/share",
      }),
    ).toThrow();
  });

  it("round-trips a sanitized static export document and receipt", () => {
    expect(decodeCanvasStaticExportDocument(document)).toEqual(document);
    const receipt = {
      schemaVersion: 1,
      kind: "canvas-static-export-receipt",
      exportId: ids.exportId,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      exportedAt: document.exportedAt,
      channel: "static-export",
      document,
      consent: request.consent,
      note: "Offline board pack for review",
    } as const;
    expect(decodeCanvasStaticExportReceipt(receipt)).toEqual(receipt);
  });

  it("rejects secret-bearing export text and credential query URLs at decode time", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "rich-1",
            schemaVersion: 1,
            kind: "rich-text",
            text: "token ghp_abcdefghijklmnopqrstuvwx",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "link-1",
            schemaVersion: 1,
            kind: "link",
            label: "Artifact",
            href: "https://example.test/file?token=opaque-secret",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects secret-bearing labels and host paths at decode time", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "metric-1",
            schemaVersion: 1,
            kind: "metric",
            label: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            value: 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "rich-path",
            schemaVersion: 1,
            kind: "rich-text",
            text: "See /Users/alice/project/.env for details",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "rich-file-url",
            schemaVersion: 1,
            kind: "rich-text",
            text: "file:///etc/passwd",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects authenticated-snapshot documents inside static-export receipts", () => {
    expect(() =>
      decodeCanvasStaticExportReceipt({
        schemaVersion: 1,
        kind: "canvas-static-export-receipt",
        exportId: ids.exportId,
        canvasId: ids.canvas,
        versionId: ids.version,
        sequence: 1,
        exportedAt: document.exportedAt,
        channel: "static-export",
        document: {
          ...document,
          channel: "authenticated-snapshot",
          threatModelId: "canvas-share-authenticated-snapshot-v1",
        },
        consent: request.consent,
      }),
    ).toThrow();
  });

  it("rejects secret-bearing document titles at decode time", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        title: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        title: "See /Users/alice/project/.env for details",
      }),
    ).toThrow();
  });
});
