import { Schema } from "effect";
import { MAX_GENERATED_IMAGE_BYTES } from "./imageGeneration";
import { NativeHarnessTranscriptToolCall } from "./nativeHarnessTranscript";
import {
  ProviderCapabilities,
  ProviderFailureCategory,
  ProviderModelId,
  ProviderOutputStopReason,
  ProviderSessionId,
  ProviderToolDefinition,
  ProviderToolImage,
} from "./providers";

/**
 * The harness endpoint wire protocol between the host and an outside provider
 * driver: line-delimited JSON-RPC 2.0, one message per line.
 *
 * The host sends `initialize`, `probe`, and the `session/*` calls; the driver
 * streams `session/event` notifications and asks the host for `http/request`,
 * whose response bytes come back as `http/chunk` and `http/end`. The driver
 * holds no credential and has no network of its own: the brokered request is
 * its only egress. Every schema here that the driver writes is strict, because
 * the host stops a driver at the first message it cannot read rather than
 * guessing at one.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * An outside driver wire protocol major version: a harness endpoint
 * (`harness-endpoint/1`) or an image generator (`image-generation/1`).
 */
export const OutsideProviderDriverProtocolVersion = Schema.String.pipe(
  Schema.pattern(/^(harness-endpoint|image-generation)\/[1-9][0-9]{0,3}$/),
  Schema.brand("OutsideProviderDriverProtocolVersion"),
);
export type OutsideProviderDriverProtocolVersion = typeof OutsideProviderDriverProtocolVersion.Type;

/**
 * The protocol versions this host speaks. A package that declares none of them
 * is refused at inspection, and the `initialize` handshake must settle on one.
 */
export const HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS: ReadonlyArray<OutsideProviderDriverProtocolVersion> =
  [OutsideProviderDriverProtocolVersion.make("harness-endpoint/1")];

/**
 * The image generation protocol versions this host speaks. It shares the
 * framing, `initialize`, failures, and the brokered `http/*` calls with the
 * harness endpoint protocol, and adds `image/generate` and `image/cancel` in
 * place of the `probe` and `session/*` calls.
 */
export const HOST_IMAGE_GENERATION_PROTOCOL_VERSIONS: ReadonlyArray<OutsideProviderDriverProtocolVersion> =
  [OutsideProviderDriverProtocolVersion.make("image-generation/1")];

/** The protocol family a version belongs to: what kind of driver speaks it. */
export function outsideDriverProtocolFamily(
  version: OutsideProviderDriverProtocolVersion,
): "harness-endpoint" | "image-generation" {
  return version.startsWith("image-generation/") ? "image-generation" : "harness-endpoint";
}

export const OUTSIDE_DRIVER_METHODS = {
  initialize: "initialize",
  probe: "probe",
  sessionOpen: "session/open",
  sessionSend: "session/send",
  sessionCancel: "session/cancel",
  sessionRelease: "session/release",
  sessionEvent: "session/event",
  cloudCreate: "cloud/create",
  cloudRead: "cloud/read",
  cloudCancel: "cloud/cancel",
  imageGenerate: "image/generate",
  imageCancel: "image/cancel",
  imageChunk: "image/chunk",
  httpRequest: "http/request",
  httpChunk: "http/chunk",
  httpEnd: "http/end",
} as const;

const JsonRpcVersion = Schema.Literal("2.0");
/** A JSON-RPC id. Each side numbers the calls it makes. */
export const OutsideDriverMessageId = Schema.Int.pipe(
  Schema.positive(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export type OutsideDriverMessageId = typeof OutsideDriverMessageId.Type;

/** The host's name for one open session; the driver echoes it and never invents one. */
export const OutsideDriverSessionRef = Schema.String.pipe(Schema.pattern(/^s[0-9]{1,15}$/));
export type OutsideDriverSessionRef = typeof OutsideDriverSessionRef.Type;

const PositiveCount = Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(100_000_000));
const TokenCount = Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(1_000_000_000));

// ── host → driver ──────────────────────────────────────────────────────────

