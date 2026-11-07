import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CanvasExportRenderedText } from "@octant/contracts/canvas-export";
import {
  SHAREHTML_DESTINATION_NOTE,
  SHAREHTML_EXPORT_TARGET_ID,
  SHAREHTML_EXPORT_TARGET_LABEL,
  createSharehtmlExportTarget,
} from "./sharehtmlExportTarget";
import type { SharehtmlCreateOutcome, SharehtmlPort } from "./sharehtmlPort";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

function document(input: {
  readonly title?: string;
  readonly body?: string;
  readonly format?: "markdown" | "html";
}): CanvasExportRenderedText {
  const body = input.body ?? "<h1>Launch plan</h1>\n";
  return Schema.decodeUnknownSync(CanvasExportRenderedText)({
    schemaVersion: 1,
    kind: "canvas-export-output",
    format: input.format ?? "html",
    title: input.title ?? "Launch plan",
    body,
    metadata: {
      canvasId,
      versionId,
      sequence: 1,
      byteLength: new TextEncoder().encode(body).length,
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  });
}

/** A sharehtml client that records every request and answers with a fixed outcome. */
function fakeSharehtml(outcome?: SharehtmlCreateOutcome) {
  const requests: string[] = [];
  const pages: SharehtmlPort = {
    createPage: async (html: string): Promise<SharehtmlCreateOutcome> => {
      requests.push(html);
      return (
        outcome ?? {
          kind: "created",
          id: "2b6f0c1e-7d2a-4d5a-9b1c-4f2e8a9d3c71",
          url: "https://k3x9q2a.sharehtml.org/",
          manageUrl: "https://sharehtml.org/m/manage-key",
        }
      );
    },
  };
  return { requests, pages };
}

describe("sharehtml export target", () => {
  it("declares one html format under its own id and label", () => {
    const { pages } = fakeSharehtml();
    const target = createSharehtmlExportTarget({ pages });
    expect(target.contribution.targetId).toBe(SHAREHTML_EXPORT_TARGET_ID);
    expect(target.contribution.label).toBe(SHAREHTML_EXPORT_TARGET_LABEL);
    expect(target.contribution.formats).toEqual(["html"]);
  });

  it("describes an always-unlisted destination with its note on the card", () => {
    const { pages } = fakeSharehtml();
    const target = createSharehtmlExportTarget({ pages });
    expect(target.describeDestination?.(document({}))).toEqual({
      note: SHAREHTML_DESTINATION_NOTE,
    });
  });

  it("refuses a non-html document without calling the service", async () => {
    const { requests, pages } = fakeSharehtml();
    const target = createSharehtmlExportTarget({ pages });
    const delivery = await target.exportDocument(document({ format: "markdown" }));
    expect(delivery).toEqual({
      kind: "refused",
      code: "unsupported-format",
      message: "sharehtml.org takes one rendered HTML page.",
    });
    expect(requests).toEqual([]);
  });

  it("refuses a page that still fails the share filter", async () => {
    const { requests, pages } = fakeSharehtml();
    const target = createSharehtmlExportTarget({ pages });
    const delivery = await target.exportDocument(
      document({ body: "<p>key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa</p>\n" }),
    );
    expect(delivery.kind).toBe("refused");
    expect(requests).toEqual([]);
  });

  it("posts the page and returns the link receipt with the remote id", async () => {
    const { requests, pages } = fakeSharehtml();
    const target = createSharehtmlExportTarget({ pages });
    const delivery = await target.exportDocument(document({}));
    expect(requests).toEqual(["<h1>Launch plan</h1>\n"]);
    expect(delivery).toEqual({
      kind: "receipt",
      receipt: {
        kind: "link",
        href: "https://k3x9q2a.sharehtml.org/",
        remoteId: "2b6f0c1e-7d2a-4d5a-9b1c-4f2e8a9d3c71",
      },
    });
  });

  it("maps a refused page from the service to a refusal", async () => {
    const { pages } = fakeSharehtml({
      kind: "refused",
      message: "the page failed the abuse heuristics",
    });
    const target = createSharehtmlExportTarget({ pages });
    const delivery = await target.exportDocument(document({}));
    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "the page failed the abuse heuristics",
    });
  });

  it("maps rate limiting to unavailable with a retry hint", async () => {
    const { pages } = fakeSharehtml({
      kind: "unavailable",
      message: "more than 5 uploads a minute. Try again later.",
    });
    const target = createSharehtmlExportTarget({ pages });
    const delivery = await target.exportDocument(document({}));
    expect(delivery).toEqual({
      kind: "refused",
      code: "unavailable",
      message: "more than 5 uploads a minute. Try again later.",
    });
  });
});
