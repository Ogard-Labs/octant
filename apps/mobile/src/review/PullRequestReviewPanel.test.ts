// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { decodeCodeThread } from "@octant/contracts";
import { ThemeProvider } from "../../design-system/theme";
import { PullRequestReviewPanel } from "./PullRequestReviewPanel";

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("../../design-system", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/tokens")),
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/theme")),
  ...(await vi.importActual<Record<string, unknown>>("../../design-system/tone")),
}));
vi.mock("./usePullRequestMerge", () => ({
  usePullRequestMerge: () => ({
    step: undefined,
    notice: undefined,
    begin: vi.fn(async () => undefined),
    confirm: vi.fn(async () => undefined),
    cancel: vi.fn(),
    turnOffMergeWhenReady: vi.fn(async () => undefined),
  }),
}));

const roots: Root[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const THREAD_ID = "84000000-0000-4000-8000-000000000010";
const CHECKOUT_ID = "30000000-0000-4000-8000-000000000001";
const NOW = "2026-11-26T12:00:00.000Z";
const HEAD_SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const EARLIER_COMMIT_SHA = "c".repeat(40);
const DIFF_CONTENT_ID = "10000000-0000-4000-8000-000000000901";

const SAMPLE_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,3 +10,4 @@",
  " export function check(token: string) {",
  "+  if (token.length === 0) return false;",
  "   return true;",
  " }",
].join("\n");

const codeThread = decodeCodeThread({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  bindingRevisionId: "70000000-0000-4000-8000-000000000001",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: CHECKOUT_ID,
  title: "Auth gate",
  lifecycle: "active",
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "fix/auth-gate",
    remoteName: "origin",
    proposedBaseRepository: "ogard-labs/octant",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: NOW,
  },
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

function createTransport(input: {
  readonly guideResponse: unknown | (() => unknown);
  readonly headSha?: string | undefined;
  readonly diffText?: string;
  readonly diffTruncated?: boolean;
}) {
  const calls: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> =
    [];
  const diffBytes =
    input.diffText === undefined ? 0 : new TextEncoder().encode(input.diffText).byteLength;
  const authoritativeHead = "headSha" in input ? input.headSha : HEAD_SHA;
  const transport: MobileRemoteTransport = {
    hostId: "host-1",
    authenticatedFetch: async (request) => {
      const parsedBody =
        typeof request.body === "string" && request.body.length > 0
          ? JSON.parse(request.body)
          : undefined;
      calls.push({ method: request.method, path: request.path, body: parsedBody });

      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json({
          settings: {
            version: 1,
            defaultExecutionPolicy: "approval-gated",
            defaultPermissionPersistence: "current-session",
            defaultAutoApprove: false,
            updatedAt: NOW,
          },
          threads: [codeThread],
          checkouts: [],
        });
      }

      if (request.method === "POST" && request.path === "/api/code/commands") {
        const command = parsedBody as { readonly operationId: string };
        return Response.json({
          kind: "pull-request-review",
          operationId: command.operationId,
          state: "observed",
          freshness: "fresh",
          ambiguous: false,
          staleSections: [],
          number: 42,
          url: "https://github.com/ogard-labs/octant/pull/42",
          title: "Tighten empty token check",
          pullRequestState: "open",
          baseRepository: "ogard-labs/octant",
          baseBranch: "main",
          headRepository: "ogard-labs/octant",
          headBranch: "fix/auth-gate",
          ...(authoritativeHead === undefined ? {} : { headSha: authoritativeHead }),
          author: "henrik",
          matchesDeliveryBranch: true,
          description: {
            contentId: "10000000-0000-4000-8000-000000000900",
            digest: "a".repeat(64),
            byteLength: 0,
            truncated: false,
          },
          diff: {
            contentId: DIFF_CONTENT_ID,
            digest: "b".repeat(64),
            byteLength: diffBytes,
            truncated: input.diffTruncated ?? false,
          },
          // Deliberately end the summary commits list at an earlier SHA to prove
          // freshness uses the authoritative headSha, never commits.at(-1).
          commits: [
            { oid: EARLIER_COMMIT_SHA, messageHeadline: "Earlier commit", author: "henrik" },
          ],
          files: [{ path: "src/auth.ts", additions: 1, deletions: 0 }],
          checks: [{ name: "CI", state: "success" }],
          reviews: [],
          comments: [],
        });
      }

      if (request.method === "POST" && request.path === "/api/code/pull-request-guides/query") {
        const body =
          typeof input.guideResponse === "function" ? input.guideResponse() : input.guideResponse;
        return Response.json(body);
      }

      if (request.method === "POST" && request.path === "/api/code/evidence/batch") {
        const body = parsedBody as {
          readonly threadId: string;
          readonly items: ReadonlyArray<{
            readonly operationId: string;
            readonly contentId: string;
          }>;
        };
        const item = body.items[0];
        return Response.json({
          threadId: body.threadId,
          items:
            item === undefined || input.diffText === undefined
              ? []
              : [
                  {
                    operationId: item.operationId,
                    contentId: item.contentId,
                    text: input.diffText,
                  },
                ],
        });
      }

      return new Response("Not found", { status: 404 });
    },
  };
  return { calls, transport };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountPanel(transport: MobileRemoteTransport) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(PullRequestReviewPanel, {
          transport,
          threadId: THREAD_ID,
        }),
      }),
    );
  });
  await flush();
  return container;
}

