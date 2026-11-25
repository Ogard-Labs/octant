import { expect, it } from "vitest";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import { createServiceOfferClient } from "./serviceOfferClient";

const scopeId = decodeImageGenerationScopeId("c6000000-0000-4000-8000-000000000001");
const envelope = {
  offerId: "c6000000-0000-4000-8000-000000000002",
  threadKind: "work-thread",
  scopeId,
  requestedAt: "2026-11-25T10:00:00.000Z",
};

function clientAnswering(offers: ReadonlyArray<unknown>) {
  return createServiceOfferClient({
    baseUrl: "http://127.0.0.1:4100",
    windowCapability: "capability",
    fetch: Object.assign(async () => Response.json({ offers }), { preconnect: () => undefined }),
  });
}

it("lists an offer of a kind this build does not know, with the thread it waits in", async () => {
  const client = clientAnswering([
    { ...envelope, kind: "hologram", depth: 3 },
    { ...envelope, offerId: "c6000000-0000-4000-8000-000000000003", kind: "narrate" },
  ]);

  const { offers } = await client.offers({ threadKind: "work-thread", scopeId });

  expect(offers).toEqual([
    expect.objectContaining({ kind: "hologram", threadKind: "work-thread", scopeId }),
    expect.objectContaining({ kind: "narrate" }),
  ]);
});

it.each([
  ["no kind", { ...envelope }],
  ["no thread", { ...envelope, kind: "narrate", scopeId: "elsewhere" }],
  ["an unknown thread kind", { ...envelope, kind: "narrate", threadKind: "hologram-thread" }],
])("refuses a list whose offer has %s", async (_, offer) => {
  await expect(
    clientAnswering([offer]).offers({ threadKind: "work-thread", scopeId }),
  ).rejects.toThrow();
});
