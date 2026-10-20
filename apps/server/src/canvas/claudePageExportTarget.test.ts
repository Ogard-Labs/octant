import { describe, expect, it } from "vitest";
import {
  decodeCanvasExportRenderedOutput,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import {
  CLAUDE_PAGE_EXPORT_TARGET_ID,
  CLAUDE_PAGE_NOTE,
  createClaudePageExportTarget,
} from "./claudePageExportTarget";
import type {
  ClaudePageAvailability,
  ClaudePagePublishOutcome,
  ClaudePagePublishRequest,
} from "../providers/claudePagePublisher";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const pageUrl = "https://claude.ai/artifact/abc-123";

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

/** A publisher that records every request and answers with a fixed outcome. */
function target(
  availability: ClaudePageAvailability = { kind: "ready", account: "Claude" },
  outcome: ClaudePagePublishOutcome = { kind: "published", url: pageUrl },
) {
  const requests: ClaudePagePublishRequest[] = [];
  return {
    requests,
    target: createClaudePageExportTarget({
      availability: () => availability,
      publish: async (request) => {
        requests.push(request);
        return outcome;
      },
    }),
  };
}

describe("the Share to Claude export destination", () => {
  it("publishes the rendered HTML under the Canvas title and reports the page's link", async () => {
    const { requests, target: page } = target();
    const output = document({});

    const delivery = await page.exportDocument(output);

    expect(requests).toEqual([
      { fileName: "Launch plan.html", title: "Launch plan", html: output.body },
    ]);
    expect(delivery).toEqual({ kind: "receipt", receipt: { kind: "link", href: pageUrl } });
  });

  it("names the account and says the page is private and never replaced on the card", () => {
    const { target: page } = target();

    expect(page.describeDestination?.(document({}))).toEqual({
      account: "Claude",
      note: CLAUDE_PAGE_NOTE,
    });
    expect(CLAUDE_PAGE_NOTE).toContain("private");
    expect(CLAUDE_PAGE_NOTE).toContain("new page");
  });

  it("declares HTML only and refuses Markdown without publishing", async () => {
    const { requests, target: page } = target();

    expect(String(page.contribution.targetId)).toBe(CLAUDE_PAGE_EXPORT_TARGET_ID);
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

  it("is not connected, describes nothing, and publishes nothing while Claude is signed out", async () => {
    const { requests, target: page } = target({ kind: "not-signed-in" });

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(requests).toHaveLength(0);
    expect(page.describeDestination?.(document({}))).toBeUndefined();
  });

  it("refuses with the account's reason when it cannot publish pages", async () => {
    const { requests, target: page } = target({
      kind: "refused",
      reason: "Claude is signed in with an API key.",
    });

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "Claude is signed in with an API key.",
    });
    expect(requests).toHaveLength(0);
  });

  it("reports the runtime's refusal as a refusal, never as a published page", async () => {
    const { target: page } = target(
      { kind: "ready", account: "Claude" },
      { kind: "refused", message: "The Claude runtime refused to publish the page." },
    );

    const delivery = await page.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The Claude runtime refused to publish the page.",
    });
  });

  it("reports a runtime that could not finish as unavailable, and a sign-in lost mid-way as not connected", async () => {
    const stalled = target(
      { kind: "ready", account: "Claude" },
      { kind: "unavailable", message: "Claude did not publish the page in time." },
    );
    expect(await stalled.target.exportDocument(document({}))).toMatchObject({
      kind: "refused",
      code: "unavailable",
    });

    const signedOut = target({ kind: "ready", account: "Claude" }, { kind: "not-signed-in" });
    expect(await signedOut.target.exportDocument(document({}))).toMatchObject({
      kind: "refused",
      code: "not-connected",
    });
  });
});
