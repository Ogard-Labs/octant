// The push delivery transport of a host that may hand its notifications to its
// hub. Where the hub grant ticks Push, each checked push message (with the
// phone's platform and token) goes to the hub over the signed member link so
// the hub sends it directly to Apple (APNs) or Google (FCM) with the hub's own
// credentials. If the hub is unreachable or refuses, the host sends directly
// itself when its own push sender is enabled and holds credentials; otherwise
// the delivery is reported as not sent.

import type { HubPushDeliveryOutcome, HubPushHandoffV2 } from "@octant/contracts";
import type {
  PushDeliverySendResult,
  PushDeliveryTransport,
} from "../automation/pushDeliveryTransport";
import type { PushHandoffResult } from "./spokePushService";

/** What the transport needs of this host's spoke role; attached once the hub services exist. */
export interface HubPushHandoffPort {
  readonly granted: () => boolean;
  readonly hand: (delivery: HubPushHandoffV2) => Promise<PushHandoffResult>;
}

/**
 * The transport is made with the automation wiring, before the hub services
 * exist; the remote wiring binds the spoke's port once they do. Until then, or
 * on a host that is no hub's spoke, every delivery goes straight to APNs/FCM
 * through this host's own direct sender.
 */
export interface HubPushHandoffSlot {
  readonly current: () => HubPushHandoffPort | undefined;
  readonly bind: (port: HubPushHandoffPort) => void;
}

export function createHubPushHandoffSlot(): HubPushHandoffSlot {
  let bound: HubPushHandoffPort | undefined;
  return {
    current: () => bound,
    bind: (port) => {
      bound = port;
    },
  };
}

export interface HubPushDeliveryTransportOptions {
  /** This host's own direct APNs/FCM transport: the fallback, and the whole path when the grant does not tick Push. */
  readonly direct: PushDeliveryTransport;
  readonly handoff: () => HubPushHandoffPort | undefined;
}

export function createHubPushDeliveryTransport(
  options: HubPushDeliveryTransportOptions,
): PushDeliveryTransport {
  return {
    providerDelivery: () =>
      options.handoff()?.granted() === true ? "available" : options.direct.providerDelivery(),
    async send(input) {
      const port = options.handoff();
      if (port === undefined || !port.granted()) return options.direct.send(input);
      const handed = await port.hand({
        version: 2,
        platform: input.destination.platform,
        token: input.destination.token,
        message: input.message,
      });
      if (handed.status === "forwarded") {
        const result = classifyHubOutcome(handed.answer.outcome);
        if (result.kind === "failed" && result.category === "provider-unavailable") {
          if (options.direct.providerDelivery() === "available") {
            return options.direct.send(input);
          }
        }
        return result;
      }
      if (options.direct.providerDelivery() === "available") {
        return options.direct.send(input);
      }
      return notSent(handed);
    },
  };
}

function classifyHubOutcome(outcome: HubPushDeliveryOutcome): PushDeliverySendResult {
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
}

/** The hub could not or would not send, and this host cannot send itself: not sent, as a failure. */
function notSent(
  handed: Exclude<PushHandoffResult, { status: "forwarded" }>,
): PushDeliverySendResult {
  if (handed.status === "unreachable") {
    return { kind: "failed", retryable: true, category: "hub-unreachable" };
  }
  if (handed.status === "not-handed") {
    return { kind: "failed", retryable: false, category: "provider-unavailable" };
  }
  const retryable = handed.kind === "rate-limited" || handed.kind === "handing-back";
  return { kind: "failed", retryable, category: "hub-refused" };
}
