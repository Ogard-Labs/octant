import type { AutomationNotificationProviderDelivery, RemotePushPlatform } from "@octant/contracts";
import type { CheckedPushMessageV2 } from "@octant/domain/push-notification-policy";

export type PushDeliverySendResult =
  | { readonly kind: "delivered" }
  /** The platform refused the destination as gone; the host clears it. */
  | { readonly kind: "destination-gone" }
  | {
      readonly kind: "failed";
      readonly retryable: boolean;
      readonly category: string;
    };

export interface PushDeliveryDestination {
  readonly deviceId: string;
  readonly platform: RemotePushPlatform;
  readonly token: string;
}

/**
 * Host-side push transport, shared by ordinary threads and Automation runs.
 * Accepts only `CheckedPushMessageV2`, branded by the domain push builder after
 * every free-text field has passed the host-side secret check. Sends directly
 * to Apple (APNs) or Google (FCM), or hands off to the host's hub when Push is
 * granted.
 */
export interface PushDeliveryTransport {
  readonly providerDelivery: () => AutomationNotificationProviderDelivery;
  readonly send: (input: {
    readonly destination: PushDeliveryDestination;
    readonly message: CheckedPushMessageV2;
  }) => Promise<PushDeliverySendResult>;
}
