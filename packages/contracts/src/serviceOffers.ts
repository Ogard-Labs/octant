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
  ImageGenerationOfferDecision,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
} from "./imageGeneration";
import { ImageGenerationGenerateOffer, ImageGenerationSaveOffer } from "./imageGenerationOffers";
import { ServiceOfferId } from "./serviceOfferEnvelope";
import { VideoOfferDecision } from "./videoGeneration";
import { VideoGenerateOffer, VideoSaveOffer } from "./videoGenerationOffers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SERVICE_OFFER_DECISION_MAX_BYTES = 8_192;

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
export type TranscriptionOffer = typeof TranscriptionOffer.Type;
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
  canRemember: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type NarrationOffer = typeof NarrationOffer.Type;
export const decodeNarrationOffer = Schema.decodeUnknownSync(NarrationOffer);

export const ServiceOffer = Schema.Union(
  ImageGenerationGenerateOffer,
  ImageGenerationSaveOffer,
  TranscriptionOffer,
  NarrationOffer,
  VideoGenerateOffer,
  VideoSaveOffer,
).annotations(personDecides);
export type ServiceOffer = typeof ServiceOffer.Type;

export const ServiceOfferDecision = Schema.Union(
  ImageGenerationOfferDecision,
  VideoOfferDecision,
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

/** The strict decode a client runs on one listed offer before it shows or answers it. */
export const decodeServiceOffer = Schema.decodeUnknownSync(ServiceOffer);
export const decodeServiceOffersResponse = Schema.decodeUnknownSync(ServiceOffersResponse);
export const decodeServiceOfferDecision = Schema.decodeUnknownSync(ServiceOfferDecision);
