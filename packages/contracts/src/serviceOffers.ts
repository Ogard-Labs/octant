import { Schema } from "effect";
import { personDecides } from "./hostAnswer";
import {
  ImageGenerationGenerateOffer,
  ImageGenerationOfferDecision,
  ImageGenerationOfferId,
  ImageGenerationProfileView,
  ImageGenerationSaveOffer,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
} from "./imageGeneration";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SERVICE_OFFERS_PATH = "/api/offers";
export const SERVICE_OFFERS_DECIDE_PATH = "/api/offers/decide";
export const SERVICE_OFFER_DECISION_MAX_BYTES = 8_192;

export const ServiceOfferId = ImageGenerationOfferId;
export type ServiceOfferId = typeof ServiceOfferId.Type;

export const ServiceOffer = Schema.Union(
  ImageGenerationGenerateOffer,
  ImageGenerationSaveOffer,
).annotations(personDecides);
export type ServiceOffer = typeof ServiceOffer.Type;

export const ServiceOfferDecision = ImageGenerationOfferDecision;
export type ServiceOfferDecision = typeof ServiceOfferDecision.Type;

export const ServiceOffersResponse = Schema.Struct({
  offers: Schema.Array(ServiceOffer).pipe(Schema.maxItems(MAX_PENDING_IMAGE_GENERATION_OFFERS)),
  imageProfiles: Schema.optional(Schema.Array(ImageGenerationProfileView)),
}).annotations(strict);
export type ServiceOffersResponse = typeof ServiceOffersResponse.Type;

export const ServiceOfferDecisionResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("offer-answered") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("offer-gone") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("offer-refused"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000)),
  }).annotations(strict),
);
export type ServiceOfferDecisionResult = typeof ServiceOfferDecisionResult.Type;

export const decodeServiceOffersResponse = Schema.decodeUnknownSync(ServiceOffersResponse);
export const decodeServiceOfferDecision = Schema.decodeUnknownSync(ServiceOfferDecision);
export const decodeServiceOfferDecisionResult = Schema.decodeUnknownSync(
  ServiceOfferDecisionResult,
);