export const OutsideDriverInitializeParams = Schema.Struct({
  protocolVersions: Schema.Array(OutsideProviderDriverProtocolVersion).pipe(Schema.minItems(1)),
  /** Non-secret configuration only: the person's address and listed models. */
  configuration: Schema.Struct({
    baseUrl: Schema.String,
    modelIds: Schema.Array(ProviderModelId),
  }).annotations(strict),
}).annotations(strict);
export type OutsideDriverInitializeParams = typeof OutsideDriverInitializeParams.Type;

export const OutsideDriverSessionOpenParams = Schema.Struct({
  sessionRef: OutsideDriverSessionRef,
  modelId: ProviderModelId,
}).annotations(strict);
export type OutsideDriverSessionOpenParams = typeof OutsideDriverSessionOpenParams.Type;

/**
 * One message of the conversation as it crosses to the driver. Attachments a
 * person sent never cross: the host refuses a turn that has them, because an
 * outside driver's ceiling keeps image input unsupported.
 */
export const OutsideDriverMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  toolCalls: Schema.optional(Schema.Array(NativeHarnessTranscriptToolCall)),
  toolResults: Schema.optional(
    Schema.Array(
      Schema.Struct({
        toolCallId: Schema.String,
        resultJson: Schema.String,
        isError: Schema.Boolean,
        images: Schema.optional(Schema.Array(ProviderToolImage)),
      }).annotations(strict),
    ),
  ),
}).annotations(strict);
export type OutsideDriverMessage = typeof OutsideDriverMessage.Type;

export const OutsideDriverRequest = Schema.Struct({
  sessionId: ProviderSessionId,
  modelId: ProviderModelId,
  system: Schema.optional(Schema.String),
  history: Schema.Array(OutsideDriverMessage),
  tools: Schema.Array(ProviderToolDefinition),
}).annotations(strict);
export type OutsideDriverRequest = typeof OutsideDriverRequest.Type;

export const OutsideDriverSessionSendParams = Schema.Struct({
  sessionRef: OutsideDriverSessionRef,
  request: OutsideDriverRequest,
}).annotations(strict);
export type OutsideDriverSessionSendParams = typeof OutsideDriverSessionSendParams.Type;

/** A notification: the host has already answered the send as interrupted. */
export const OutsideDriverSessionCancelParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
}).annotations(strict);
export type OutsideDriverSessionCancelParams = typeof OutsideDriverSessionCancelParams.Type;

/** A notification: the host refuses every later send on this session itself. */
export const OutsideDriverSessionReleaseParams = Schema.Struct({
  sessionRef: OutsideDriverSessionRef,
}).annotations(strict);
export type OutsideDriverSessionReleaseParams = typeof OutsideDriverSessionReleaseParams.Type;

/** Response bytes of a brokered request, as UTF-8 text, in order. */
export const OutsideDriverHttpChunkParams = Schema.Struct({
  httpId: OutsideDriverMessageId,
  data: Schema.String,
}).annotations(strict);
export type OutsideDriverHttpChunkParams = typeof OutsideDriverHttpChunkParams.Type;

/** The end of a brokered response: complete, or cut off with a closed category. */
export const OutsideDriverHttpEndParams = Schema.Union(
  Schema.Struct({
    httpId: OutsideDriverMessageId,
    outcome: Schema.Literal("complete"),
  }).annotations(strict),
  Schema.Struct({
    httpId: OutsideDriverMessageId,
    outcome: Schema.Literal("failed"),
    category: ProviderFailureCategory,
  }).annotations(strict),
);
export type OutsideDriverHttpEndParams = typeof OutsideDriverHttpEndParams.Type;

/** The host's answer to `http/request`: the status and headers, without the credential header. */
export const OutsideDriverHttpResponse = Schema.Struct({
  status: Schema.Int.pipe(Schema.between(100, 599)),
  headers: Schema.Array(Schema.Tuple(Schema.String, Schema.String)),
}).annotations(strict);
export type OutsideDriverHttpResponse = typeof OutsideDriverHttpResponse.Type;

// ── driver → host ──────────────────────────────────────────────────────────

