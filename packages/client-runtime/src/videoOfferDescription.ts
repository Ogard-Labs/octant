import type { VideoClipOptions, VideoGenerateOffer } from "@octant/contracts";
import {
  checkVideoClipOptions,
  estimateVideoCost,
  estimateVideoPromptTokens,
  videoAspectRatioChoices,
  videoAudioChoices,
  videoDurationValues,
} from "@octant/provider-sdk/video-generation-policy";

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
    durations: videoDurationValues(offer.model),
    resolutions: offer.model.resolutions,
    aspectRatios: videoAspectRatioChoices(offer.model, inputs.firstFrame),
    audio: videoAudioChoices(offer.model),
  };
}

/**
 * The card's price line and its Stop and retention notes for the chosen
 * options, from the same policy the host reserves with, so the card and the
 * reservation agree. `approvable` is false when the options fall outside what
 * the model declares or a flat-priced model has no rate for them: the host
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
      : `${offer.providerName} receives ${sent} and keeps them for ${String(job.removal.afterHours)} hours.`;
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
