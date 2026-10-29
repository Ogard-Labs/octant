import {
  type RemotePushCapability,
  type RemotePushGatewayRefusalCode,
  type RemotePushPlatform,
  type RemotePushPreferencesV1,
  RemotePushTokenReceiptV1,
  decodeHostAnswer,
  decodeRemotePushCapabilityResponseV1,
  decodeRemotePushGatewayRefusalV1,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

export async function registerMobilePushToken(input: {
  readonly transport: MobileRemoteTransport;
  readonly platform: RemotePushPlatform;
  readonly token: string;
  /** The public half of the notification key this phone made for this host. */
  readonly notificationPublicKey: string;
  readonly preferences: RemotePushPreferencesV1;
}): Promise<RemotePushTokenReceiptV1> {
  const response = await input.transport.authenticatedFetch({
    method: "PUT",
    path: "/api/remote/auth/push-token",
    body: JSON.stringify({
      platform: input.platform,
      token: input.token,
      notificationPublicKey: input.notificationPublicKey,
      preferences: input.preferences,
    }),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Push token registration failed on the host.",
    );
  }
  try {
    return decodeHostAnswer(RemotePushTokenReceiptV1)(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      "Push token registration returned an invalid response.",
    );
  }
}

export async function clearMobilePushToken(
  transport: MobileRemoteTransport,
): Promise<RemotePushTokenReceiptV1> {
  const response = await transport.authenticatedFetch({
    method: "DELETE",
    path: "/api/remote/auth/push-token",
    body: "{}",
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Push token clear failed on the host.",
    );
  }
  try {
    return decodeHostAnswer(RemotePushTokenReceiptV1)(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", "Push token clear returned an invalid response.");
  }
}

export type MobilePushCapabilityResult =
  | { readonly status: "issued"; readonly capability: RemotePushCapability }
  | { readonly status: "refused"; readonly code: RemotePushGatewayRefusalCode | "unknown" }
  | { readonly status: "unreachable" };

/**
 * Trades this phone's platform token for a delivery capability at the push
 * gateway compiled into its build, bound to one paired computer's key. The
 * host is then given the capability, never the platform token itself.
 */
export async function requestMobilePushCapability(input: {
  readonly gatewayUrl: string;
  readonly platform: RemotePushPlatform;
  readonly token: string;
  readonly hostKeyFingerprint: string;
  readonly fetch?: typeof fetch;
}): Promise<MobilePushCapabilityResult> {
  const fetchImpl = input.fetch ?? fetch;
  const base = input.gatewayUrl.endsWith("/") ? input.gatewayUrl : `${input.gatewayUrl}/`;
  let response: Response;
  try {
    response = await fetchImpl(new URL("v1/capabilities", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: input.platform,
        token: input.token,
        hostKeyFingerprint: input.hostKeyFingerprint,
      }),
      redirect: "error",
    });
  } catch {
    return { status: "unreachable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "refused", code: "unknown" };
  }
  if (response.ok) {
    try {
      return {
        status: "issued",
        capability: decodeRemotePushCapabilityResponseV1(body).capability,
      };
    } catch {
      return { status: "refused", code: "unknown" };
    }
  }
  try {
    return { status: "refused", code: decodeRemotePushGatewayRefusalV1(body).code };
  } catch {
    return { status: "refused", code: "unknown" };
  }
}
