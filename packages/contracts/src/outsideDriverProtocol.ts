import { Schema, Struct } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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
import { VideoClipOptions } from "./videoGeneration";

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

/**
 * An outside driver wire protocol major version: a harness endpoint
 * (`harness-endpoint/1`), an image generator (`image-generation/1`), or a
 * video generator (`video-generation/1`).
 */
export const OutsideProviderDriverProtocolVersion = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(harness-endpoint|image-generation|video-generation)\/[1-9][0-9]{0,3}$/),
  ),
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

/**
 * The video generation protocol versions this host speaks. It shares the
 * framing, `initialize`, failures, and the brokered `http/*` calls, and adds
 * `video/start`, `video/poll`, `video/cancel` and `video/forget`, which follow
 * the video seam's adapter one call for one.
 */
export const HOST_VIDEO_GENERATION_PROTOCOL_VERSIONS: ReadonlyArray<OutsideProviderDriverProtocolVersion> =
  [OutsideProviderDriverProtocolVersion.make("video-generation/1")];

/** The protocol family a version belongs to: what kind of driver speaks it. */
export function outsideDriverProtocolFamily(
  version: OutsideProviderDriverProtocolVersion,
): "harness-endpoint" | "image-generation" | "video-generation" {
  if (version.startsWith("image-generation/")) return "image-generation";
  if (version.startsWith("video-generation/")) return "video-generation";
  return "harness-endpoint";
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
  videoStart: "video/start",
  videoPoll: "video/poll",
  videoCancel: "video/cancel",
  videoForget: "video/forget",
  httpRequest: "http/request",
  httpChunk: "http/chunk",
  httpEnd: "http/end",
} as const;

const JsonRpcVersion = Schema.Literal("2.0");
/** A JSON-RPC id. Each side numbers the calls it makes. */
export const OutsideDriverMessageId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export type OutsideDriverMessageId = typeof OutsideDriverMessageId.Type;

/** The host's name for one open session; the driver echoes it and never invents one. */
export const OutsideDriverSessionRef = Schema.String.check(Schema.isPattern(/^s[0-9]{1,15}$/));
export type OutsideDriverSessionRef = typeof OutsideDriverSessionRef.Type;

const PositiveCount = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(100_000_000),
);
const TokenCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000_000),
);
const PositiveTokenCount = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(1_000_000_000),
);

// ── host → driver ──────────────────────────────────────────────────────────

export const OutsideDriverInitializeParams = Schema.Struct({
  protocolVersions: Schema.Array(OutsideProviderDriverProtocolVersion).check(Schema.isMinLength(1)),
  /** Non-secret configuration only: the person's address and listed models. */
  configuration: Schema.Struct({
    baseUrl: Schema.String,
    modelIds: Schema.Array(ProviderModelId),
  }),
});
export type OutsideDriverInitializeParams = typeof OutsideDriverInitializeParams.Type;

export const OutsideDriverSessionOpenParams = Schema.Struct({
  sessionRef: OutsideDriverSessionRef,
  modelId: ProviderModelId,
});
export type OutsideDriverSessionOpenParams = typeof OutsideDriverSessionOpenParams.Type;

/**
 * One message of the conversation as it crosses to the driver. Attachments a
 * person sent never cross: the host refuses a turn that has them, because an
 * outside driver's ceiling keeps image input unsupported.
 */
export const OutsideDriverMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  toolCalls: Schema.optional(Schema.Array(NativeHarnessTranscriptToolCall)),
  toolResults: Schema.optional(
    Schema.Array(
      Schema.Struct({
        toolCallId: Schema.String,
        resultJson: Schema.String,
        isError: Schema.Boolean,
        images: Schema.optional(Schema.Array(ProviderToolImage)),
      }),
    ),
  ),
});
export type OutsideDriverMessage = typeof OutsideDriverMessage.Type;

export const OutsideDriverRequest = Schema.Struct({
  sessionId: ProviderSessionId,
  modelId: ProviderModelId,
  system: Schema.optional(Schema.String),
  history: Schema.Array(OutsideDriverMessage),
  tools: Schema.Array(ProviderToolDefinition),
});
export type OutsideDriverRequest = typeof OutsideDriverRequest.Type;

export const OutsideDriverSessionSendParams = Schema.Struct({
  sessionRef: OutsideDriverSessionRef,
  request: OutsideDriverRequest,
});
export type OutsideDriverSessionSendParams = typeof OutsideDriverSessionSendParams.Type;

/** A notification: the host has already answered the send as interrupted. */
export const OutsideDriverSessionCancelParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
});
export type OutsideDriverSessionCancelParams = typeof OutsideDriverSessionCancelParams.Type;

