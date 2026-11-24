import { describe, expect, it, vi } from "vitest";
import {
  decodeChatBootstrap,
  decodeChatThread,
  decodeCodeBootstrap,
  decodeCodeBoardView,
  decodeWorkThreadBootstrap,
} from "@octant/contracts";
import { listAllHostsMobileInbox, type MobileRemoteTransport } from "./mobileInboxClient";

const now = "2026-08-05T10:00:00.000Z";
const later = "2026-08-05T12:00:00.000Z";

const chatSettings = {
  defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
  defaultModelId: "model-a",
  defaultResearchEnabled: false,
  defaultResearchRouting: "automatic",
  defaultPersonalityInstructions: "Be calm.",
  version: 1,
  updatedAt: now,
} as const;

const emptyCode = decodeCodeBootstrap({
  settings: {
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "current-session",
    version: 1,
    updatedAt: now,
  },
  threads: [],
  checkouts: [],
  activity: [],
});

const emptyCodeBoard = decodeCodeBoardView({
  version: 1,
  query: { version: 1 },
  cards: [],
  generatedAt: now,
});

function transportFor(input: {
  readonly hostId: string;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly fail?: boolean;
  readonly parseFail?: boolean;
  readonly boardFail?: boolean;
}): MobileRemoteTransport {
  const thread = decodeChatThread({
    id: input.threadId,
    title: input.title,
    lifecycle: "active",
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1,
    createdAt: now,
    updatedAt: input.updatedAt,
  });
  return {
    hostId: input.hostId,
    authenticatedFetch: vi.fn(async ({ path }: { path: string }) => {
      if (input.fail) {
        return new Response(JSON.stringify({ category: "unauthorized" }), { status: 403 });
      }
      if (path === "/api/chat/bootstrap") {
        return Response.json(decodeChatBootstrap({ settings: chatSettings, threads: [thread] }));
      }
      if (path === "/api/work/threads/bootstrap") {
        return Response.json(decodeWorkThreadBootstrap({ threads: [] }));
      }
      if (path === "/api/code/bootstrap") {
        if (input.parseFail) return Response.json({ threads: "not-an-array" });
        return Response.json(emptyCode);
      }
      if (path === "/api/code/board") {
        if (input.boardFail) return new Response("board unavailable", { status: 503 });
        return Response.json(emptyCodeBoard);
      }
      return new Response("missing", { status: 404 });
    }) as MobileRemoteTransport["authenticatedFetch"],
  };
}

