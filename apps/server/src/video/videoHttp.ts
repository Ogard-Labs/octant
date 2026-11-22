import { MAX_VIDEO_CLIP_BYTES } from "@octant/contracts";
import {
  isVideoEndpointAllowed,
  videoFailure,
  type VideoGenerationPorts,
} from "@octant/provider-sdk/video-generation";
import {
  fetchApprovedImageUrl,
  performImageHttpRequest,
  type ImageHttpFetch,
  type ImageHttpLimits,
} from "../image/imageHttp";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { sniffVideoClipMediaType } from "./videoClipStore";

/**
 * The host's bounds for one video call: a clip at the stored-clip ceiling
 * arriving inline as base64 (4/3 larger) inside a JSON envelope, and long
 * enough for a large clip to arrive. Requests carry at most a few reference
 * images.
 */
export const VIDEO_HTTP_LIMITS: ImageHttpLimits = {
  connectionTimeoutMs: 10 * 60 * 1000,
  requestBodyBytes: 64 * 1024 * 1024,
  responseBodyBytes: 4 * Math.ceil(MAX_VIDEO_CLIP_BYTES / 3) + 1024 * 1024,
};

/**
 * The ports one video profile's adapter receives through the video seam. The
 * credential resolver, key pool, fetch and limits stay here; the adapter only
 * names the header its provider reads.
 */
export function makeVideoGenerationPorts(options: {
  readonly instanceId: string;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly providerHosts: ReadonlyArray<string>;
  readonly fetch?: ImageHttpFetch;
}): VideoGenerationPorts {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    request: async (request) => {
      // Checked before any credential is read: a driver chooses the URL, so
      // the host decides where the profile's key may go.
      if (!isVideoEndpointAllowed(request.url, options.providerHosts)) {
        throw videoFailure(
          "unauthorized",
          "The video provider asked to send its credential outside its own endpoint.",
        );
      }
      return performImageHttpRequest({
        ...request,
        instanceId: options.instanceId,
        credentialResolver: options.credentialResolver,
        fetch,
        limits: VIDEO_HTTP_LIMITS,
      });
    },
    fetchApprovedVideoUrl: async (input) =>
      fetchApprovedImageUrl({
        url: input.url,
        fetch,
        maxBytes: MAX_VIDEO_CLIP_BYTES,
        timeoutMs: VIDEO_HTTP_LIMITS.connectionTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    sniffMediaType: sniffVideoClipMediaType,
  };
}
