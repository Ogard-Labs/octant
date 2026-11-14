import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import {
  loadMobileCodeEnvironment,
  loadMobileContextMeter,
  loadMobileLocalServers,
  loadMobileWorkingTreeReview,
  parseMobileUnifiedDiff,
} from "./mobileThreadPanesClient";

const threadId = "84000000-0000-4000-8000-000000000001";
const checkoutId = "85000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000002";
const contentId = "86000000-0000-4000-8000-000000000001";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " import { start } from './start';",
  "-start(false);",
  "+start(true);",
  "+// ready",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
].join("\n");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportAnswering(
  answer: (request: { readonly path: string; readonly body?: string }) => Response,
): MobileRemoteTransport {
  return {
    hostId: "host-1",
    authenticatedFetch: (async (request: { path: string; body?: string }) =>
      answer(request)) as MobileRemoteTransport["authenticatedFetch"],
  };
}

describe("phone thread panes", () => {
  it("counts each file's added and removed lines without reading headers as changes", () => {
    const files = parseMobileUnifiedDiff(DIFF);
    expect(files.map((file) => [file.path, file.additions, file.deletions, file.binary])).toEqual([
      ["src/app.ts", 2, 1, false],
      ["logo.png", 0, 0, true],
    ]);
    expect(files[0]?.lines.map((line) => line.kind)).toEqual([
      "hunk",
      "context",
      "removed",
      "added",
      "added",
    ]);
  });

  it("reads uncommitted changes by observing Git and resolving the diff it handed back", async () => {
    const paths: string[] = [];
    const transport = transportAnswering(({ path, body }) => {
      paths.push(path);
      const sent = JSON.parse(body ?? "{}") as {
        readonly kind?: string;
        readonly operationId?: string;
        readonly gitOperationId?: string;
      };
      if (path === "/api/code/commands") {
        expect(sent.kind).toBe("observe-git");
        return jsonResponse({
          kind: "git-observed",
          operationId: sent.operationId,
          gitOperationId: sent.gitOperationId,
          head: { kind: "branch", name: "feature/panes", oid: "b".repeat(40) },
          stateToken: "a".repeat(64),
          status: [{ path: "src/app.ts", index: " ", worktree: "M" }],
          changedPaths: ["src/app.ts"],
          diff: { contentId, digest: "d".repeat(64), byteLength: DIFF.length, truncated: false },
          remotes: [],
          upstream: null,
          worktrees: [],
        });
      }
      const asked = JSON.parse(body ?? "{}") as {
        readonly items: ReadonlyArray<{ readonly operationId: string }>;
      };
      return jsonResponse({
        threadId,
        items: [{ operationId: asked.items[0]?.operationId, contentId, text: DIFF }],
      });
    });

    const read = await loadMobileWorkingTreeReview(transport, { threadId, checkoutId });

    expect(paths).toEqual(["/api/code/commands", "/api/code/evidence/batch"]);
    expect(read).toMatchObject({
      status: "ready",
      value: { branch: "feature/panes", truncated: false },
    });
    expect(read.status === "ready" ? read.value.files.length : 0).toBe(2);
  });

  it("says the host refused a read instead of failing when a paired device may not have it", async () => {
    const read = await loadMobileCodeEnvironment(
      transportAnswering(() => jsonResponse({ category: "unauthorized" }, 403)),
      { threadId, projectId },
    );
    expect(read).toEqual({
      status: "refused",
      message:
        "The environment could not be read. This host does not share it with paired devices.",
    });
  });

  it("shows a local-server refusal in the host's own words", async () => {
    const transport = transportAnswering(({ body }) => {
      const sent = JSON.parse(body ?? "{}") as { readonly requestId?: string };
      return jsonResponse({
        kind: "local-server-rejected",
        requestId: sent.requestId,
        failure: { category: "unauthorized", message: "Local servers stay on the host." },
      });
    });
    await expect(loadMobileLocalServers(transport, { threadId, projectId })).resolves.toEqual({
      status: "refused",
      message: "Local servers stay on the host.",
    });
  });

  it("takes a Code thread's context fill from the newest turn that reported one", async () => {
    const turn = (operationId: string, usage?: Record<string, number>) => ({
      operationId,
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      sessionId: "87000000-0000-4000-8000-000000000001",
      prompt: { contentId, digest: "d".repeat(64), byteLength: 4 },
      assistant: [],
      status: "completed",
      startedAt: "2026-11-14T09:00:00.000Z",
      updatedAt: "2026-11-14T09:01:00.000Z",
      ...(usage === undefined ? {} : { usage }),
    });
    const transport = transportAnswering(() =>
      jsonResponse({
        version: 1,
        threadId,
        turns: [
          turn("88000000-0000-4000-8000-000000000001", {
            inputTokens: 10,
            outputTokens: 2,
            contextWindow: 200_000,
            contextTokens: 41_000,
          }),
          turn("88000000-0000-4000-8000-000000000002"),
        ],
        hasEarlier: false,
        hasLater: false,
      }),
    );
    await expect(loadMobileContextMeter(transport, { mode: "code", threadId })).resolves.toEqual({
      status: "ready",
      value: {
        kind: "measured",
        usedTokens: 41_000,
        windowTokens: 200_000,
        source: "provider-reported",
      },
    });
  });
});
