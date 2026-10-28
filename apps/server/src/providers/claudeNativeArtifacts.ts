import type {
  ClaudeAuthentication,
  ProviderCapabilities,
  ProviderNativeArtifactsUnsupportedReason,
} from "@octant/contracts";

/**
 * The account's Claude artifacts, as its capability reports them: available
 * to its Work and Code threads only on a claude.ai sign-in the person enabled
 * them for, on a host whose own switch does not keep them off.
 */
export function claudeNativeArtifactsSupport(input: {
  readonly authentication: ClaudeAuthentication;
  readonly artifactDelivery: boolean;
  readonly hostTrafficDisabled: boolean;
}): NonNullable<ProviderCapabilities["nativeArtifacts"]> {
  const reason: ProviderNativeArtifactsUnsupportedReason | undefined =
    input.authentication !== "subscription"
      ? "no-publishing-account"
      : input.hostTrafficDisabled
        ? "host-traffic-disabled"
        : !input.artifactDelivery
          ? "turned-off"
          : undefined;
  const support = reason === undefined ? "supported" : "unsupported";
  return {
    chat: "unsupported",
    work: support,
    code: support,
    ...(reason === undefined ? {} : { unsupportedReason: reason }),
  };
}
