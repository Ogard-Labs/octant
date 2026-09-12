import { describe, expect, it, vi } from "vitest";
import {
  createMobileWorkFromPrompt,
  createMobileWorkThread,
  fetchMobileWorkProjects,
  listMobileWorkProjects,
  loadMobileWorkThread,
  loadMobileWorkTranscript,
  sendMobileWorkTurn,
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

  it("fetches projects, creates a work thread on the host, and sends the prompt as its first turn", async () => {
    const startedTurns: Array<{ prompt?: string; threadId?: string; authority?: unknown }> = [];
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
        if (method === "POST" && path === "/api/work/turns") {
          const payload = JSON.parse(body ?? "{}") as {
            kind?: string;
            prompt?: string;
            threadId?: string;
            authority?: { bindingRevisionId?: string; modelId?: string };
          };
          startedTurns.push(payload);
          return Response.json({ kind: "accepted", turn: acceptedTurn(payload) });
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
    expect(startedTurns).toEqual([
      expect.objectContaining({
        kind: "start-work-thread-turn",
        threadId,
        prompt: "Ship work",
        authority: expect.objectContaining({
          bindingRevisionId: "30000000-0000-4000-8000-000000000001",
          modelId: "model-a",
          confinementPosture: "project-root-confined",
        }),
      }),
    ]);

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

function acceptedTurn(payload: {
  prompt?: string;
  threadId?: string;
  authority?: unknown;
}): Record<string, unknown> {
  return {
    requestId: "40000000-0000-4000-8000-000000000001",
    threadId: payload.threadId,
    turnId: "40000000-0000-4000-8000-000000000002",
    projectId,
    authority: payload.authority,
    status: "accepted",
    prompt: payload.prompt,
    transcript: [{ role: "user", text: payload.prompt }],
    capabilities: {
      workspace: "project-backed",
      confinement: "project-root-confined",
      shell: "denied",
      git: "denied",
      worktree: "denied",
      pullRequest: "denied",
      code: "denied",
    },
    version: 1,
    acceptedAt: now,
    updatedAt: now,
  };
}

describe("mobile work follow-through", () => {
  const thread = {
    id: threadId,
    projectId,
    title: "Ship work",
    lifecycle: "active",
    providerInstanceId,
    modelId: "model-a",
    bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    version: 3,
    createdAt: now,
    updatedAt: now,
    authority: {
      hostId: "local",
      projectId,
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId,
      modelId: "model-a",
    },
  };

  function transport(
    turns: Array<Record<string, unknown>>,
    started: Array<Record<string, unknown>>,
  ): MobileRemoteTransport {
    const fetch = async ({
      method,
      path,
      body,
    }: {
      method: string;
      path: string;
      body?: string;
    }) => {
      if (method === "GET" && path === "/api/work/threads/bootstrap") {
        const { authority: _authority, ...listed } = thread;
        return Response.json({ threads: [listed] });
      }
      if (method === "GET" && path === `/api/work/turns/transcript/${threadId}`) {
        return Response.json({ threadId, turns, liveCursor: turns.length });
      }
      if (method === "POST" && path === "/api/work/turns") {
        const payload = JSON.parse(body ?? "{}") as Record<string, unknown>;
        started.push(payload);
        return Response.json({ kind: "accepted", turn: acceptedTurn(payload) });
      }
      return new Response("missing", { status: 404 });
    };
    return { hostId, authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"] };
  }

  it("reads an existing Work thread and its transcript from the host", async () => {
    const port = transport(
      [acceptedTurn({ prompt: "Earlier ask", threadId, authority: thread.authority })],
      [],
    );
    await expect(loadMobileWorkThread(port, threadId)).resolves.toMatchObject({
      id: threadId,
      title: "Ship work",
    });
    const transcript = await loadMobileWorkTranscript(port, threadId);
    expect(transcript.turns.map((turn) => turn.prompt)).toEqual(["Earlier ask"]);
    await expect(
      loadMobileWorkThread(port, "00000000-0000-4000-8000-000000000999"),
    ).rejects.toMatchObject({ category: "unavailable" });
  });

  it("refuses a Work transcript whose threadId does not match the request", async () => {
    const otherThreadId = "00000000-0000-4000-8000-000000000202";
    const fetch = async ({ method, path }: { method: string; path: string }) => {
      if (method === "GET" && path === `/api/work/turns/transcript/${threadId}`) {
        return Response.json({ threadId: otherThreadId, turns: [], liveCursor: 0 });
      }
      return new Response("missing", { status: 404 });
    };
    const port: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    await expect(loadMobileWorkTranscript(port, threadId)).rejects.toMatchObject({
      category: "unavailable",
      message: "Work transcript identity mismatch.",
    });
  });

  it("sends a follow-up under the thread's own authority and returns the accepted turn", async () => {
    const started: Array<Record<string, unknown>> = [];
    const port = transport([], started);
    const loaded = await loadMobileWorkThread(port, threadId);
    const turn = await sendMobileWorkTurn({
      transport: port,
      thread: loaded,
      prompt: "  Now ship it  ",
    });
    expect(turn.prompt).toBe("Now ship it");
    expect(started).toEqual([
      expect.objectContaining({
        kind: "start-work-thread-turn",
        threadId,
        prompt: "Now ship it",
        authority: {
          hostId: "local",
          projectId,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001",
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId,
          modelId: "model-a",
        },
      }),
    ]);
    await expect(
      sendMobileWorkTurn({ transport: port, thread: loaded, prompt: "   " }),
    ).rejects.toMatchObject({ category: "unavailable" });
  });
});
