import { describe, expect, it } from "vitest";
import {
  decodeProviderInstanceId,
  type PagePublishOutcome,
  type PagePublishRequest,
} from "@octant/contracts";
import {
  decodeCanvasExportRenderedOutput,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import type { CanvasExportHostPorts } from "@octant/plugin-api/canvas-export";
import type { PagePublisherOffer } from "@octant/plugin-api/page-publishing";
import { PAGE_EXPORT_TARGET_ID, createPageExportTarget, pageExportNote } from "./pageExportTarget";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-00000000000a");
const pageUrl = "https://pages.example/p/abc-123";

function document(input: {
  readonly body?: string;
  readonly format?: "markdown" | "html";
}): CanvasExportRenderedOutput {
  const body = input.body ?? "<!doctype html><title>Launch plan</title><p>Scope</p>";
  return decodeCanvasExportRenderedOutput({
    schemaVersion: 1,
    kind: "canvas-export-output",
    format: input.format ?? "html",
    title: "Launch plan",
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

/** Host ports whose page-publishing port lists one account (or none) and answers with a fixed outcome. */
function target(
  availability: PagePublisherOffer["availability"] | "none" = {
    kind: "ready",
    account: "Work account",
  },
  outcome: PagePublishOutcome = { kind: "published", address: pageUrl },
) {
  const requests: { readonly instanceId: string; readonly request: PagePublishRequest }[] = [];
  const ports: CanvasExportHostPorts = {
    pagePublishing: {
      publishers: () =>
        availability === "none" ? [] : [{ instanceId, label: "Work account", availability }],
      publish: async (target, request) => {
        requests.push({ instanceId: String(target), request });
        return outcome;
      },
    },
  };
  return { requests, target: createPageExportTarget(ports) };
}

describe("the page export destination", () => {
  it("publishes the rendered HTML under the Canvas title through the listed account and reports the page's link", async () => {
    const { requests, target: page } = target();
    const output = document({});

    const delivery = await page.exportDocument(output);

    expect(requests).toEqual([
      {
        instanceId: String(instanceId),
        request: { fileName: "Launch plan.html", title: "Launch plan", html: output.body },
      },
    ]);
    expect(delivery).toEqual({ kind: "receipt", receipt: { kind: "link", href: pageUrl } });
  });

  it("is labelled after the listed account and names it on the card, saying the page is private and never replaced", () => {
    const { target: page } = target();

    expect(page.contribution.label).toBe("Share to Work account");
    expect(page.describeDestination?.(document({}))).toEqual({
      account: "Work account",
      note: pageExportNote("Work account"),
    });
    expect(pageExportNote("Work account")).toContain("private");
    expect(pageExportNote("Work account")).toContain("new page");
  });

  it("declares HTML only and refuses Markdown without publishing", async () => {
    const { requests, target: page } = target();

    expect(String(page.contribution.targetId)).toBe(PAGE_EXPORT_TARGET_ID);
    expect(page.contribution.formats).toEqual(["html"]);
    const delivery = await page.exportDocument(document({ format: "markdown", body: "# Plan\n" }));
    expect(delivery).toMatchObject({ kind: "refused", code: "unsupported-format" });
    expect(requests).toHaveLength(0);
  });

  it("refuses a document that still carries a secret-shaped value without publishing anything", async () => {
    const { requests, target: page } = target();

    const delivery = await page.exportDocument(
      document({ body: "<p>key: ghp_abcdefghijklmnopqrstuvwxyz012345</p>" }),
    );

    expect(delivery).toMatchObject({ kind: "refused", code: "refused" });
    expect(requests).toHaveLength(0);
  });

  it("is not connected, describes nothing, and publishes nothing while the account is signed out", async () => {
    const { requests, target: page } = target({ kind: "not-signed-in" });

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(requests).toHaveLength(0);
    expect(page.describeDestination?.(document({}))).toBeUndefined();
  });

  it("is not connected and publishes nothing when the port lists no account", async () => {
    const { requests, target: page } = target("none");

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(requests).toHaveLength(0);
    expect(page.describeDestination?.(document({}))).toBeUndefined();
  });

  it("refuses with the account's reason when it cannot publish pages", async () => {
    const { requests, target: page } = target({
      kind: "refused",
      reason: "The account is signed in with an API key.",
    });

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The account is signed in with an API key.",
    });
    expect(requests).toHaveLength(0);
  });

  it("reports the provider's refusal as a refusal, never as a published page", async () => {
    const { target: page } = target(
      { kind: "ready", account: "Work account" },
      { kind: "refused", message: "The provider refused to publish the page." },
    );

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The provider refused to publish the page.",
    });
  });

  it("reports a provider that could not finish as unavailable, and a sign-in lost mid-way as not connected", async () => {
    const stalled = target(
      { kind: "ready", account: "Work account" },
      { kind: "unavailable", message: "The provider did not publish the page in time." },
    );
    expect(await stalled.target.exportDocument(document({}))).toMatchObject({
      kind: "refused",
      code: "unavailable",
    });

    const signedOut = target({ kind: "ready", account: "Work account" }, { kind: "not-signed-in" });
    expect(await signedOut.target.exportDocument(document({}))).toMatchObject({
      kind: "refused",
      code: "not-connected",
    });
  });
});
