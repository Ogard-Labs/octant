// Host-side direct push delivery transport. Sends checked push messages
// straight to Apple (APNs) or Google (FCM) with this host's stored credentials,
// and never falls back to a gateway or third-party push service.

import type {
  PushDeliverySendResult,
  PushDeliveryTransport,
} from "../automation/pushDeliveryTransport";
import type { DirectPushSender } from "./directPushSenders";
import type { PushSenderService } from "./pushSenderService";

export interface DirectPushDeliveryTransportOptions {
  readonly pushSender: Pick<PushSenderService, "enabled" | "hasAnyCredentialSync">;
  readonly sender: DirectPushSender;
}

export function createDirectPushDeliveryTransport(
  options: DirectPushDeliveryTransportOptions,
): PushDeliveryTransport {
  return {
    providerDelivery: () =>
      options.pushSender.enabled() && options.pushSender.hasAnyCredentialSync()
        ? "available"
        : "unavailable",
    async send({ destination, message }) {
      if (!options.pushSender.enabled()) {
        return { kind: "failed", retryable: false, category: "provider-unavailable" };
      }
      const outcome = await options.sender.send({
        platform: destination.platform,
        token: destination.token,
        message,
      });
      switch (outcome) {
        case "accepted":
          return { kind: "delivered" };
        case "destination-gone":
          return { kind: "destination-gone" };
        case "unavailable":
          return { kind: "failed", retryable: false, category: "provider-unavailable" };
        case "failed":
          return { kind: "failed", retryable: true, category: "platform-failed" };
      }
    },
  };
}
