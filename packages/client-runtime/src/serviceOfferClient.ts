import {
  decodeHostAnswer,
  SERVICE_OFFERS_DECIDE_PATH,
  SERVICE_OFFERS_PATH,
  ServiceOfferDecisionResult,
  ServiceOfferEnvelopes,
  type ServiceOffer,
  type ServiceOfferDecision,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

export interface ServiceOfferClient {
  /** Envelopes only: a card decodes its kind's strict payload before it shows or answers one. */
  offers(scope: Pick<ServiceOffer, "threadKind" | "scopeId">): Promise<ServiceOfferEnvelopes>;
  decide(decision: ServiceOfferDecision): Promise<ServiceOfferDecisionResult>;
}

type OfferRequest = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: string;
  readonly body?: string;
  readonly contentType?: string;
};

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
  return serviceOfferClient(({ method, path, query, body }) =>
    options.fetch(new URL(`${path}${query ?? ""}`, baseUrl).toString(), {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    }),
  );
}

export function createMobileServiceOfferClient(
  transport: MobileRemoteTransport,
): ServiceOfferClient {
  return serviceOfferClient((request) => transport.authenticatedFetch(request));
}

function serviceOfferClient(
  send: (request: OfferRequest) => Promise<Response>,
): ServiceOfferClient {
  const decodeOffers = decodeHostAnswer(ServiceOfferEnvelopes);
  const decodeResult = decodeHostAnswer(ServiceOfferDecisionResult);
  return {
    async offers({ threadKind, scopeId }) {
      return decodeOffers(
        await request({
          method: "GET",
          path: SERVICE_OFFERS_PATH,
          query: `?${new URLSearchParams({ threadKind, scopeId: String(scopeId), referenceImages: "1", transcription: "1", narration: "1", iconSets: "1", video: "1" }).toString()}`,
        }),
      );
    },
    async decide(decision) {
      return decodeResult(
        await request({
          method: "POST",
          path: SERVICE_OFFERS_DECIDE_PATH,
          contentType: "application/json",
          body: JSON.stringify(decision),
        }),
      );
    },
  };

  async function request(input: Parameters<typeof send>[0]): Promise<unknown> {
    const response = await send(input);
    if (!response.ok) throw new Error(`Offer request failed (${String(response.status)}).`);
    return response.json();
  }
}
