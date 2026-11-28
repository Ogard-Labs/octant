import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import {
  ImageGenerationOfferId,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
} from "./imageGeneration";

export const SERVICE_OFFERS_PATH = "/api/offers";
export const SERVICE_OFFERS_DECIDE_PATH = "/api/offers/decide";

export const ServiceOfferId = ImageGenerationOfferId;
export type ServiceOfferId = typeof ServiceOfferId.Type;

/**
 * What a client reads of a waiting offer before it shows one: which offer, of
 * which kind, in which thread. The kind's payload travels with it unread.
 *
 * An envelope is never enough to show or answer an offer. The card for the
 * kind decodes the whole value with that kind's strict schema first, and an
 * offer that decode refuses is not shown, so a person is never shown less than
 * the offer asks. The kind is open text so one a client does not know lists
 * beside the others.
 */
export const ServiceOfferEnvelope = Schema.StructWithRest(
  Schema.Struct({
    offerId: ServiceOfferId,
    kind: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    threadKind: Schema.Literals(["chat-thread", "work-thread", "code-thread"]),
    scopeId: ImageGenerationScopeId,
    requestedAt: UtcTimestamp,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type ServiceOfferEnvelope = typeof ServiceOfferEnvelope.Type;

/** A thread's waiting offers as a client reads them; the host writes `ServiceOffersResponse`. */
export const ServiceOfferEnvelopes = Schema.Struct({
  offers: Schema.Array(ServiceOfferEnvelope).check(
    Schema.isMaxLength(MAX_PENDING_IMAGE_GENERATION_OFFERS),
  ),
  imageProfiles: Schema.optional(Schema.Array(ImageGenerationProfileView)),
});
export type ServiceOfferEnvelopes = typeof ServiceOfferEnvelopes.Type;

export const ServiceOfferDecisionResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("offer-answered") }),
  Schema.Struct({ kind: Schema.Literal("offer-gone") }),
  Schema.Struct({
    kind: Schema.Literal("offer-refused"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  }),
]);
export type ServiceOfferDecisionResult = typeof ServiceOfferDecisionResult.Type;

export const decodeServiceOfferDecisionResult = Schema.decodeUnknownSync(
  ServiceOfferDecisionResult,
  STRICT_DECODE_OPTIONS,
);
