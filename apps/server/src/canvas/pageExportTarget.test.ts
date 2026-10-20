import { describe, expect, it } from "vitest";
import { decodeProviderInstanceId, type PagePublishOutcome } from "@octant/contracts";
import {
  decodeCanvasExportRenderedOutput,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import type { CanvasExportGrants, CanvasExportHostPorts } from "@octant/plugin-api/canvas-export";
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

/**
 * Host ports whose page-publishing port lists one account (or none), and the
 * grant the host would hand an approved export, answering with a fixed
 * outcome and recording which instance it was asked to publish on. The port
 * itself can publish nothing, so the destination holds no page to publish
 * until the grant arrives.
 */
function target(
  availability: PagePublisherOffer["availability"] | "none" = {
    kind: "ready",
    account: "Work account",
  },
  outcome: PagePublishOutcome = { kind: "published", address: pageUrl },
) {
  const requests: string[] = [];
  const ports: CanvasExportHostPorts = {
    pagePublishing: {
      publishers: () =>
        availability === "none" ? [] : [{ instanceId, label: "Work account", availability }],
    },
  };
  const grants: CanvasExportGrants = {
    publishPage: async (target) => {
      requests.push(String(target));
      return outcome;
    },
  };
  return { requests, grants, target: createPageExportTarget(ports) };
}

describe("the page export destination", () => {
  it("publishes the approved render through the grant on the listed account and reports the page's link", async () => {
    const { requests, grants, target: page } = target();

    const delivery = await page.exportDocument(document({}), undefined, grants);

    expect(requests).toEqual([String(instanceId)]);
    expect(delivery).toEqual({ kind: "receipt", receipt: { kind: "link", href: pageUrl } });
  });

  it("publishes nothing when called without the host's grant", async () => {
    const { requests, target: page } = target();

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "refused" });
    expect(requests).toHaveLength(0);
  });

  it("is labelled after the listed account and names it as the card's publisher, saying the page is private and never replaced", () => {
    const { target: page } = target();

    expect(page.contribution.label).toBe("Share to Work account");
    expect(page.describeDestination?.(document({}))).toEqual({
      publisher: instanceId,
      account: "Work account",
      note: pageExportNote("Work account"),
    });
    expect(pageExportNote("Work account")).toContain("private");
    expect(pageExportNote("Work account")).toContain("new page");
  });

  it("declares HTML only and refuses Markdown without publishing", async () => {
    const { requests, grants, target: page } = target();

    expect(String(page.contribution.targetId)).toBe(PAGE_EXPORT_TARGET_ID);
    expect(page.contribution.formats).toEqual(["html"]);
    const delivery = await page.exportDocument(
      document({ format: "markdown", body: "# Plan\n" }),
      undefined,
      grants,
    );
    expect(delivery).toMatchObject({ kind: "refused", code: "unsupported-format" });
    expect(requests).toHaveLength(0);
  });

  it("refuses a document that still carries a secret-shaped value without publishing anything", async () => {
    const { requests, grants, target: page } = target();

    const delivery = await page.exportDocument(
      document({ body: "<p>key: ghp_abcdefghijklmnopqrstuvwxyz012345</p>" }),
      undefined,
      grants,
    );

    expect(delivery).toMatchObject({ kind: "refused", code: "refused" });
    expect(requests).toHaveLength(0);
  });

  it("is not connected, describes nothing, and publishes nothing while the account is signed out", async () => {
    const { requests, grants, target: page } = target({ kind: "not-signed-in" });

    const delivery = await page.exportDocument(document({}), undefined, grants);

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(requests).toHaveLength(0);
    expect(page.describeDestination?.(document({}))).toBeUndefined();
  });

  it("is not connected and publishes nothing when the port lists no account", async () => {
    const { requests, grants, target: page } = target("none");

    const delivery = await page.exportDocument(document({}), undefined, grants);

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(requests).toHaveLength(0);
    expect(page.describeDestination?.(document({}))).toBeUndefined();
  });

  it("refuses with the account's reason when it cannot publish pages", async () => {
    const {
      requests,
      grants,
      target: page,
    } = target({
      kind: "refused",
      reason: "The account is signed in with an API key.",
    });

    const delivery = await page.exportDocument(document({}), undefined, grants);

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The account is signed in with an API key.",
    });
    expect(requests).toHaveLength(0);
  });

  it("reports the provider's refusal as a refusal, never as a published page", async () => {
    const { grants, target: page } = target(
      { kind: "ready", account: "Work account" },
      { kind: "refused", message: "The provider refused to publish the page." },
    );

    const delivery = await page.exportDocument(document({}), undefined, grants);

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
    expect(
      await stalled.target.exportDocument(document({}), undefined, stalled.grants),
    ).toMatchObject({ kind: "refused", code: "unavailable" });

    const signedOut = target({ kind: "ready", account: "Work account" }, { kind: "not-signed-in" });
    expect(
      await signedOut.target.exportDocument(document({}), undefined, signedOut.grants),
    ).toMatchObject({ kind: "refused", code: "not-connected" });
  });
});
