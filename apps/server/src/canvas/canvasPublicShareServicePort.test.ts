import { describe, expect, it } from "vitest";
import {
  decodeCanvasPublicShareDocument,
  decodeCanvasPublicShareId,
  decodeCanvasPublicShareServiceUrl,
} from "@octant/contracts/canvas-public-share";
import { CANVAS_SHARE_SCHEMA_VERSION } from "@octant/contracts/canvas-share";
import { createHttpCanvasPublicShareServicePort } from "./canvasPublicShareServicePort";

describe("public share transport", () => {
  it("keeps owned-create rejection from falling back to a legacy publication", async () => {
    const requests: Array<string> = [];
    const fetch = Object.assign(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        if (typeof init?.body !== "string") throw Error("Expected a JSON request.");
        requests.push(init.body);
        return Response.json(
          {
            schemaVersion: 1,
            kind: "canvas-public-share-refused",
            code: "malformed",
            message: "Unsupported creation request.",
          },
          { status: 400 },
        );
      },
      { preconnect: () => undefined },
    );
    const port = createHttpCanvasPublicShareServicePort(fetch);
    const outcome = await port.create({
      serviceUrl: decodeCanvasPublicShareServiceUrl("https://share.example"),
      shareId: decodeCanvasPublicShareId("B".repeat(22)),
      ownerSecret: "k".repeat(43),
      document: decodeCanvasPublicShareDocument({
        schemaVersion: 1,
        kind: "canvas-public-share-document",
        shareSchemaVersion: CANVAS_SHARE_SCHEMA_VERSION,
        title: "Example",
        publishedAt: "2026-11-08T10:00:00.000Z",
        blocks: [],
      }),
      expiry: { kind: "days", days: 30 },
    });
    expect(outcome).toMatchObject({ kind: "refused", code: "malformed" });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0] ?? "null")).toMatchObject({
      kind: "canvas-public-share-owned-create",
      shareId: "B".repeat(22),
      ownerSecret: "k".repeat(43),
    });
  });
});