/** A notification: the host refuses every later send on this session itself. */
export const OutsideDriverSessionReleaseParams = Schema.Struct({
  sessionRef: OutsideDriverSessionRef,
});
export type OutsideDriverSessionReleaseParams = typeof OutsideDriverSessionReleaseParams.Type;

/** Response bytes of a brokered request, as UTF-8 text, in order. */
export const OutsideDriverHttpChunkParams = Schema.Struct({
  httpId: OutsideDriverMessageId,
  data: Schema.String,
});
export type OutsideDriverHttpChunkParams = typeof OutsideDriverHttpChunkParams.Type;

/** The end of a brokered response: complete, or cut off with a closed category. */
export const OutsideDriverHttpEndParams = Schema.Union([
  Schema.Struct({
    httpId: OutsideDriverMessageId,
    outcome: Schema.Literal("complete"),
  }),
  Schema.Struct({
    httpId: OutsideDriverMessageId,
    outcome: Schema.Literal("failed"),
    category: ProviderFailureCategory,
  }),
]);
export type OutsideDriverHttpEndParams = typeof OutsideDriverHttpEndParams.Type;

/** The host's answer to `http/request`: the status and headers, without the credential header. */
export const OutsideDriverHttpResponse = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
export type OutsideDriverHttpResponse = typeof OutsideDriverHttpResponse.Type;

// ── driver → host ──────────────────────────────────────────────────────────

export const OutsideDriverInitializeResult = Schema.Struct({
  protocolVersion: OutsideProviderDriverProtocolVersion,
  cloudSessions: Schema.optional(Schema.Literal("openai-agents-v1")),
});
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
export const OutsideDriverCapabilityClaims = Schema.Struct(capabilityClaimFields).mapFields(
  Struct.map(Schema.optional),
);
export type OutsideDriverCapabilityClaims = typeof OutsideDriverCapabilityClaims.Type;

/**
 * The models the driver can serve. The host offers only the ones the person
 * listed, so no model name the driver writes reaches a person.
 */
export const OutsideDriverProbeResult = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: ProviderModelId.check(Schema.isMaxLength(256)),
      contextWindowTokens: Schema.optional(PositiveCount),
    }),
  ).check(Schema.isMaxLength(256)),
  claims: Schema.optional(OutsideDriverCapabilityClaims),
});
export type OutsideDriverProbeResult = typeof OutsideDriverProbeResult.Type;

/** The bounds `fits` measures a request against; none means every request fits. */
export const OutsideDriverSessionOpenResult = Schema.Struct({
  bounds: Schema.optional(Schema.Struct({ contextWindowTokens: Schema.optional(PositiveCount) })),
});
export type OutsideDriverSessionOpenResult = typeof OutsideDriverSessionOpenResult.Type;

export const OutsideDriverUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadInputTokens: Schema.optional(TokenCount),
  cacheWriteInputTokens: Schema.optional(TokenCount),
  reasoningTokens: Schema.optional(TokenCount),
  costUsd: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
});
export type OutsideDriverUsage = typeof OutsideDriverUsage.Type;

/**
 * What a driver streams while it answers a send. Retries are the host's, so a
 * driver never announces one.
 */
export const OutsideDriverStreamEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text-delta"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("reasoning-delta"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("usage"), ...OutsideDriverUsage.fields }),
]);
export type OutsideDriverStreamEvent = typeof OutsideDriverStreamEvent.Type;

/**
 * A settled answer. It names no served model and no rate limits: those would
 * be the driver's words about the service, which the host does not take.
 */
export const OutsideDriverSessionSendResult = Schema.Struct({
  text: Schema.String,
  toolCalls: Schema.Array(NativeHarnessTranscriptToolCall).check(Schema.isMaxLength(64)),
  usage: Schema.optional(OutsideDriverUsage),
  outputStopReason: Schema.optional(ProviderOutputStopReason),
});
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
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_600_000)),
  ),
  contextOverflow: Schema.optional(
    Schema.Struct({ contextWindowTokens: Schema.optional(PositiveCount) }),
  ),
});
export type OutsideDriverFailureData = typeof OutsideDriverFailureData.Type;

export const OutsideDriverSessionEventParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
  event: OutsideDriverStreamEvent,
});
export type OutsideDriverSessionEventParams = typeof OutsideDriverSessionEventParams.Type;

const HttpHeaderName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/));
// A value that could end its header line early, or end the string in C code, is refused.
const HttpHeaderValue = Schema.String.check(
  Schema.isMaxLength(8_192),
  Schema.makeFilter(
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
  url: Schema.String.check(Schema.isMaxLength(8_192)),
  /**
   * `PUT` and `DELETE` are for the calls that stop a video job or remove the
   * provider's copy; the host refuses them on any call that is not one of a
   * video driver's own.
   */
  method: Schema.Literals(["GET", "POST", "PUT", "DELETE"]),
  headers: Schema.optional(
    Schema.Array(Schema.Tuple([HttpHeaderName, HttpHeaderValue])).check(Schema.isMaxLength(64)),
  ),
  body: Schema.optional(Schema.String),
  auth: Schema.optional(
    Schema.Struct({
      header: HttpHeaderName,
      scheme: Schema.optional(Schema.Literal("Bearer")),
    }),
  ),
});
export type OutsideDriverHttpRequestParams = typeof OutsideDriverHttpRequestParams.Type;