describe("listAllHostsMobileInbox", () => {
  it("marks only the waiting offer's own host and thread as needing input", async () => {
    const threadId = "00000000-0000-4000-8000-000000000001";
    const owner = transportFor({
      hostId: "studio",
      threadId,
      title: "Studio chat",
      updatedAt: now,
    });
    const other = transportFor({
      hostId: "laptop",
      threadId,
      title: "Laptop chat",
      updatedAt: now,
    });
    const result = await listAllHostsMobileInbox([
      {
        ...owner,
        authenticatedFetch: (request) =>
          request.path === "/api/pending-requests"
            ? Promise.resolve(
                Response.json({
                  requests: [],
                  truncated: false,
                  asks: [
                    {
                      kind: "service-offer",
                      mode: "chat",
                      askId: "00000000-0000-4000-8000-000000000009",
                      threadId,
                      threadTitle: "Studio chat",
                      text: "Generate an image?",
                      requestedAt: now,
                    },
                  ],
                }),
              )
            : owner.authenticatedFetch(request),
      },
      other,
    ]);
    expect(result.failures).toEqual([]);
    expect(result.rows.find((row) => row.hostId === "studio")).toMatchObject({
      live: "needs-input",
      waitingAsk: { label: "Offer", text: "Generate an image?" },
    });
    expect(result.rows.find((row) => row.hostId === "laptop")).not.toHaveProperty("waitingAsk");
  });

  it("lists every kind of waiting ask the host names, each on the thread it opens", async () => {
    const chatThreadId = "00000000-0000-4000-8000-000000000001";
    const workThreadId = "00000000-0000-4000-8000-000000000002";
    const codeThreadId = "00000000-0000-4000-8000-000000000003";
    const browserThreadId = "00000000-0000-4000-8000-000000000004";
    const routineThreadId = "00000000-0000-4000-8000-000000000005";
    const leadThreadId = "00000000-0000-4000-8000-000000000006";
    const futureThreadId = "00000000-0000-4000-8000-000000000007";
    const projectId = "00000000-0000-4000-8000-0000000000aa";
    const host = transportFor({
      hostId: "studio",
      threadId: chatThreadId,
      title: "Studio chat",
      updatedAt: now,
    });
    const ask = (kind: string, mode: string, threadId: string, text: string, n: number) => ({
      kind,
      mode,
      askId: `00000000-0000-4000-8000-00000000010${n}`,
      ...(mode === "chat" ? {} : { projectId }),
      threadId,
      threadTitle: `Thread ${n}`,
      text,
      requestedAt: now,
    });
    const result = await listAllHostsMobileInbox([
      {
        ...host,
        authenticatedFetch: (request) =>
          request.path === "/api/pending-requests"
            ? Promise.resolve(
                Response.json({
                  requests: [
                    {
                      mode: "code",
                      kind: "approval",
                      projectId,
                      threadId: browserThreadId,
                      threadTitle: "Browse docs",
                      requestedAt: now,
                      text: "Open the docs site",
                      browserOrigin: "https://docs.example.com",
                      answer: {
                        threadId: browserThreadId,
                        checkoutId: "00000000-0000-4000-8000-0000000000bb",
                        approvalId: "00000000-0000-4000-8000-0000000000cc",
                      },
                    },
                    {
                      mode: "work",
                      kind: "lead-approval",
                      projectId,
                      threadId: leadThreadId,
                      threadTitle: "Lead run",
                      requestedAt: now,
                      text: "Run the build",
                    },
                    {
                      mode: "work",
                      kind: "a-kind-from-a-newer-host",
                      threadId: futureThreadId,
                      threadTitle: "Newer ask",
                      requestedAt: now,
                    },
                    { mode: "code", kind: "a-kind-with-no-thread" },
                  ],
                  truncated: false,
                  asks: [
                    ask("memory-proposal", "chat", chatThreadId, "Remember the deploy window", 1),
                    ask("tool-approval", "work", workThreadId, "Search the tracker", 2),
                    ask("image-offer", "code", codeThreadId, "Generate a diagram?", 3),
                    ask("routine-proposal", "work", routineThreadId, "Run nightly checks", 4),
                    ask("browser-approval", "code", browserThreadId, "Upload a file", 5),
                  ],
                }),
              )
            : host.authenticatedFetch(request),
      },
    ]);

    expect(result.failures).toEqual([]);
    const opened = (mode: string, threadId: string) =>
      result.rows.find((row) => row.mode === mode && row.threadId === threadId);
    expect(opened("chat", chatThreadId)).toMatchObject({
      hostId: "studio",
      title: "Studio chat",
      live: "needs-input",
      waitingAsk: { label: "Memory proposal", text: "Remember the deploy window" },
    });
    expect(opened("work", workThreadId)).toMatchObject({
      hostId: "studio",
      title: "Thread 2",
      projectId,
      live: "needs-input",
      waitingAsk: { label: "Tool approval", text: "Search the tracker" },
    });
    expect(opened("code", codeThreadId)).toMatchObject({
      hostId: "studio",
      live: "needs-input",
      waitingAsk: { label: "Image offer", text: "Generate a diagram?" },
    });
    expect(opened("work", routineThreadId)).toMatchObject({
      live: "needs-input",
      waitingAsk: { label: "Routine proposal", text: "Run nightly checks" },
    });
    expect(opened("code", browserThreadId)).toMatchObject({
      title: "Browse docs",
      live: "needs-input",
      waitingAsk: { label: "Browser approval", text: "Open the docs site" },
    });
    expect(opened("work", leadThreadId)).toMatchObject({
      waitingAsk: { label: "Approval", text: "Run the build" },
    });
    expect(opened("work", futureThreadId)).toMatchObject({
      title: "Newer ask",
      live: "needs-input",
      waitingAsk: { label: "Waiting on you" },
    });
    expect(result.rows).toHaveLength(7);
  });

  it("merges rows from healthy hosts and sorts by freshness", async () => {
    const studio = transportFor({
      hostId: "11111111-1111-4111-8111-111111111111",
      threadId: "00000000-0000-4000-8000-000000000001",
      title: "Studio chat",
      updatedAt: now,
    });
    const laptop = transportFor({
      hostId: "22222222-2222-4222-8222-222222222222",
      threadId: "00000000-0000-4000-8000-000000000002",
      title: "Laptop chat",
      updatedAt: later,
    });

    const result = await listAllHostsMobileInbox([studio, laptop]);
    expect(result.failures).toEqual([]);
    expect(result.rows.map((row) => row.title)).toEqual(["Laptop chat", "Studio chat"]);
    expect(result.rows.map((row) => row.hostId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("keeps healthy host rows when another host is rejected", async () => {
    const healthy = transportFor({
      hostId: "11111111-1111-4111-8111-111111111111",
      threadId: "00000000-0000-4000-8000-000000000001",
      title: "Healthy",
      updatedAt: later,
    });
    const broken = transportFor({
      hostId: "33333333-3333-4333-8333-333333333333",
      threadId: "00000000-0000-4000-8000-000000000003",
      title: "Broken",
      updatedAt: now,
      fail: true,
    });

    const result = await listAllHostsMobileInbox([healthy, broken]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe("Healthy");
    expect(result.failures).toEqual([
      expect.objectContaining({
        hostId: "33333333-3333-4333-8333-333333333333",
        category: "rejected",
      }),
    ]);
  });

  it("keeps Chat and Work rows when only the Code board projection fails", async () => {
    const partial = transportFor({
      hostId: "44444444-4444-4444-8444-444444444444",
      threadId: "00000000-0000-4000-8000-000000000004",
      title: "Partial host",
      updatedAt: later,
      boardFail: true,
    });

    const result = await listAllHostsMobileInbox([partial]);

    expect(result.rows.map((row) => row.title)).toEqual(["Partial host"]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        hostId: "44444444-4444-4444-8444-444444444444",
        category: "unavailable",
        message: "Code Board state could not be loaded from the host.",
      }),
    ]);
  });

  it("keeps another host's threads when one host sends an incompatible bootstrap", async () => {
    const healthy = transportFor({
      hostId: "55555555-5555-4555-8555-555555555555",
      threadId: "00000000-0000-0000-8000-000000000005",
      title: "Healthy host",
      updatedAt: later,
    });
    const incompatible = transportFor({
      hostId: "66666666-6666-4666-8666-666666666666",
      threadId: "00000000-0000-0000-8000-000000000006",
      title: "Incompatible host",
      updatedAt: now,
      parseFail: true,
    });

    const result = await listAllHostsMobileInbox([healthy, incompatible]);

    expect(result.rows.map((row) => row.title)).toContain("Healthy host");
    expect(result.failures).toEqual([
      expect.objectContaining({
        hostId: "66666666-6666-4666-8666-666666666666",
        category: "incompatible",
      }),
    ]);
  });

  it("returns empty when no transports are connected", async () => {
    await expect(listAllHostsMobileInbox([])).resolves.toEqual({ rows: [], failures: [] });
  });
});
