import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { CodeRelativePath } from "./code";
import { ProviderModelId } from "./providers";
import {
  SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS,
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  SpeechSynthesisFormat,
  SpeechSynthesisVoice,
} from "./speech";
import { personDecides } from "./hostAnswer";
import {
  ImageGenerationGenerateOffer,
  ImageGenerationOfferDecision,
  ImageGenerationOfferId,
  ImageGenerationProfileView,
  ImageGenerationSaveOffer,
  ImageGenerationScopeId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
} from "./imageGeneration";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SERVICE_OFFERS_PATH = "/api/offers";
export const SERVICE_OFFERS_DECIDE_PATH = "/api/offers/decide";
export const SERVICE_OFFER_DECISION_MAX_BYTES = 8_192;

export const ServiceOfferId = ImageGenerationOfferId;
export type ServiceOfferId = typeof ServiceOfferId.Type;

export const TranscriptionOffer = Schema.Struct({
  kind: Schema.Literal("transcribe"),
  offerId: ServiceOfferId,
  threadKind: Schema.Literal("work-thread", "code-thread"),
  scopeId: ImageGenerationScopeId,
  requestedAt: UtcTimestamp,
  relativePath: CodeRelativePath.pipe(Schema.maxLength(512)),
  sizeBytes: Schema.Int.pipe(
    Schema.positive(),
    Schema.lessThanOrEqualTo(SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES),
  ),
  endpointName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  modelId: ProviderModelId,
}).annotations(strict);
export const decodeTranscriptionOffer = Schema.decodeUnknownSync(TranscriptionOffer);

export const NarrationOffer = Schema.Struct({
  kind: Schema.Literal("narrate"),
  offerId: ServiceOfferId,
  threadKind: Schema.Literal("work-thread", "code-thread"),
  scopeId: ImageGenerationScopeId,
  requestedAt: UtcTimestamp,
  excerpt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300)),
  characters: Schema.Int.pipe(
    Schema.positive(),
    Schema.lessThanOrEqualTo(SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS),
  ),
  relativePath: CodeRelativePath.pipe(Schema.maxLength(512)),
  voice: SpeechSynthesisVoice,
  endpointName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  modelId: ProviderModelId,
  format: SpeechSynthesisFormat,
}).annotations(strict);
export const decodeNarrationOffer = Schema.decodeUnknownSync(NarrationOffer);

export const ServiceOffer = Schema.Union(
  ImageGenerationGenerateOffer,
  ImageGenerationSaveOffer,
  TranscriptionOffer,
  NarrationOffer,
).annotations(personDecides);
export type ServiceOffer = typeof ServiceOffer.Type;

export const ServiceOfferDecision = Schema.Union(
  ImageGenerationOfferDecision,
  Schema.Struct({
    offerId: ServiceOfferId,
    decision: Schema.Literal("transcribe"),
    rememberForThread: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    offerId: ServiceOfferId,
    decision: Schema.Literal("narrate"),
    rememberForThread: Schema.Boolean,
  }).annotations(strict),
);
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
