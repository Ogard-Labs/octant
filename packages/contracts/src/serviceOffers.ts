import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

export const SERVICE_OFFER_DECISION_MAX_BYTES = 8_192;

export const TranscriptionOffer = Schema.Struct({
  kind: Schema.Literal("transcribe"),
  offerId: ServiceOfferId,
  threadKind: Schema.Literals(["work-thread", "code-thread"]),
  scopeId: ImageGenerationScopeId,
  requestedAt: UtcTimestamp,
  relativePath: CodeRelativePath.check(Schema.isMaxLength(512)),
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES),
  ),
  endpointName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
  modelId: ProviderModelId,
});
export type TranscriptionOffer = typeof TranscriptionOffer.Type;
export const decodeTranscriptionOffer = Schema.decodeUnknownSync(
  TranscriptionOffer,
  STRICT_DECODE_OPTIONS,
);

export const NarrationOffer = Schema.Struct({
  kind: Schema.Literal("narrate"),
  offerId: ServiceOfferId,
  threadKind: Schema.Literals(["work-thread", "code-thread"]),
  scopeId: ImageGenerationScopeId,
  requestedAt: UtcTimestamp,
  excerpt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(300)),
  characters: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS),
  ),
  relativePath: CodeRelativePath.check(Schema.isMaxLength(512)),
  voice: SpeechSynthesisVoice,
  endpointName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
  modelId: ProviderModelId,
  format: SpeechSynthesisFormat,
  canRemember: Schema.optional(Schema.Boolean),
});
export type NarrationOffer = typeof NarrationOffer.Type;
export const decodeNarrationOffer = Schema.decodeUnknownSync(NarrationOffer, STRICT_DECODE_OPTIONS);

export const ServiceOffer = Schema.Union([
  ImageGenerationGenerateOffer,
  ImageGenerationSaveOffer,
  TranscriptionOffer,
  NarrationOffer,
  VideoGenerateOffer,
  VideoSaveOffer,
]).annotate(personDecides);
export type ServiceOffer = typeof ServiceOffer.Type;

export const ServiceOfferDecision = Schema.Union([
  ImageGenerationOfferDecision,
  VideoOfferDecision,
  Schema.Struct({
    offerId: ServiceOfferId,
    decision: Schema.Literal("transcribe"),
    rememberForThread: Schema.Boolean,
  }),
  Schema.Struct({
    offerId: ServiceOfferId,
    decision: Schema.Literal("narrate"),
    rememberForThread: Schema.Boolean,
  }),
]);
export type ServiceOfferDecision = typeof ServiceOfferDecision.Type;

export const ServiceOffersResponse = Schema.Struct({
  offers: Schema.Array(ServiceOffer).check(Schema.isMaxLength(MAX_PENDING_IMAGE_GENERATION_OFFERS)),
  imageProfiles: Schema.optional(Schema.Array(ImageGenerationProfileView)),
});
export type ServiceOffersResponse = typeof ServiceOffersResponse.Type;

/** The strict decode a client runs on one listed offer before it shows or answers it. */
export const decodeServiceOffer = Schema.decodeUnknownSync(ServiceOffer, STRICT_DECODE_OPTIONS);
export const decodeServiceOffersResponse = Schema.decodeUnknownSync(
  ServiceOffersResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeServiceOfferDecision = Schema.decodeUnknownSync(
  ServiceOfferDecision,
  STRICT_DECODE_OPTIONS,
);