export const OutsideDriverInitializeResult = Schema.Struct({
  protocolVersion: OutsideProviderDriverProtocolVersion,
  cloudSessions: Schema.optional(Schema.Literal("openai-agents-v1")),
}).annotations(strict);
export type OutsideDriverInitializeResult = typeof OutsideDriverInitializeResult.Type;

const capabilityClaimFields = (() => {
  const { sessionCompaction: _sessionCompaction, ...flat } = ProviderCapabilities.fields;
  return flat;
})();

/**
 * What a driver says its service can do. The host clamps every claim to the
 * outside family's ceiling, so a claim can lower a capability but never raise
 * one; compaction is the host's and is not claimable.
 */
export const OutsideDriverCapabilityClaims = Schema.partial(
  Schema.Struct(capabilityClaimFields),
).annotations(strict);
export type OutsideDriverCapabilityClaims = typeof OutsideDriverCapabilityClaims.Type;

/**
 * The models the driver can serve. The host offers only the ones the person
 * listed, so no model name the driver writes reaches a person.
 */
export const OutsideDriverProbeResult = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: ProviderModelId.pipe(Schema.maxLength(256)),
      contextWindowTokens: Schema.optional(PositiveCount),
    }).annotations(strict),
  ).pipe(Schema.maxItems(256)),
  claims: Schema.optional(OutsideDriverCapabilityClaims),
}).annotations(strict);
export type OutsideDriverProbeResult = typeof OutsideDriverProbeResult.Type;

/** The bounds `fits` measures a request against; none means every request fits. */
export const OutsideDriverSessionOpenResult = Schema.Struct({
  bounds: Schema.optional(
    Schema.Struct({ contextWindowTokens: Schema.optional(PositiveCount) }).annotations(strict),
  ),
}).annotations(strict);
export type OutsideDriverSessionOpenResult = typeof OutsideDriverSessionOpenResult.Type;

export const OutsideDriverUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadInputTokens: Schema.optional(TokenCount),
  cacheWriteInputTokens: Schema.optional(TokenCount),
  reasoningTokens: Schema.optional(TokenCount),
  costUsd: Schema.optional(Schema.Number.pipe(Schema.finite(), Schema.between(0, 1_000_000))),
}).annotations(strict);
export type OutsideDriverUsage = typeof OutsideDriverUsage.Type;

/**
 * What a driver streams while it answers a send. Retries are the host's, so a
 * driver never announces one.
 */
export const OutsideDriverStreamEvent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("text-delta"), text: Schema.String }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("reasoning-delta"), text: Schema.String }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("usage"), ...OutsideDriverUsage.fields }).annotations(
    strict,
  ),
);
export type OutsideDriverStreamEvent = typeof OutsideDriverStreamEvent.Type;

/**
 * A settled answer. It names no served model and no rate limits: those would
 * be the driver's words about the service, which the host does not take.
 */
export const OutsideDriverSessionSendResult = Schema.Struct({
  text: Schema.String,
  toolCalls: Schema.Array(NativeHarnessTranscriptToolCall).pipe(Schema.maxItems(64)),
  usage: Schema.optional(OutsideDriverUsage),
  outputStopReason: Schema.optional(ProviderOutputStopReason),
}).annotations(strict);
export type OutsideDriverSessionSendResult = typeof OutsideDriverSessionSendResult.Type;

/**
 * Why a driver's call failed, as structure the host can read. The host writes
 * every message itself from these fields; a driver's own text is never kept.
 * `contextWindowTokens` says the request outgrew the model's window and, when
 * known, how large that window is.
 */
export const OutsideDriverFailureData = Schema.Struct({
  category: ProviderFailureCategory,
  retryAfterMs: Schema.optional(
    Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(3_600_000)),
  ),
  contextOverflow: Schema.optional(
    Schema.Struct({ contextWindowTokens: Schema.optional(PositiveCount) }).annotations(strict),
  ),
}).annotations(strict);
export type OutsideDriverFailureData = typeof OutsideDriverFailureData.Type;

export const OutsideDriverSessionEventParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
  event: OutsideDriverStreamEvent,
}).annotations(strict);
export type OutsideDriverSessionEventParams = typeof OutsideDriverSessionEventParams.Type;

