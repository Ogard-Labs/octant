import {
  type RemotePushPlatform,
  type RemotePushPreferencesV1,
  type RemotePushStatusV1,
  RemotePushStatusV1 as RemotePushStatusSchema,
  RemotePushTokenReceiptV1,
  decodeHostAnswer,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

export type MobilePushStatusResult =
  | { readonly status: "ready"; readonly push: RemotePushStatusV1 }
  | { readonly status: "update-host" }
  | { readonly status: "rejected" }
  | { readonly status: "unavailable" };

/**
 * Asks a paired host whether it can send v2 phone notifications directly (or
 * through its hub). A 404 or 405 means an older host that predates direct
 * push and must be updated before this phone can register.
 */
export async function readMobilePushStatus(
  transport: MobileRemoteTransport,
): Promise<MobilePushStatusResult> {
  let response: Response;
  try {
    response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/remote/auth/push-token",
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 404 || response.status === 405) {
    return { status: "update-host" };
  }
  if (response.status === 403 || response.status === 401) {
    return { status: "rejected" };
  }
  if (!response.ok) {
    return { status: "unavailable" };
  }
  try {
    return {
      status: "ready",
      push: decodeHostAnswer(RemotePushStatusSchema)(await response.json()),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export async function registerMobilePushToken(input: {
  readonly transport: MobileRemoteTransport;
  readonly platform: RemotePushPlatform;
  readonly token: string;
  readonly preferences: RemotePushPreferencesV1;
}): Promise<RemotePushTokenReceiptV1> {
  const response = await input.transport.authenticatedFetch({
    method: "PUT",
    path: "/api/remote/auth/push-token",
    body: JSON.stringify({
      version: 2,
      platform: input.platform,
      token: input.token,
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
