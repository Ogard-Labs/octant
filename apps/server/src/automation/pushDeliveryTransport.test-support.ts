// Test doubles for the host push transport, so delivery tests need no gateway.

import type {
  AutomationNotificationProviderDelivery,
  RemotePushEnvelopeV1,
} from "@octant/contracts";
import type { PushDeliveryDestination, PushDeliveryTransport } from "./pushDeliveryTransport";

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