const HttpHeaderName = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/));
// A value that could end its header line early, or end the string in C code, is refused.
const HttpHeaderValue = Schema.String.pipe(
  Schema.maxLength(8_192),
  Schema.filter(
    (value) => !value.includes("\r") && !value.includes("\n") && !value.includes("\u0000"),
  ),
);

/**
 * One call the driver asks the host to make. The driver names where the
 * credential goes (`auth`), never the credential: the host leases this
 * instance's key, sets the header, and sends the request only to the
 * instance's configured origin.
 *
 * `requestId` names the `session/send` the call serves, so the host can close
 * the call when it cancels that send. A probe's call serves no send and omits
 * it; a send the host never issued stops the driver.
 */
export const OutsideDriverHttpRequestParams = Schema.Struct({
  requestId: Schema.optional(OutsideDriverMessageId),
  url: Schema.String.pipe(Schema.maxLength(8_192)),
  method: Schema.Literal("GET", "POST"),
  headers: Schema.optional(
    Schema.Array(Schema.Tuple(HttpHeaderName, HttpHeaderValue)).pipe(Schema.maxItems(64)),
  ),
  body: Schema.optional(Schema.String),
  auth: Schema.optional(
    Schema.Struct({
      header: HttpHeaderName,
      scheme: Schema.optional(Schema.Literal("Bearer")),
    }).annotations(strict),
  ),
}).annotations(strict);
export type OutsideDriverHttpRequestParams = typeof OutsideDriverHttpRequestParams.Type;

/**
 * Every message a driver may write. A result is read against the call it
 * answers; anything else stops the driver.
 */
export const OutsideDriverToHostMessage = Schema.Union(
  // `exact`, because a missing key reads as `undefined`, which `Unknown`
  // accepts: without it a bare `{ jsonrpc, id }` decodes as an answer that has
  // neither a result nor an error.
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    id: OutsideDriverMessageId,
    result: Schema.Unknown,
  }).annotations({ parseOptions: { onExcessProperty: "error", exact: true } }),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    id: OutsideDriverMessageId,
    error: Schema.Struct({
      code: Schema.Int,
      message: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }).annotations(strict),
  }).annotations(strict),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    method: Schema.Literal(OUTSIDE_DRIVER_METHODS.sessionEvent),
    params: OutsideDriverSessionEventParams,
  }).annotations(strict),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    id: OutsideDriverMessageId,
    method: Schema.Literal(OUTSIDE_DRIVER_METHODS.httpRequest),
    params: OutsideDriverHttpRequestParams,
  }).annotations(strict),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    method: Schema.Literal(OUTSIDE_DRIVER_METHODS.imageChunk),
    params: Schema.suspend(() => OutsideDriverImageChunkParams),
  }).annotations(strict),
);
export type OutsideDriverToHostMessage = typeof OutsideDriverToHostMessage.Type;

// ── image generation ───────────────────────────────────────────────────────

/** The largest base64 payload one inline driver result may carry in one line. */
export const OUTSIDE_DRIVER_IMAGE_BASE64_CHARACTERS = 4_000_000;

/**
 * The largest base64 payload a reference image may carry from the host to the
 * driver: matches `MAX_GENERATED_IMAGE_BYTES` so every reference image
 * `ImageJobService` accepts crosses without violating the protocol schema.
 */
export const OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS =
  Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;

const OutsideDriverImageMediaType = Schema.Literal(
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
);

const Base64Image = Schema.String.pipe(
  Schema.minLength(4),
  Schema.maxLength(OUTSIDE_DRIVER_IMAGE_BASE64_CHARACTERS),
  Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/),
);

const Base64ReferenceImage = Schema.String.pipe(
  Schema.minLength(4),
  Schema.maxLength(OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS),
  Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/),
);

/**
 * One image job as it crosses to the driver. The host has already chosen the
 * model from those the person listed and the package declared, frozen the
 * options, and reserved the spend; `variantCount` is the most images the host
 * accepts back. Reference images cross as bytes the host read and checked,
 * never as a path or address.
 */