/**
 * Every message a driver may write. A result is read against the call it
 * answers; anything else stops the driver.
 */
export const OutsideDriverToHostMessage = Schema.Union([
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    id: OutsideDriverMessageId,
    result: Schema.Unknown,
  }),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    id: OutsideDriverMessageId,
    error: Schema.Struct({
      code: Schema.Int,
      message: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }),
  }),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    method: Schema.Literal(OUTSIDE_DRIVER_METHODS.sessionEvent),
    params: OutsideDriverSessionEventParams,
  }),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    id: OutsideDriverMessageId,
    method: Schema.Literal(OUTSIDE_DRIVER_METHODS.httpRequest),
    params: OutsideDriverHttpRequestParams,
  }),
  Schema.Struct({
    jsonrpc: JsonRpcVersion,
    method: Schema.Literal(OUTSIDE_DRIVER_METHODS.imageChunk),
    params: Schema.suspend(() => OutsideDriverImageChunkParams),
  }),
]);
export type OutsideDriverToHostMessage = typeof OutsideDriverToHostMessage.Type;

// ── image generation ───────────────────────────────────────────────────────

/** The largest base64 payload one inline driver result may carry in one line. */
export const OUTSIDE_DRIVER_IMAGE_BASE64_CHARACTERS = 4_000_000;

/**
 * The most combined reference-image bytes an outside image job accepts: 2.5 MiB
 * (~3.5M base64 characters), leaving headroom inside the 4 MiB brokered
 * `http/request` line limit so a driver can forward references in JSON without
 * hitting the channel frame cap.
 */
export const OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES = 2_621_440;

/** The largest base64 payload one reference image may carry to an outside image driver. */
export const OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS =
  Math.ceil(OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES / 3) * 4;

const OutsideDriverImageMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const Base64Image = Schema.String.check(
  Schema.isMinLength(4),
  Schema.isMaxLength(OUTSIDE_DRIVER_IMAGE_BASE64_CHARACTERS),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
);

const Base64ReferenceImage = Schema.String.check(
  Schema.isMinLength(4),
  Schema.isMaxLength(OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
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
  variantCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  references: Schema.Array(
    Schema.Struct({
      mediaType: OutsideDriverImageMediaType,
      data: Base64ReferenceImage,
    }),
  ).check(Schema.isMaxLength(16)),
  quality: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String),
  aspectRatio: Schema.optional(Schema.String),
  resolution: Schema.optional(Schema.String),
});
export type OutsideDriverImageGenerateParams = typeof OutsideDriverImageGenerateParams.Type;

/** A notification: the host has already answered the job as interrupted. */
export const OutsideDriverImageCancelParams = Schema.Struct({
  requestId: OutsideDriverMessageId,
});
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
  image: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
  data: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(OUTSIDE_DRIVER_IMAGE_CHUNK_CHARACTERS),
    Schema.makeFilter((data) => data.length % 4 === 0),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
});
export type OutsideDriverImageChunkParams = typeof OutsideDriverImageChunkParams.Type;

/**
 * One image the driver returns: its bytes inline (only when the whole answer
 * fits one line), bytes it streamed as `image/chunk` for this image's index,
 * or an address the provider's own answer named. The host fetches an address itself, once, without the key,
 * and only when it appeared in a response the host relayed for this job, so
 * a driver cannot point the host at an address the provider never gave.
 */
export const OutsideDriverGeneratedImage = Schema.Union([
  Schema.Struct({ mediaType: OutsideDriverImageMediaType, data: Base64Image }),
  Schema.Struct({
    mediaType: OutsideDriverImageMediaType,
    chunked: Schema.Literal(true),
  }),
  Schema.Struct({
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  }),
]);
export type OutsideDriverGeneratedImage = typeof OutsideDriverGeneratedImage.Type;

/**
 * A settled job: the images, or the provider's safety refusal. A refusal
 * carries no text: the host writes the sentence a person reads. Usage the
 * driver reports is never a price; the host settles from its own estimate.
 */
export const OutsideDriverImageGenerateResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    images: Schema.Array(OutsideDriverGeneratedImage).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16),
    ),
  }),
  Schema.Struct({ status: Schema.Literal("refused") }),
]);
export type OutsideDriverImageGenerateResult = typeof OutsideDriverImageGenerateResult.Type;

