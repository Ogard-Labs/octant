import { decodeWindowId } from "@octant/contracts";
import { expect, it, vi } from "vitest";
import { resolveServiceOfferDecision, type ServiceOfferRules } from "./serviceOfferDecision";
import { ServiceOfferService } from "./serviceOfferService";

it("dispatches a second kind without letting it answer another kind or outlive its turn", async () => {
  const windowId = decodeWindowId("70000000-0000-4000-8000-000000000001");
  const scope = { threadKind: "chat-thread", scopeId: "thread" };
  type View = typeof scope & { readonly offerId: string; readonly kind: "first" | "sample" };
  type Decision = { readonly offerId: string; readonly decision: "keep" | "sample" };
  type Outcome = { readonly status: "kept" | "sampled" };
  let id = 0;
  const offers = new ServiceOfferService<View, Outcome>(2, {
    uuid: () => String(++id),
    now: () => 0,
  });
  const controller = new AbortController();
  const first = offers.wait({
    windowId,
    stamp: (offerId) => ({ ...scope, offerId, kind: "first" }),
    signal: controller.signal,
  });
  const sample = offers.wait({
    windowId,
    stamp: (offerId) => ({ ...scope, offerId, kind: "sample" }),
  });
  const rules: ServiceOfferRules<View, Decision, Outcome> = {
    first: (_offer, { decision }) =>
      decision === "keep" ? { outcome: { status: "kept" } } : { reason: "Wrong kind" },
    sample: (_offer, { decision }) =>
      decision === "sample" ? { outcome: { status: "sampled" } } : { reason: "Wrong kind" },
  };
  const authorize = vi.fn(async () => true);
  const decide = (offerId: string) =>
    resolveServiceOfferDecision({
      offers,
      windowId,
      decision: { offerId, decision: "sample" },
      rules,
      authorize,
    });
  expect(await decide("1")).toEqual({ kind: "offer-refused", reason: "Wrong kind" });
  expect(await decide("2")).toEqual({ kind: "offer-answered" });
  await expect(sample).resolves.toEqual({ status: "sampled" });
  expect(await decide("2")).toEqual({ kind: "offer-gone" });
  expect(offers.list(windowId, scope)).toMatchObject([{ kind: "first" }]);
  controller.abort();
  await expect(first).resolves.toEqual({ status: "cancelled" });
  expect(offers.list(windowId, scope)).toEqual([]);
});
