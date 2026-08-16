import { describe, expect, it, vi } from "vitest";
import {
  createMobileWorkFromPrompt,
  createMobileWorkThread,
  fetchMobileWorkProjects,
  listMobileWorkProjects,
} from "./mobileWorkClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const projectId = "20000000-0000-4000-8000-000000000001";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";
const now = "2026-08-05T20:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000201";

const workSummary = {
  id: projectId,
  name: "Atlas Work",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt: now,
  updatedAt: now,
  type: "work",
  binding: { canonicalRoot: "/tmp/atlas" },
  bindingRevisionId: "30000000-0000-4000-8000-000000000001",
} as const;

const chatSummary = {
  id: "20000000-0000-4000-8000-000000000002",
  name: "Chat only",
  lifecycle: "active",
  pinned: false,
  rank: "1/1",
  version: 1,
  createdAt: now,
  updatedAt: now,
  type: "chat",
} as const;

describe("mobile work create", () => {
  it("lists only active work projects", () => {
    expect(
      listMobileWorkProjects([
        workSummary,
        chatSummary,
        { ...workSummary, id: "20000000-0000-4000-8000-000000000003", lifecycle: "archived" },
      ] as never),
    ).toEqual([
      {
        projectId,
        name: "Atlas Work",
        bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      },
    ]);
  });

  it("fetches projects and creates a work thread on the host", async () => {
    const thread = {
      id: threadId,
      projectId,
      title: "Ship work",
      lifecycle: "active",
      providerInstanceId,
      modelId: "model-a",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const fetch = vi.fn(
      async ({ method, path, body }: { method: string; path: string; body?: string }) => {
        if (method === "GET" && path === "/api/projects/bootstrap") {
          return Response.json({
            active: [workSummary, chatSummary],
            archived: [],
            availability: [],
            memory: [],
          });
        }
        if (method === "POST" && path === "/api/work/threads/commands") {
          const payload = JSON.parse(body ?? "{}") as {
            kind?: string;
            hostId?: string;
            title?: string;
          };
          expect(payload.kind).toBe("create-work-thread");
          expect(payload.hostId).toBe("local");
          expect(payload.title).toBe("Ship work");
          return Response.json({ kind: "thread-created", thread });
        }
        return new Response("missing", { status: 404 });
      },
    );
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    expect(await fetchMobileWorkProjects(transport)).toEqual([
      {
        projectId,
        name: "Atlas Work",
        bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      },
    ]);
    const row = await createMobileWorkFromPrompt({
      transport,
      prompt: "Ship work",
      projectId,
      providerInstanceId,
      modelId: "model-a",
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    });
    expect(row).toMatchObject({
      hostId,
      mode: "work",
      threadId,
      title: "Ship work",
    });

    await expect(
      createMobileWorkThread({
        transport,
        projectId,
        title: "   ",
        providerInstanceId,
        modelId: "model-a",
        bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
  });
});
