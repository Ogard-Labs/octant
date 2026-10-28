import type {
  AutomationNotificationProviderDelivery,
  RemotePushEnvelopeV1,
  RemotePushPlatform,
} from "@octant/contracts";

export type PushDeliverySendResult =
  | { readonly kind: "delivered" }
  /** The delivery path refused the destination as gone; the host clears it. */
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
 * Host-side push transport, shared by ordinary threads and Automation runs. It
 * is handed only the sealed envelope, never the notification's content.
 * The host's transport sends through the push gateway the Notifications
 * setting names (`remote/gatewayPushDeliveryTransport.ts`).
 */
export interface PushDeliveryTransport {
  readonly providerDelivery: () => AutomationNotificationProviderDelivery;
  readonly send: (input: {
    readonly destination: PushDeliveryDestination;
    readonly envelope: RemotePushEnvelopeV1;
  }) => Promise<PushDeliverySendResult>;
}