export const OutsideDriverImageGenerateParams = Schema.Struct({
  modelId: ProviderModelId,
  prompt: Schema.String,
  variantCount: Schema.Int.pipe(Schema.between(1, 16)),
  references: Schema.Array(
    Schema.Struct({
      mediaType: OutsideDriverImageMediaType,
      data: Base64ReferenceImage,
    }).annotations(strict),
  ).pipe(Schema.maxItems(16)),
  quality: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String),
  aspectRatio: Schema.optional(Schema.String),
  resolution: Schema.optional(Schema.String),
}).annotations(strict);
export type OutsideDriverImageGenerateParams = typeof OutsideDriverImageGenerateParams.Type;

/** A notification: the host has already answered the job as interrupted. */
export const OutsideDriverImageCancelParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
}).annotations(strict);
export type OutsideDriverImageCancelParams = typeof OutsideDriverImageCancelParams.Type;

/** The most base64 characters one `image/chunk` may carry, well inside a line. */
export const OUTSIDE_DRIVER_IMAGE_CHUNK_CHARACTERS = 1_000_000;

/**
 * A notification: part of one image's bytes, in order, before the driver
 * answers `image/generate`. A line is capped well below a whole image, so an
 * image larger than an inline answer can carry crosses as chunks, and the
 * answer names it with `chunked: true`. Base64 is chunked on four-character
 * boundaries so each piece decodes on its own.
 */
export const OutsideDriverImageChunkParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
  image: Schema.Int.pipe(Schema.between(0, 15)),
  data: Schema.String.pipe(
    Schema.minLength(4),
    Schema.maxLength(OUTSIDE_DRIVER_IMAGE_CHUNK_CHARACTERS),
    Schema.filter((data) => data.length % 4 === 0),
    Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
}).annotations(strict);
export type OutsideDriverImageChunkParams = typeof OutsideDriverImageChunkParams.Type;

/**
 * One image the driver returns: its bytes inline (only when the whole answer
 * fits one line), bytes it streamed as `image/chunk` for this image's index,
 * or an address the provider's own answer named. The host fetches an address itself, once, without the key,
 * and only when it appeared in a response the host relayed for this job, so
 * a driver cannot point the host at an address the provider never gave.
 */
export const OutsideDriverGeneratedImage = Schema.Union(
  Schema.Struct({ mediaType: OutsideDriverImageMediaType, data: Base64Image }).annotations(strict),
  Schema.Struct({
    mediaType: OutsideDriverImageMediaType,
    chunked: Schema.Literal(true),
  }).annotations(strict),
  Schema.Struct({
    url: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8_192)),
  }).annotations(strict),
);
export type OutsideDriverGeneratedImage = typeof OutsideDriverGeneratedImage.Type;

/**
 * A settled job: the images, or the provider's safety refusal. A refusal
 * carries no text: the host writes the sentence a person reads. Usage the
 * driver reports is never a price; the host settles from its own estimate.
 */
export const OutsideDriverImageGenerateResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("completed"),
    images: Schema.Array(OutsideDriverGeneratedImage).pipe(Schema.minItems(1), Schema.maxItems(16)),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("refused") }).annotations(strict),
);
export type OutsideDriverImageGenerateResult = typeof OutsideDriverImageGenerateResult.Type;

export const decodeOutsideDriverImageGenerateResult = Schema.decodeUnknownEither(
  OutsideDriverImageGenerateResult,
);

export const decodeOutsideDriverToHostMessage = Schema.decodeUnknownEither(
  OutsideDriverToHostMessage,
);
export const decodeOutsideDriverInitializeResult = Schema.decodeUnknownEither(
  OutsideDriverInitializeResult,
);
export const decodeOutsideDriverProbeResult = Schema.decodeUnknownEither(OutsideDriverProbeResult);
export const decodeOutsideDriverSessionOpenResult = Schema.decodeUnknownEither(
  OutsideDriverSessionOpenResult,
);
export const decodeOutsideDriverSessionSendResult = Schema.decodeUnknownEither(
  OutsideDriverSessionSendResult,
);
export const decodeOutsideDriverFailureData = Schema.decodeUnknownEither(OutsideDriverFailureData);