describe("the phone's pull request review guide", () => {
  it("lists stops in order with Needs your decision, highlights fresh anchor lines, warns on truncated patches, and offers no write controls", async () => {
    const { calls, transport } = createTransport({
      diffText: SAMPLE_DIFF,
      diffTruncated: true,
      guideResponse: {
        guide: {
          guideId: "40000000-0000-4000-8000-000000000001",
          headSha: HEAD_SHA,
          providerInstanceId: "60000000-0000-4000-8000-000000000001",
          modelId: "claude-sonnet-4",
          recordedAt: NOW,
          stops: [
            {
              id: "token-gate",
              title: "Reject empty bearer tokens",
              why: "Stops blank credentials before signature parsing.",
              needsDecision: true,
              anchors: [{ path: "src/auth.ts", startLine: 11, endLine: 11 }],
            },
            {
              id: "follow-up",
              title: "Keep default path intact",
              why: "Valid tokens still return true.",
              needsDecision: false,
              anchors: [],
            },
          ],
        },
        stale: false,
        running: false,
        modelPicked: true,
      },
    });

    const container = await mountPanel(transport);

    const queryCall = calls.find((call) => call.path === "/api/code/pull-request-guides/query");
    expect(queryCall?.body).toEqual({
      target: {
        projectId: PROJECT_ID,
        repositoryOwner: "ogard-labs",
        repositoryName: "octant",
        number: 42,
      },
      headSha: HEAD_SHA,
    });

    expect(container.querySelector("[data-testid='mobile-pr-guide-stale']")).toBeNull();

    const stop0 = container.querySelector("[data-testid='mobile-pr-guide-stop-0']");
    const stop1 = container.querySelector("[data-testid='mobile-pr-guide-stop-1']");
    expect(stop0?.textContent).toContain("1. Reject empty bearer tokens");
    expect(stop0?.textContent).toContain("Needs your decision");
    expect(stop0?.textContent).toContain("Stops blank credentials before signature parsing.");
    expect(stop1?.textContent).toContain("2. Keep default path intact");
    expect(stop1?.textContent).not.toContain("Needs your decision");
    expect(stop1?.textContent).toContain("Not anchored to the diff.");

    const text = container.textContent ?? "";
    expect(text).not.toContain("Write guide");
    expect(text).not.toContain("Rewrite");
    expect(calls.some((call) => call.path === "/api/code/pull-request-guides/write")).toBe(false);

    const anchorButton = container.querySelector<HTMLElement>(
      "[data-testid='mobile-pr-guide-anchor-token-gate-0']",
    );
    expect(anchorButton?.textContent).toBe("src/auth.ts:11");
    await act(async () => {
      anchorButton?.click();
    });
    await flush();

    expect(container.querySelector("[data-testid='mobile-pr-file-path']")?.textContent).toBe(
      "src/auth.ts",
    );
    expect(container.textContent).toContain("Line 11");
    expect(
      container.querySelector("[data-testid='mobile-pr-file-anchor-line-11']")?.textContent,
    ).toContain("if (token.length === 0) return false;");
    // Even with captured lines present, a truncated diff shows the truncation warning.
    expect(container.querySelector("[data-testid='mobile-pr-file-truncated']")).not.toBeNull();

    const backButton = container.querySelector<HTMLElement>("[data-testid='mobile-pr-file-back']");
    await act(async () => {
      backButton?.click();
    });
    expect(container.querySelector("[data-testid='mobile-pr-guide']")).not.toBeNull();
  });

  it("warns on a stale guide and opens its anchored file without highlighting old line numbers", async () => {
    const { transport } = createTransport({
      diffText: SAMPLE_DIFF,
      guideResponse: {
        guide: {
          guideId: "40000000-0000-4000-8000-000000000002",
          headSha: OLD_SHA,
          providerInstanceId: "60000000-0000-4000-8000-000000000001",
          modelId: "claude-sonnet-4",
          recordedAt: NOW,
          stops: [
            {
              id: "stale-stop",
              title: "Moved check",
              why: "Originally at line 11 before a push moved it.",
              needsDecision: false,
              anchors: [{ path: "src/auth.ts", startLine: 11, endLine: 11 }],
            },
          ],
        },
        stale: true,
        running: false,
        modelPicked: true,
      },
    });

    const container = await mountPanel(transport);
    expect(container.querySelector("[data-testid='mobile-pr-guide-stale']")?.textContent).toBe(
      "Written for an older push.",
    );

    const anchorButton = container.querySelector<HTMLElement>(
      "[data-testid='mobile-pr-guide-anchor-stale-stop-0']",
    );
    await act(async () => {
      anchorButton?.click();
    });
    await flush();

    expect(container.querySelector("[data-testid='mobile-pr-file-path']")?.textContent).toBe(
      "src/auth.ts",
    );
    expect(container.querySelector("[data-testid='mobile-pr-file-anchor-line-11']")).toBeNull();
    expect(
      container.querySelector("[data-testid='mobile-pr-file-anchor-stale']")?.textContent,
    ).toContain("Written for an older push");
  });

  it("reports unknown freshness when the host omits headSha and offers no Write guide when empty", async () => {
    const emptyHost = createTransport({
      headSha: undefined,
      guideResponse: {
        stale: false,
        running: false,
        modelPicked: true,
      },
    });
    const emptyContainer = await mountPanel(emptyHost.transport);
    expect(emptyContainer.querySelector("[data-testid='mobile-pr-guide-empty']")?.textContent).toBe(
      "No guide for this push yet.",
    );
    expect(emptyContainer.querySelector("[data-testid='mobile-pr-guide-stale']")).toBeNull();
    expect(emptyContainer.textContent).not.toContain("Write guide");
    expect(emptyContainer.textContent).not.toContain("Rewrite");
    const emptyQuery = emptyHost.calls.find(
      (call) => call.path === "/api/code/pull-request-guides/query",
    );
    expect(emptyQuery?.body).toEqual({
      target: {
        projectId: PROJECT_ID,
        repositoryOwner: "ogard-labs",
        repositoryName: "octant",
        number: 42,
      },
    });

    const unknownHeadHost = createTransport({
      headSha: undefined,
      guideResponse: {
        guide: {
          guideId: "40000000-0000-4000-8000-000000000003",
          headSha: HEAD_SHA,
          providerInstanceId: "60000000-0000-4000-8000-000000000001",
          modelId: "claude-sonnet-4",
          recordedAt: NOW,
          stops: [],
        },
        stale: false,
        running: false,
        modelPicked: true,
      },
    });
    const unknownContainer = await mountPanel(unknownHeadHost.transport);
    expect(
      unknownContainer.querySelector("[data-testid='mobile-pr-guide-freshness-unknown']")
        ?.textContent,
    ).toContain("freshness could not be checked");
  });
});
