import { describe, expect, it, vi } from "vitest";
import {
  decodeChatBootstrap,
  decodeChatThread,
  decodeCodeBootstrap,
  decodeCodeBoardView,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
} from "@octant/contracts";
import { listMobileInbox, type MobileRemoteTransport } from "./mobileInboxClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-05T10:00:00.000Z";

const chatThread = decodeChatThread({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Shared chat",
  lifecycle: "active",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be calm.",
  version: 1,
  createdAt: now,
  updatedAt: now,
});

const workThread = decodeWorkThread({
  id: "00000000-0000-4000-8000-000000000101",
  projectId: "20000000-0000-4000-8000-000000000001",
  title: "Shared work",
  lifecycle: "active",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  version: 1,
  createdAt: now,
  updatedAt: now,
});

const chatBootstrap = decodeChatBootstrap({
  settings: {
    defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
    defaultModelId: "model-a",
    defaultResearchEnabled: false,
    defaultResearchRouting: "automatic",
    defaultPersonalityInstructions: "Be calm.",
    version: 1,
    updatedAt: now,
  },
  threads: [chatThread],
});

const workBootstrap = decodeWorkThreadBootstrap({ threads: [workThread] });

const codeBootstrap = decodeCodeBootstrap({
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

const codeBoard = decodeCodeBoardView({
  version: 1,
  query: { version: 1 },
  cards: [],
  generatedAt: now,
});

/**
 * Concurrent desktop + phone: two authenticated transports against one host
 * both see the same inbox. Revoking one device identity does not clear the
 * other transport's view of host thread inventory.
 */
describe("mobile concurrent session fan-out", () => {
  it("lets two clients list the same host inbox independently", async () => {
    let phoneRevoked = false;
    const sharedFetch = vi.fn(
      async ({ path, headers }: { path: string; headers?: HeadersInit }) => {
        const device = new Headers(headers).get("x-octant-device-id") ?? "unknown";
        if (phoneRevoked && device === "phone") {
          return new Response(JSON.stringify({ category: "unauthorized" }), { status: 403 });
        }
        if (path === "/api/chat/bootstrap") return Response.json(chatBootstrap);
        if (path === "/api/work/threads/bootstrap") return Response.json(workBootstrap);
        if (path === "/api/code/bootstrap") return Response.json(codeBootstrap);
        if (path === "/api/code/board") return Response.json(codeBoard);
        return new Response("missing", { status: 404 });
      },
    );

    const desktop: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async (input) =>
        sharedFetch({
          ...input,
          headers: { "x-octant-device-id": "desktop" },
        }),
    };
    const phone: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async (input) =>
        sharedFetch({
          ...input,
          headers: { "x-octant-device-id": "phone" },
        }),
    };

    const [desktopInbox, phoneInbox] = await Promise.all([
      listMobileInbox(desktop),
      listMobileInbox(phone),
    ]);
    expect(desktopInbox.map((row) => row.threadId)).toEqual(phoneInbox.map((row) => row.threadId));
    expect(desktopInbox.some((row) => row.title === "Shared chat")).toBe(true);

    phoneRevoked = true;
    await expect(listMobileInbox(phone)).rejects.toMatchObject({ category: "rejected" });
    await expect(listMobileInbox(desktop)).resolves.toHaveLength(desktopInbox.length);
  });
});