export const decodeOutsideDriverImageGenerateResult = Schema.decodeUnknownResult(
  OutsideDriverImageGenerateResult,
  STRICT_DECODE_OPTIONS,
);

// ── video generation ───────────────────────────────────────────────────────

/** The provider's name for one clip, as the driver reported it when the clip started. */
export const OutsideDriverVideoRemoteId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
);
export type OutsideDriverVideoRemoteId = typeof OutsideDriverVideoRemoteId.Type;

const OutsideDriverVideoImage = Schema.Struct({
  mediaType: OutsideDriverImageMediaType,
  data: Base64ReferenceImage,
});

/**
 * One clip as it crosses to the driver. The host has already checked the
 * options against the package's declaration, reserved the spend, and read the
 * images; they cross as bytes, never as a path or an address.
 */
export const OutsideDriverVideoStartParams = Schema.Struct({
  modelId: ProviderModelId,
  prompt: Schema.String,
  options: VideoClipOptions,
  firstFrame: Schema.optional(OutsideDriverVideoImage),
  lastFrame: Schema.optional(OutsideDriverVideoImage),
  references: Schema.Array(OutsideDriverVideoImage).check(Schema.isMaxLength(16)),
});
export type OutsideDriverVideoStartParams = typeof OutsideDriverVideoStartParams.Type;

/** `video/poll`, `video/cancel` and `video/forget` each name the clip the start returned. */
export const OutsideDriverVideoJobParams = Schema.Struct({
  remoteId: OutsideDriverVideoRemoteId,
});
export type OutsideDriverVideoJobParams = typeof OutsideDriverVideoJobParams.Type;

/** A started clip, or the provider's safety refusal, which carries no text. */
export const OutsideDriverVideoStartResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    remoteId: OutsideDriverVideoRemoteId,
  }),
  Schema.Struct({ status: Schema.Literal("refused") }),
]);
export type OutsideDriverVideoStartResult = typeof OutsideDriverVideoStartResult.Type;

/**
 * What the provider counted, never what it charged: the host turns counts into
 * money with the package's declared price, so a running driver names no
 * amount. A count of nothing is left out rather than sent as zero.
 */
export const OutsideDriverVideoUsage = Schema.Struct({
  inputTokens: Schema.optional(PositiveTokenCount),
  outputTokens: Schema.optional(PositiveTokenCount),
  billedSeconds: Schema.optional(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(86_400),
    ),
  ),
});
export type OutsideDriverVideoUsage = typeof OutsideDriverVideoUsage.Type;

/**
 * How a clip stands. A finished clip is named by address only, because a clip
 * can be far larger than a line; the host fetches it itself, once, without the
 * key, and only when the provider's own answer named that address. Nothing
 * here carries text: the host writes every sentence a person reads.
 */
export const OutsideDriverVideoPollResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("running") }),
  Schema.Struct({
    status: Schema.Literal("completed"),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
    usage: Schema.optional(OutsideDriverVideoUsage),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    billed: Schema.optional(Schema.Literal(true)),
    usage: Schema.optional(OutsideDriverVideoUsage),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    category: ProviderFailureCategory,
    billed: Schema.optional(Schema.Literal(true)),
    usage: Schema.optional(OutsideDriverVideoUsage),
  }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    usage: Schema.optional(OutsideDriverVideoUsage),
  }),
]);
export type OutsideDriverVideoPollResult = typeof OutsideDriverVideoPollResult.Type;

/** The provider's copy is gone. Anything else is a failure, which the host tries again. */
export const OutsideDriverVideoForgetResult = Schema.Struct({
  status: Schema.Literal("removed"),
});
export type OutsideDriverVideoForgetResult = typeof OutsideDriverVideoForgetResult.Type;

export const decodeOutsideDriverVideoStartResult = Schema.decodeUnknownResult(
  OutsideDriverVideoStartResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverVideoPollResult = Schema.decodeUnknownResult(
  OutsideDriverVideoPollResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverVideoForgetResult = Schema.decodeUnknownResult(
  OutsideDriverVideoForgetResult,
  STRICT_DECODE_OPTIONS,
);

export const decodeOutsideDriverToHostMessage = Schema.decodeUnknownResult(
  OutsideDriverToHostMessage,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverInitializeResult = Schema.decodeUnknownResult(
  OutsideDriverInitializeResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverProbeResult = Schema.decodeUnknownResult(
  OutsideDriverProbeResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverSessionOpenResult = Schema.decodeUnknownResult(
  OutsideDriverSessionOpenResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverSessionSendResult = Schema.decodeUnknownResult(
  OutsideDriverSessionSendResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeOutsideDriverFailureData = Schema.decodeUnknownResult(
  OutsideDriverFailureData,
  STRICT_DECODE_OPTIONS,
);
