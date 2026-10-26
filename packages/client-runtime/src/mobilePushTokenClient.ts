import {
  type RemotePushPlatform,
  type RemotePushPreferencesV1,
  RemotePushTokenReceiptV1,
  decodeHostAnswer,
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
