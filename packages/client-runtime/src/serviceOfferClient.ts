import {
  decodeHostAnswer,
  SERVICE_OFFERS_DECIDE_PATH,
  SERVICE_OFFERS_PATH,
  ServiceOfferDecisionResult,
  ServiceOffersResponse,
  type ImageGenerationGenerateOffer,
  type ImageGenerationProfileView,
  type ServiceOffer,
  type ServiceOfferDecision,
  type VideoClipOptions,
  type VideoGenerateOffer,
} from "@octant/contracts";
import { imageProfileSupportsReferences } from "@octant/domain";
import {
  checkVideoClipOptions,
  estimateVideoCost,
  estimateVideoPromptTokens,
  videoAspectRatioChoices,
  videoAudioChoices,
  videoDurationValues,
} from "@octant/provider-sdk/video-generation-policy";
import type { MobileRemoteTransport } from "./mobileInboxClient";

export interface ServiceOfferClient {
  offers(scope: Pick<ServiceOffer, "threadKind" | "scopeId">): Promise<ServiceOffersResponse>;
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
  const decodeOffers = decodeHostAnswer(ServiceOffersResponse);
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

/** The agent's suggestion first, followed by the models the host has listed. */
export function imageOfferModelChoices(
  profiles: ReadonlyArray<ImageGenerationProfileView>,
  suggested: ImageGenerationGenerateOffer["suggested"],
  needsReferences = false,
) {
  const choices = profiles
    .filter((profile) => !needsReferences || imageProfileSupportsReferences(profile))
    .flatMap((profile) =>
      profile.modelAllowlist.map((modelId) => {
        const source = profile.sourceLabels?.find(
          (candidate) => String(candidate.modelId) === String(modelId),
        )?.label;
        return {
          id: `${String(profile.instanceId)}::${String(modelId)}`,
          label: `${profile.displayName} · ${source ?? String(modelId)}`,
          profileInstanceId: profile.instanceId,
          modelId,
        };
      }),
    );
  const suggestedId = `${String(suggested.profileInstanceId)}::${String(suggested.modelId)}`;
  const first = choices.find((choice) => choice.id === suggestedId);
  // The profile list can lag; the host validates the choice again before taking it.
  const preferred =
    first ??
    (needsReferences
      ? undefined
      : { ...suggested, id: suggestedId, label: String(suggested.modelId) });
  return preferred === undefined
    ? choices
    : [preferred, ...choices.filter((choice) => choice.id !== suggestedId)];
}

/** The images a video offer names, counted by role as the host checks them. */
function videoOfferInputs(offer: VideoGenerateOffer) {
  return {
    firstFrame: offer.images.some((image) => image.role === "first-frame"),
    lastFrame: offer.images.some((image) => image.role === "last-frame"),
    referenceCount: offer.images.filter((image) => image.role === "reference").length,
  };
}

/** What a video card lets the person choose: exactly what the offered model declares. */
export function videoOfferChoices(offer: VideoGenerateOffer) {
  const inputs = videoOfferInputs(offer);
  return {
    durations: videoDurationValues(offer.model, inputs),
    resolutions: offer.model.resolutions,
    aspectRatios: videoAspectRatioChoices(offer.model, inputs.firstFrame),
    audio: videoAudioChoices(offer.model),
  };
}

/**
 * The card's price line and its Stop and retention notes for the chosen
 * options, from the same policy the host reserves with, so the card and the
 * reservation agree. `approvable` is false when the options fall outside what
 * the model declares or a priced model has no rate for them: the host
 * would refuse either.
 */
export function describeVideoOffer(offer: VideoGenerateOffer, options: VideoClipOptions) {
  const check = checkVideoClipOptions(offer.model, options, videoOfferInputs(offer));
  const estimate = estimateVideoCost(offer.model.price, options, {
    promptTokens: estimateVideoPromptTokens(offer.prompt),
    imageCount: offer.images.length,
  });
  const what = `${String(options.durationSeconds)} s at ${options.resolution}`;
  const price =
    estimate.kind === "estimate"
      ? `About ${formatUsdMicros(estimate.usdMicros)} for ${what}, billed by ${offer.providerName}.`
      : estimate.kind === "unknown"
        ? `Billed by ${offer.providerName}; price not published.`
        : `${offer.model.displayName} has no published price for ${what}.`;
  const job = offer.model.job;
  const stop =
    job.cancel === "running"
      ? undefined
      : `Stop ends the wait; ${offer.providerName} may still finish and bill the clip.`;
  const sent = offer.images.length > 0 ? "the prompt and images" : "the prompt";
  const retention =
    job.removal.kind === "delete"
      ? `${offer.providerName} receives ${sent} and keeps them until Octant removes its copy.`
      : `${offer.providerName} receives ${sent} and keeps them for up to ${String(job.removal.afterHours)} hours.`;
  return {
    price,
    retention,
    approvable: check.status === "allowed" && estimate.kind !== "no-rate",
    ...(stop === undefined ? {} : { stop }),
    ...(check.status === "refused" ? { refusal: check.reason } : {}),
  };
}

function formatUsdMicros(usdMicros: number): string {
  const dollars = usdMicros / 1_000_000;
  return dollars < 0.01 ? "under $0.01" : `$${dollars.toFixed(2)}`;
}
