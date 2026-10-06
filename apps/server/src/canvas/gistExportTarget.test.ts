import { describe, expect, it } from "vitest";
import type { GithubAuthenticationSnapshot } from "@octant/contracts/github-onboarding";
import {
  decodeCanvasExportRenderedOutput,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import {
  GIST_EXPORT_TARGET_ID,
  GIST_PUBLIC_NOTE,
  createGistExportTarget,
  gistExportAvailability,
  type GistExportAvailability,
} from "./gistExportTarget";
import type { GistCreationRequest, GistCreationResult } from "../github/gistCreationPort";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

function document(input: {
  readonly title?: string;
  readonly body?: string;
  readonly format?: "markdown" | "html";
}): CanvasExportRenderedOutput {
  const body = input.body ?? "# Launch plan\n";
  return decodeCanvasExportRenderedOutput({
    schemaVersion: 1,
    kind: "canvas-export-output",
    format: input.format ?? "markdown",
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

/** A GitHub client that records every request and answers with a fixed gist. */
function fakeGithub(result?: GistCreationResult) {
  const requests: GistCreationRequest[] = [];
  return {
    requests,
    gists: {
      create: async (input: GistCreationRequest): Promise<GistCreationResult> => {
        requests.push(input);
        return (
          result ?? {
            kind: "created",
            gist: {
              id: "aa11bb22cc33dd44",
              url: "https://gist.github.com/octocat/aa11bb22cc33dd44",
            },
          }
        );
      },
    },
  };
}

function target(
  availability: GistExportAvailability = { kind: "ready", account: "octocat" },
  github = fakeGithub(),
) {
  return {
    github,
    target: createGistExportTarget({ availability: () => availability, gists: github.gists }),
  };
}

describe("the GitHub Gist export destination", () => {
  it("posts the rendered document as a secret gist and reports the URL and id it created", async () => {
    const { github, target: gist } = target();
    const output = document({});

    const delivery = await gist.exportDocument(output);

    expect(github.requests).toEqual([
      {
        fileName: "Launch plan.md",
        content: output.body,
        description: "Launch plan",
        visibility: "secret",
      },
    ]);
    expect(delivery).toEqual({
      kind: "receipt",
      receipt: {
        kind: "link",
        href: "https://gist.github.com/octocat/aa11bb22cc33dd44",
        remoteId: "aa11bb22cc33dd44",
      },
    });
  });

  it("posts a public gist when the person chose public on the card", async () => {
    const { github, target: gist } = target();

    await gist.exportDocument(document({}), { visibility: "public" });

    expect(github.requests[0]?.visibility).toBe("public");
  });

  it("names the account and says a public gist is visible to anyone on the card", () => {
    const { target: gist } = target();

    expect(gist.describeDestination?.(document({}))).toEqual({
      account: "octocat",
      visibility: "secret",
      note: GIST_PUBLIC_NOTE,
    });
    expect(GIST_PUBLIC_NOTE).toContain("visible to anyone");
  });

  it("refuses a document that still carries a secret-shaped value without posting anything", async () => {
    const { github, target: gist } = target();
    const output = document({
      body: "# Launch plan\n\nkey: ghp_abcdefghijklmnopqrstuvwxyz012345\n",
    });

    const delivery = await gist.exportDocument(output);

    expect(delivery).toMatchObject({ kind: "refused", code: "refused" });
    expect(github.requests).toHaveLength(0);
  });

  it("refuses and posts nothing when GitHub is not connected", async () => {
    const { github, target: gist } = target({ kind: "not-connected" });

    const delivery = await gist.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(github.requests).toHaveLength(0);
    expect(gist.describeDestination?.(document({}))).toBeUndefined();
  });

  it("refuses when the credential is stored insecurely, without posting anything", async () => {
    const { github, target: gist } = target({
      kind: "refused",
      reason: "GitHub is signed in with credentials stored in plain text on this Mac.",
    });

    const delivery = await gist.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "refused" });
    expect(github.requests).toHaveLength(0);
  });

  it("reports refused with a clear message when GitHub answers 401", async () => {
    const { target: gist } = target(
      { kind: "ready", account: "octocat" },
      fakeGithub({ kind: "unauthorized" }),
    );

    const delivery = await gist.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "GitHub refused the credential. Reconnect GitHub and try again.",
    });
  });

  it("reports unavailable without claiming the document was posted when GitHub cannot be reached", async () => {
    const { target: gist } = target(
      { kind: "ready", account: "octocat" },
      fakeGithub({ kind: "unavailable" }),
    );

    const delivery = await gist.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "unavailable" });
  });

  it("declares Markdown only for the gist destination", () => {
    const { target: gist } = target();

    expect(String(gist.contribution.targetId)).toBe(GIST_EXPORT_TARGET_ID);
    expect(gist.contribution.formats).toEqual(["markdown"]);
  });

  it("refuses a format the gist destination does not write", async () => {
    const { github, target: gist } = target();

    const delivery = await gist.exportDocument(document({ format: "html" }));

    expect(delivery).toMatchObject({ kind: "refused", code: "unsupported-format" });
    expect(github.requests).toHaveLength(0);
  });
});

describe("the gist destination's state from the GitHub connection", () => {
  function snapshot(
    input: Pick<GithubAuthenticationSnapshot, "state"> & Partial<GithubAuthenticationSnapshot>,
  ): GithubAuthenticationSnapshot {
    return { capabilities: [], ...input };
  }

  it("is ready as the connected account when GitHub is authenticated", () => {
    const ready = gistExportAvailability(
      snapshot({
        state: "ready",
        account: { login: "octocat", gitProtocol: "https", scopes: ["gist"] },
      }),
    );

    expect(ready).toEqual({ kind: "ready", account: "octocat" });
  });

  it("reports refused, not not-connected, when the credential store is insecure", () => {
    const refused = gistExportAvailability(snapshot({ state: "insecure-storage" }));

    expect(refused.kind).toBe("refused");
  });

  it("is not-connected when there is no usable GitHub connection", () => {
    expect(gistExportAvailability(snapshot({ state: "unauthorized" })).kind).toBe("not-connected");
    expect(gistExportAvailability(snapshot({ state: "unavailable" })).kind).toBe("not-connected");
    expect(gistExportAvailability(snapshot({ state: "rate-limited" })).kind).toBe("not-connected");
    expect(gistExportAvailability(snapshot({ state: "external-token" })).kind).toBe(
      "not-connected",
    );
  });

  it("is not-connected when a ready state carries no account to post as", () => {
    expect(gistExportAvailability(snapshot({ state: "ready" })).kind).toBe("not-connected");
  });
});
