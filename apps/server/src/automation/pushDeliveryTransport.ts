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
 * Credentialed APNs/FCM remains a named validation gate: the default transport
 * reports `unavailable` and never invents success.
 */
export interface PushDeliveryTransport {
  readonly providerDelivery: () => AutomationNotificationProviderDelivery;
  readonly send: (input: {
    readonly destination: PushDeliveryDestination;
    readonly envelope: RemotePushEnvelopeV1;
  }) => Promise<PushDeliverySendResult>;
}

export function createUnavailablePushDeliveryTransport(): PushDeliveryTransport {
  return {
    providerDelivery: () => "unavailable",
    async send() {
      return {
        kind: "failed",
        retryable: false,
        category: "provider-unavailable",
      };
    },
  };
}

/** Test double that records sends without requiring APNs/FCM credentials. */
export function createRecordingPushDeliveryTransport(options?: {
  readonly providerDelivery?: AutomationNotificationProviderDelivery;
  readonly send?: PushDeliveryTransport["send"];
}): PushDeliveryTransport & {
  readonly sent: Array<{
    readonly destination: PushDeliveryDestination;
    readonly envelope: RemotePushEnvelopeV1;
  }>;
} {
  const sent: Array<{
    readonly destination: PushDeliveryDestination;
    readonly envelope: RemotePushEnvelopeV1;
  }> = [];
  return {
    sent,
    providerDelivery: () => options?.providerDelivery ?? "available",
    async send(input) {
      sent.push(input);
      if (options?.send !== undefined) return options.send(input);
      return { kind: "delivered" };
    },
  };
}
