import {
  decodeImageGenerationOfferDecision,
  decodeImageGenerationOfferDecisionResult,
  decodeImageGenerationOffersResponse,
  decodeImageGenerationScopeId,
  decodeServiceOfferDecision,
  decodeServiceOfferDecisionResult,
  decodeServiceOffersResponse,
  SERVICE_OFFERS_DECIDE_PATH,
  SERVICE_OFFERS_PATH,
  SERVICE_OFFER_DECISION_MAX_BYTES,
  type ImageGenerationProfileView,
  type ServiceOffer,
  type ServiceOfferDecision,
  type WindowId,
} from "@octant/contracts";
import { principalActsAsHostPerson, type ClientPrincipal } from "../clientPrincipal";
import { unavailableImageModel } from "../image/imageOfferDecisionRules";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal, retainRouteAdmissionCurrent } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import { resolveServiceOfferDecision, type ServiceOfferRules } from "./serviceOfferDecision";
import type { ServiceOfferService } from "./serviceOfferService";

export function createServiceOfferRouteHandler<Outcome>(input: {
  readonly offers: Pick<ServiceOfferService<ServiceOffer, Outcome>, "list" | "find" | "claim">;
  readonly rules: ServiceOfferRules<
    ServiceOffer,
    ServiceOfferDecision,
    Outcome | { readonly status: "cancelled" }
  >;
  readonly authorizeScope: (
    windowId: WindowId,
    threadKind: ServiceOffer["threadKind"],
    scopeId: ServiceOffer["scopeId"],
    principal: ClientPrincipal,
  ) => Promise<boolean>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now: () => number;
  readonly listImageProfiles: () => ReadonlyArray<ImageGenerationProfileView>;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const legacy =
      url.pathname === "/api/image/offers" || url.pathname === "/api/image/offers/decide";
    const list = url.pathname === SERVICE_OFFERS_PATH || url.pathname === "/api/image/offers";
    const decide =
      url.pathname === SERVICE_OFFERS_DECIDE_PATH || url.pathname === "/api/image/offers/decide";
    if (!list && !decide) return undefined;

    const origin = request.headers.get("origin");
    const headers = {
      "cache-control": "no-store",
      ...(origin === null ? {} : { "access-control-allow-origin": origin, vary: "Origin" }),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
    const fail = (error: string, status: number) => reply({ error }, status);
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isLoopbackOrigin(origin))) {
      return Response.json({ error: "Offer API requests must use loopback." }, { status: 400 });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    let context;
    try {
      context = authenticateRoutePrincipal({
        request,
        store: input.windowAuthorityStore,
        now: input.now(),
      });
    } catch {
      return fail("Offer request is unauthorized.", 401);
    }
    if (!principalActsAsHostPerson(context.principal)) return fail("Offers are unavailable.", 404);
    const windowId = context.scopeId;
    const current = retainRouteAdmissionCurrent({
      request,
      context,
      store: input.windowAuthorityStore,
      now: input.now,
    });
    const { offers } = input;
    try {
      if (list && request.method === "GET") {
        const kind = url.searchParams.get("threadKind");
        if (kind !== "chat-thread" && kind !== "work-thread" && kind !== "code-thread") {
          return fail("Offers require a thread.", 400);
        }
        let scopeId;
        try {
          scopeId = decodeImageGenerationScopeId(url.searchParams.get("scopeId"));
        } catch {
          return fail("Offers require a thread.", 400);
        }
        if (
          !(await input.authorizeScope(windowId, kind, scopeId, context.principal)) ||
          !current()
        ) {
          return fail("Offers are unavailable.", 404);
        }
        const supportsReferences = !legacy && url.searchParams.get("referenceImages") === "1";
        const waiting = offers
          .list(windowId, { threadKind: kind, scopeId })
          .filter(
            (offer) =>
              offer.kind !== "transcribe" ||
              (!legacy && url.searchParams.get("transcription") === "1"),
          )
          .filter(
            (offer) =>
              offer.kind !== "narrate" || (!legacy && url.searchParams.get("narration") === "1"),
          )
          // A client that cannot decode the video kinds loses its whole list
          // to one unknown offer, so it is sent none of them.
          .filter(
            (offer) =>
              (offer.kind !== "video-generate" && offer.kind !== "video-save") ||
              (!legacy && url.searchParams.get("video") === "1"),
          )
          .filter(
            (offer) =>
              supportsReferences || offer.kind !== "generate" || offer.references === undefined,
          )
          // A client that cannot say how many files an icon set writes would
          // show only its directory, so it is not shown the offer to approve.
          .filter(
            (offer) =>
              (!legacy && url.searchParams.get("iconSets") === "1") ||
              offer.kind !== "save" ||
              offer.fileCount === undefined,
          );
        const response = { offers: legacy ? waiting.filter(isImageOffer) : waiting };
        return reply(
          legacy
            ? decodeImageGenerationOffersResponse(response)
            : decodeServiceOffersResponse({
                ...response,
                ...(context.principal.kind === "remote-device" &&
                waiting.some((offer) => offer.kind === "generate")
                  ? { imageProfiles: input.listImageProfiles() }
                  : {}),
              }),
        );
      }
      if (decide && request.method === "POST") {
        const body = await readDecision(request);
        if (body.kind === "too-large") return fail("Request body is too large.", 413);
        if (body.kind === "invalid") return fail("Request body must be valid JSON.", 400);
        let decision;
        try {
          decision = legacy
            ? decodeImageGenerationOfferDecision(body.value)
            : decodeServiceOfferDecision(body.value);
        } catch {
          return fail("Offer decision is invalid.", 400);
        }
        if (legacy && decision.decision === "generate") {
          const reason = unavailableImageModel(input.listImageProfiles(), decision);
          if (reason !== undefined)
            return reply(
              decodeImageGenerationOfferDecisionResult({ kind: "image-offer-refused", reason }),
            );
        }
        const waiting = legacy ? offers.find(windowId, decision.offerId) : undefined;
        const result =
          waiting !== undefined && !isImageOffer(waiting)
            ? ({ kind: "offer-gone" } as const)
            : await resolveServiceOfferDecision({
                offers,
                windowId,
                decision,
                actor: eventActorForPrincipal(context.principal),
                authorize: async (offer) =>
                  (await input.authorizeScope(
                    windowId,
                    offer.threadKind,
                    offer.scopeId,
                    context.principal,
                  )) && current(),
                rules: input.rules,
              });
        if (result.kind === "offer-inaccessible") return fail("Offers are unavailable.", 404);
        return reply(
          legacy
            ? decodeImageGenerationOfferDecisionResult({ ...result, kind: `image-${result.kind}` })
            : decodeServiceOfferDecisionResult(result),
        );
      }
    } catch {
      return fail("Offer request failed.", 500);
    }
    return fail("Offer request is invalid.", 405);
  };
}

function isImageOffer(offer: ServiceOffer): boolean {
  return offer.kind === "generate" || offer.kind === "save";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

async function readDecision(request: Request) {
  const reader = request.body?.getReader();
  if (reader === undefined) return { kind: "invalid" } as const;
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > SERVICE_OFFER_DECISION_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { kind: "too-large" } as const;
      }
      body += decoder.decode(part.value, { stream: true });
    }
    const value: unknown = JSON.parse(body + decoder.decode());
    return { kind: "ok", value } as const;
  } catch {
    return { kind: "invalid" } as const;
  } finally {
    reader.releaseLock();
  }
}
