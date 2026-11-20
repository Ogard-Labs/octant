import {
  decodeHostAnswer,
  SERVICE_OFFERS_DECIDE_PATH,
  SERVICE_OFFERS_PATH,
  ServiceOfferDecisionResult,
  ServiceOffersResponse,
  type ServiceOffer,
  type ServiceOfferDecision,
} from "@octant/contracts";

export interface ServiceOfferClient {
  offers(scope: Pick<ServiceOffer, "threadKind" | "scopeId">): Promise<ServiceOffersResponse>;
  decide(decision: ServiceOfferDecision): Promise<ServiceOfferDecisionResult>;
}

export function createServiceOfferClient(options: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}): ServiceOfferClient {
  const baseUrl = new URL(options.baseUrl);
  if (
    baseUrl.protocol !== "http:" ||
    (baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "localhost")
  ) {
    throw new Error("Service offers require a loopback server URL.");
  }
  const headers = { "x-octant-window-capability": options.windowCapability };
  const decodeOffers = decodeHostAnswer(ServiceOffersResponse);
  const decodeResult = decodeHostAnswer(ServiceOfferDecisionResult);
  return {
    async offers({ threadKind, scopeId }) {
      const url = new URL(SERVICE_OFFERS_PATH, baseUrl);
      url.searchParams.set("threadKind", threadKind);
      url.searchParams.set("scopeId", String(scopeId));
      return decodeOffers(await request(url, { method: "GET", headers }));
    },
    async decide(decision) {
      const url = new URL(SERVICE_OFFERS_DECIDE_PATH, baseUrl);
      return decodeResult(
        await request(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(decision),
        }),
      );
    },
  };

  async function request(url: URL, init: RequestInit): Promise<unknown> {
    const response = await options.fetch(url.toString(), init);
    if (!response.ok) throw new Error(`Offer request failed (${String(response.status)}).`);
    return response.json();
  }
}
