import { describe, expect, it } from "vitest";
import { readAgentDiff, searchAgentCheckoutPaths, selectAgentDiff } from "./agentDiff";
import type { OpenedLocalControlSession } from "./localControl";

const threadId = "00000000-0000-4000-8000-000000000001";
const checkoutId = "00000000-0000-4000-8000-000000000002";
const contentId = "00000000-0000-4000-8000-000000000003";

describe("terminal checkout review", () => {
  it("reads the host's current checkout diff and identifies paths without diff text", async () => {
    const requests: string[] = [];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "window",
      close: async () => undefined,
      send: async (request) => {
        requests.push(request.path);
        const body = request.body as Record<string, any>;
        if (request.path === "/api/code/commands")
          return {
            status: 200,
            body: {
              kind: "git-observed",
              operationId: body.operationId,
              gitOperationId: body.gitOperationId,
              head: { kind: "branch", name: "main", oid: "b".repeat(40) },
              stateToken: "a".repeat(64),
              status: [],
              changedPaths: ["src/a.ts", "new.txt"],
              diff: { contentId, digest: "d".repeat(64), byteLength: 40, truncated: true },
              remotes: [],
              upstream: null,
              worktrees: [],
            },
          };
        return {
          status: 200,
          body: {
            threadId,
            items: [
              {
                ...body.items[0],
                text: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
              },
            ],
          },
        };
      },
    };
    const result = await readAgentDiff(session, threadId, checkoutId);
    expect(requests).toEqual(["/api/code/commands", "/api/code/evidence/batch"]);
    expect(result).toMatchObject({
      kind: "ready",
      branch: "main",
      truncated: true,
      missingPaths: ["new.txt"],
    });
    if (result.kind === "ready") expect(result.text).toContain("+new");
  });

  it("does not present evidence from a different thread as the checkout diff", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "window",
      close: async () => undefined,
      send: async (request) => {
        const body = request.body as Record<string, any>;
        if (request.path === "/api/code/commands")
          return {
            status: 200,
            body: {
              kind: "git-observed",
              operationId: body.operationId,
              gitOperationId: body.gitOperationId,
              head: { kind: "branch", name: "main", oid: "b".repeat(40) },
              stateToken: "a".repeat(64),
              status: [],
              changedPaths: ["src/a.ts"],
              diff: { contentId, digest: "d".repeat(64), byteLength: 40, truncated: false },
              remotes: [],
              upstream: null,
              worktrees: [],
            },
          };
        return {
          status: 200,
          body: { threadId: checkoutId, items: [{ ...body.items[0], text: "wrong evidence" }] },
        };
      },
    };
    await expect(readAgentDiff(session, threadId, checkoutId)).resolves.toMatchObject({
      kind: "refused",
    });
  });
});

it("opens exactly the chosen file's host diff, including its headers", () => {
  const text =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n";
  const read = selectAgentDiff(
    {
      kind: "ready",
      text,
      truncated: false,
      files: [
        { path: "a.ts", additions: 1, deletions: 1 },
        { path: "b.ts", additions: 1, deletions: 1 },
      ],
      missingPaths: [],
    },
    "b.ts",
  );
  expect(read.kind).toBe("ready");
  if (read.kind === "ready") {
    expect(read.text).toContain("diff --git a/b.ts b/b.ts");
    expect(read.text).not.toContain("a/a.ts");
  }
});

describe("terminal file suggestions", () => {
  it("suggests files from the checkout the host binds to the thread, not from a local folder", async () => {
    const requests: string[] = [];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "window",
      close: async () => undefined,
      send: async (request) => {
        requests.push(`${request.method} ${request.path}`);
        return {
          status: 200,
          body: {
            status: "searched",
            search: {
              kind: "code-search",
              threadId,
              checkoutId,
              scope: "path",
              query: "ag",
              matches: [
                { scope: "path", fileId: contentId, path: "src/agent.ts" },
                {
                  scope: "path",
                  fileId: "00000000-0000-4000-8000-000000000004",
                  path: "agenda.md",
                  folder: "/elsewhere/notes",
                },
              ],
              truncated: false,
              observedAt: "2026-11-16T12:00:00.000Z",
            },
          },
        };
      },
    };
    expect(await searchAgentCheckoutPaths(session, threadId, checkoutId, "ag")).toEqual([
      "src/agent.ts",
    ]);
    expect(requests).toEqual([
      `GET /api/code/files/search?threadId=${threadId}&checkoutId=${checkoutId}&scope=path&query=ag`,
    ]);
  });

  it("offers nothing when the host refuses the search", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "window",
      close: async () => undefined,
      send: async () => ({ status: 403, body: { category: "unauthorized", message: "No." } }),
    };
    expect(await searchAgentCheckoutPaths(session, threadId, checkoutId, "ag")).toEqual([]);
  });
});
