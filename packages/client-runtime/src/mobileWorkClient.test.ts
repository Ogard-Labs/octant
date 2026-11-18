import { describe, expect, it, vi } from "vitest";
import { decodeWorkRequest } from "@octant/contracts";
import {
  answerMobileWorkQuestion,
  dismissMobileWorkQuestion,
  createMobileWorkFromPrompt,
  createMobileWorkThread,
  fetchMobileWorkProjects,
  listMobileWorkProjects,
  listMobileWorkRequests,
  loadMobileWorkThread,
  resolveMobileWorkApproval,
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

  it("names the thread it made even when that thread's first turn then fails to start", async () => {
    const fetch = vi.fn(async ({ method, path }: { method: string; path: string }) => {
      if (method === "POST" && path === "/api/work/threads/commands") {
        return Response.json({
          kind: "thread-created",
          thread: {
            id: threadId,
            projectId,
            title: "Ship work",
            lifecycle: "active",
            providerInstanceId,
            modelId: "model-a",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      return new Response("unavailable", { status: 503 });
    });
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const created: Array<{ readonly hostId: string; readonly threadId: string }> = [];

    await expect(
      createMobileWorkFromPrompt({
        transport,
        prompt: "Ship work",
        projectId,
        providerInstanceId,
        modelId: "model-a",
        bindingRevisionId: "30000000-0000-4000-8000-000000000001",
        onCreated: (row) => created.push({ hostId: row.hostId, threadId: row.threadId }),
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(created).toEqual([{ hostId, threadId }]);
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

  it("reads a Work transcript whose answer carries fields this build does not know", async () => {
    const port = transport(
      [
        {
          ...acceptedTurn({ prompt: "Earlier ask", threadId, authority: thread.authority }),
          futureActivity: [{ id: "step-1", name: "read", state: "succeeded" }],
        },
      ],
      [],
    );
    const transcript = await loadMobileWorkTranscript(port, threadId);
    expect(transcript.turns.map((turn) => turn.prompt)).toEqual(["Earlier ask"]);
    expect(transcript.turns[0]).not.toHaveProperty("futureActivity");
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

  it("sends the photos staged for the thread with its follow-up", async () => {
    const started: Array<Record<string, unknown>> = [];
    const port = transport([], started);
    const loaded = await loadMobileWorkThread(port, threadId);
    const photoId = "00000000-0000-4000-8000-000000000401";
    await sendMobileWorkTurn({
      transport: port,
      thread: loaded,
      prompt: "What is on this whiteboard?",
      attachmentIds: [photoId],
    });
    expect(started[0]).toMatchObject({ attachmentIds: [photoId] });
  });
});

describe("mobile Work level-change asks", () => {
  const pendingLevelChange = {
    requestId: "11111111-1111-4111-8111-111111111111",
    projectId,
    threadId,
    providerInstanceId,
    providerSessionId: "55555555-5555-4555-8555-555555555555",
    providerRequestId: "provider-req-1",
    detail: {
      kind: "approval",
      action: "exit-plan",
      description: "The plan is ready.",
      levelChange: { to: "ask-first", plan: "1. Read.\n2. Change." },
    },
    status: "pending",
    requestedAt: now,
    version: 3,
  } as const;

  it("lists only the thread's pending requests, scoped by its Project", async () => {
    const calls: Array<{ path: string; query?: string }> = [];
    const settled = {
      ...pendingLevelChange,
      requestId: "66666666-6666-4666-8666-666666666666",
      status: "resolved",
      resolution: { kind: "approval", approved: true },
      settledAt: now,
    };
    const port: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: (async (input: { path: string; query?: string }) => {
        calls.push(input);
        return new Response(JSON.stringify({ requests: [pendingLevelChange, settled] }));
      }) as MobileRemoteTransport["authenticatedFetch"],
    };
    const requests = await listMobileWorkRequests(port, { threadId, projectId });
    expect(requests.map((request) => String(request.requestId))).toEqual([
      pendingLevelChange.requestId,
    ]);
    expect(calls[0]?.path).toBe("/api/work/requests");
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.query))).toEqual({
      projectId,
      threadId,
    });
  });

  it("answers with yes or no against the version the phone read, and nothing else", async () => {
    const bodies: Array<unknown> = [];
    const port: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: (async (input: { body?: string }) => {
        bodies.push(JSON.parse(input.body ?? "{}"));
        return new Response(
          JSON.stringify({
            kind: "work-request-resolved",
            request: {
              ...pendingLevelChange,
              status: "resolved",
              resolution: { kind: "approval", approved: false },
              settledAt: now,
              version: 4,
            },
          }),
        );
      }) as MobileRemoteTransport["authenticatedFetch"],
    };
    const [listed] = await listMobileWorkRequests(
      {
        hostId,
        authenticatedFetch: (async () =>
          new Response(
            JSON.stringify({ requests: [pendingLevelChange] }),
          )) as MobileRemoteTransport["authenticatedFetch"],
      },
      { threadId, projectId },
    );
    if (listed === undefined) throw new Error("The pending ask was not listed.");
    const result = await resolveMobileWorkApproval({
      transport: port,
      request: listed,
      approved: false,
    });
    expect(result).toMatchObject({
      status: "answered",
      result: { kind: "work-request-resolved" },
    });
    expect(bodies).toEqual([
      {
        kind: "resolve-work-request",
        requestId: pendingLevelChange.requestId,
        expectedVersion: 3,
        resolution: { kind: "approval", approved: false },
      },
    ]);
  });
});

describe("mobile Work questions and refusals", () => {
  const question = decodeWorkRequest({
    requestId: "77777777-7777-4777-8777-777777777777",
    projectId,
    threadId,
    providerInstanceId,
    providerSessionId: "55555555-5555-4555-8555-555555555555",
    providerRequestId: "provider-req-2",
    detail: {
      kind: "user-input",
      prompt: "Which venue?",
      options: ["Hall A", "Hall B"],
    },
    status: "pending",
    requestedAt: now,
    version: 5,
  });

  function recordingHost(answer: (body: { kind: string }) => Response) {
    const bodies: Array<unknown> = [];
    const port: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: (async (input: { path: string; body?: string }) => {
        const body = JSON.parse(input.body ?? "{}") as { kind: string };
        bodies.push({ path: input.path, body });
        return answer(body);
      }) as MobileRemoteTransport["authenticatedFetch"],
    };
    return { port, bodies };
  }

  const settled = (resolution: unknown) =>
    new Response(
      JSON.stringify({
        kind: "work-request-resolved",
        request: { ...question, status: "resolved", resolution, settledAt: now, version: 6 },
      }),
    );

  it("answers a question with the chosen words and the version the phone read", async () => {
    const { port, bodies } = recordingHost(() => settled({ kind: "user-input", answer: "Hall B" }));
    const result = await answerMobileWorkQuestion({
      transport: port,
      request: question,
      answer: "Hall B",
    });
    expect(result.status).toBe("answered");
    expect(bodies).toEqual([
      {
        path: "/api/work/requests/commands",
        body: {
          kind: "resolve-work-request",
          requestId: question.requestId,
          expectedVersion: 5,
          resolution: { kind: "user-input", answer: "Hall B" },
        },
      },
    ]);
  });

  it("sends a questionnaire's whole response, and dismisses one by cancelling it", async () => {
    const response = {
      version: 1 as const,
      answers: [{ questionId: "venue", selectedOptionIds: ["hall-b"] }],
      comment: "Either works",
    };
    const { port, bodies } = recordingHost((body) =>
      body.kind === "cancel-work-request"
        ? new Response(
            JSON.stringify({
              kind: "work-request-cancelled",
              request: { ...question, status: "cancelled", settledAt: now, version: 6 },
            }),
          )
        : settled({ kind: "user-input", answer: response }),
    );
    await answerMobileWorkQuestion({ transport: port, request: question, answer: response });
    const dismissed = await dismissMobileWorkQuestion({ transport: port, request: question });
    expect(dismissed).toMatchObject({
      status: "answered",
      result: { kind: "work-request-cancelled" },
    });
    expect(bodies.map((entry) => (entry as { body: unknown }).body)).toEqual([
      {
        kind: "resolve-work-request",
        requestId: question.requestId,
        expectedVersion: 5,
        resolution: { kind: "user-input", answer: response },
      },
      { kind: "cancel-work-request", requestId: question.requestId, expectedVersion: 5 },
    ]);
  });

  it("returns the host's refusal in its own words instead of throwing", async () => {
    const { port } = recordingHost(
      () =>
        new Response(
          JSON.stringify({
            code: "stale",
            message: "This request was already answered at a window on the computer.",
          }),
          { status: 409 },
        ),
    );
    const result = await resolveMobileWorkApproval({
      transport: port,
      request: question,
      approved: true,
    });
    expect(result).toEqual({
      status: "refused",
      message: "This request was already answered at a window on the computer.",
    });
  });

  it("refuses an answer holding a path before sending it, since Work text carries none", async () => {
    const { port, bodies } = recordingHost(() => settled({ kind: "user-input", answer: "x" }));
    const result = await answerMobileWorkQuestion({
      transport: port,
      request: question,
      answer: "Use /etc/hosts",
    });
    expect(result).toEqual({
      status: "refused",
      message: "The answer contains text that Work cannot deliver.",
    });
    expect(bodies).toEqual([]);
  });
});
