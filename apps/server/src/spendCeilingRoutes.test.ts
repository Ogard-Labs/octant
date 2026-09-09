import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflict, JournalWriteFailed } from "./persistence/journalErrors";
import { createSpendCeilingRouteHandler } from "./spendCeilingRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("73000000-0000-4000-8000-000000000001");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const command = {
  kind: "set-spend-ceiling" as const,
  scope: {
    kind: "thread" as const,
    threadType: "chat-thread" as const,
    threadId: "73000000-0000-4000-8000-000000000002",
  },
  expectedVersion: 0,
  policy: { tokenBudget: 1_000 },
  window: { kind: "lifetime" as const },
};

function handlerWith(
  execute: ReturnType<typeof vi.fn>,
): ReturnType<typeof createSpendCeilingRouteHandler> {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: 0 });
  return createSpendCeilingRouteHandler({
    service: {
      execute,
      snapshot: vi.fn(),
    } as never,
    windowAuthorityStore,
    now: () => 0,
  });
}

function commandRequest(): Request {
  return new Request("http://127.0.0.1:3100/api/spend-ceilings/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    },
    body: JSON.stringify(command),
  });
}

describe("spend ceiling routes", () => {
  it("rejects an invalid command as 400 without executing", async () => {
    const execute = vi.fn();
    const response = await handlerWith(execute)(
      new Request("http://127.0.0.1:3100/api/spend-ceilings/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ kind: "not-a-command" }),
      }),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "Spend ceiling command is invalid." });
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps a concurrency conflict to 409", async () => {
    const execute = vi.fn(() => {
      throw new ConcurrencyConflict({
        aggregateType: "spend-ceiling",
        aggregateId: command.scope.threadId,
        expectedVersion: 0,
        actualVersion: 1,
      });
    });
    const response = await handlerWith(execute)(commandRequest());
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "Spend ceiling changed; reload and retry.",
    });
  });

  it("maps a persistence failure to 503", async () => {
    const execute = vi.fn(() => {
      throw new JournalWriteFailed({ operation: "append" });
    });
    const response = await handlerWith(execute)(commandRequest());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: "Spend ceiling command could not be applied.",
    });
  });
});
