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
      if (path === "/api/code/bootstrap") return Response.json(emptyCode);
      if (path === "/api/code/board") {
        if (input.boardFail) return new Response("board unavailable", { status: 503 });
        return Response.json(emptyCodeBoard);
      }
      return new Response("missing", { status: 404 });
    }) as MobileRemoteTransport["authenticatedFetch"],
  };
}

describe("listAllHostsMobileInbox", () => {
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

  it("returns empty when no transports are connected", async () => {
    await expect(listAllHostsMobileInbox([])).resolves.toEqual({ rows: [], failures: [] });
  });
});
