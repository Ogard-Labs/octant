import { describe, expect, it, vi } from "vitest";
import {
  decodeCreateRootlessThreadCommand,
  decodeStartRootlessThreadTurnCommand,
} from "@octant/contracts";
import {
  createRootlessThreadClient,
  RootlessThreadClientFailure,
  type RootlessFirstTurnPort,
} from "./rootlessThreadClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const command = decodeCreateRootlessThreadCommand({
  kind: "create-rootless-thread" as const,
  threadId: "00000000-0000-4000-8000-000000000710",
  title: "Unfiled brief",
  context: {
    hostId: "local" as const,
    mode: "work" as const,
    providerInstanceId: "00000000-0000-4000-8000-000000000703",
    modelId: "model-a",
    workspace: { kind: "rootless" as const },
  },
});

describe("rootless thread client", () => {
  it("exposes typed atomic start, lookup, and cancel methods", async () => {
    const startCommand = decodeStartRootlessThreadTurnCommand({
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000720",
      threadId: command.threadId,
      turnId: "00000000-0000-4000-8000-000000000721",
      title: command.title,
      prompt: "Draft a launch brief",
      context: command.context,
    });
    const accepted = {
      kind: "accepted",
      turn: {
        requestId: startCommand.requestId,
        threadId: startCommand.threadId,
        turnId: startCommand.turnId,
        status: "running",
        prompt: startCommand.prompt,
        capabilities: {
          workspace: "rootless",
          rootBackedTools: {
            availability: "unavailable",
            reason:
              "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.",
          },
        },
        acceptedAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      return Response.json(
        path.endsWith("/cancel")
          ? {
              kind: "turn-cancelled",
              requestId: startCommand.requestId,
              threadId: startCommand.threadId,
              turnId: startCommand.turnId,
              status: "cancelled",
            }
          : accepted,
        { status: path === "/api/rootless/turns" ? 202 : 200 },
      );
    });
    const client = createRootlessThreadClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    const webPort: RootlessFirstTurnPort = client;

    await expect(webPort.startFirstTurn(startCommand)).resolves.toMatchObject({ kind: "accepted" });
    await expect(webPort.lookupFirstTurn(startCommand.requestId)).resolves.toMatchObject({
      kind: "accepted",
    });
    await expect(
      webPort.cancelFirstTurn({
        kind: "cancel-rootless-turn",
        requestId: startCommand.requestId,
        threadId: startCommand.threadId,
        turnId: startCommand.turnId,
      }),
    ).resolves.toMatchObject({ kind: "turn-cancelled", status: "cancelled" });
  });

  it("posts the authoritative rootless creation command", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        kind: "thread-created",
        threadId: command.threadId,
        mode: command.context.mode,
        title: command.title,
        workspace: command.context.workspace,
        createdAt: "2026-07-25T10:00:00.000Z",
      }),
    );
    const client = createRootlessThreadClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(client.createThread(command)).resolves.toMatchObject({
      kind: "thread-created",
      threadId: command.threadId,
      mode: "work",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/rootless/threads",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(command),
      }),
    );
  });

  it("preserves an actionable request-reuse conflict from atomic start", async () => {
    const client = createRootlessThreadClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: async () =>
        Response.json(
          {
            category: "conflict",
            reason: "request-reused",
            message: "Rootless turn request identity was already used.",
          },
          { status: 409 },
        ),
      windowCapability: capability,
    });
    const startCommand = decodeStartRootlessThreadTurnCommand({
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000720",
      threadId: command.threadId,
      turnId: "00000000-0000-4000-8000-000000000721",
      title: command.title,
      prompt: "Draft a launch brief",
      context: command.context,
    });

    const failure = await client.startFirstTurn(startCommand).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RootlessThreadClientFailure);
    expect(failure).toMatchObject({ category: "conflict", conflictReason: "request-reused" });
  });
});
