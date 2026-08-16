import {
  decodeRemotePushTokenReceiptV1,
  type RemotePushPlatform,
  type RemotePushTokenReceiptV1,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

export async function registerMobilePushToken(input: {
  readonly transport: MobileRemoteTransport;
  readonly platform: RemotePushPlatform;
  readonly token: string;
}): Promise<RemotePushTokenReceiptV1> {
  const response = await input.transport.authenticatedFetch({
    method: "PUT",
    path: "/api/remote/auth/push-token",
    body: JSON.stringify({ platform: input.platform, token: input.token }),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Push token registration failed on the host.",
    );
  }
  try {
    return decodeRemotePushTokenReceiptV1(await response.json());
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
    return decodeRemotePushTokenReceiptV1(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", "Push token clear returned an invalid response.");
  }
}
