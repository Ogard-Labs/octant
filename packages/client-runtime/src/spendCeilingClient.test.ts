import { decodeAggregateVersion } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSpendCeilingClient, SpendCeilingClientFailure } from "./spendCeilingClient";

const raise = {
  kind: "raise-spend-ceiling" as const,
  scope: {
    kind: "thread" as const,
    threadType: "chat-thread" as const,
    threadId: "73000000-0000-4000-8000-000000000001",
  },
  expectedVersion: decodeAggregateVersion(1),
  costBudgetUsdCents: 10_00,
};

function client(response: Response) {
  return createSpendCeilingClient({
    baseUrl: "http://127.0.0.1:13773/",
    fetch: vi.fn(async () => response),
    windowCapability: "capability",
  });
}

describe("SpendCeilingClient", () => {
  it("returns the host's refusal so the person reads why, not a generic failure", async () => {
    const refused = {
      kind: "refused",
      refusal: {
        kind: "not-a-raise",
        message: "Raising a money ceiling requires a budget strictly above the current one.",
      },
    };
    const result = await client(
      new Response(JSON.stringify(refused), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    ).execute(raise);
    expect(result).toEqual(refused);
  });

  it("still fails with the host's error for a conflict that is not a refusal", async () => {
    const failing = client(
      new Response(JSON.stringify({ error: "Spend ceiling changed; reload and retry." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(failing.execute(raise)).rejects.toEqual(
      new SpendCeilingClientFailure("Spend ceiling changed; reload and retry.", 409),
    );
  });
});
