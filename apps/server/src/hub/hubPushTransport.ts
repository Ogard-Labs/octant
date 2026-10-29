// The push delivery transport of a host that may hand its notifications to its
// hub. Where the hub grant ticks Push, each sealed delivery request, signed here
// with this host's own key exactly as the gateway requires, goes to the hub to
// forward. If the hub is unreachable or refuses, the host sends to the gateway
// itself when its own Notifications setting lets it; otherwise the delivery is
// reported as not sent, the way the gateway transport reports any failure. The
// hub is never a reason a notification is lost that the host could have sent.

import type { HubPushHandoff } from "@octant/contracts";
import {
  REMOTE_PUSH_GATEWAY_DEFAULT_URL,
  type RemotePushGatewaySettingsV1,
} from "@octant/contracts/remote-push-notifications";
import type {
  PushDeliverySendResult,
  PushDeliveryTransport,
} from "../automation/pushDeliveryTransport";
import { classifyGatewayAnswer, signGatewayDelivery } from "../remote/gatewayPushDeliveryTransport";
import type { HostSigningPort } from "../remote/remoteProtocolService";
import type { PushHandoffResult } from "./spokePushService";

/** What the transport needs of this host's spoke role; attached once the hub services exist. */
export interface HubPushHandoffPort {
  readonly granted: () => boolean;
  readonly hand: (delivery: HubPushHandoff) => Promise<PushHandoffResult>;
}

/**
 * The transport is made with the automation wiring, before the hub services
 * exist; the remote wiring binds the spoke's port once they do. Until then, or
 * on a host that is no hub's spoke, every delivery goes the gateway's way.
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
  /** The host's own gateway transport: the fallback, and the whole path when the grant does not tick Push. */
  readonly direct: PushDeliveryTransport;
  readonly settings: () => Pick<RemotePushGatewaySettingsV1, "enabled" | "gatewayUrl">;
  readonly signing: () => HostSigningPort | undefined;
  readonly handoff: () => HubPushHandoffPort | undefined;
  readonly clock?: () => Date;
}

export function createHubPushDeliveryTransport(
  options: HubPushDeliveryTransportOptions,
): PushDeliveryTransport {
  const clock = options.clock ?? (() => new Date());
  return {
    providerDelivery: () =>
      options.handoff()?.granted() === true ? "available" : options.direct.providerDelivery(),
    async send(input) {
      const port = options.handoff();
      if (port === undefined || !port.granted()) return options.direct.send(input);
      let signing: HostSigningPort | undefined;
      try {
        signing = options.signing();
      } catch {
        signing = undefined;
      }
      const delivery =
        signing === undefined
          ? undefined
          : signGatewayDelivery({
              signing,
              destination: input.destination,
              envelope: input.envelope,
              clock,
            });
      if (delivery === undefined) {
        return { kind: "failed", retryable: false, category: "host-identity-unavailable" };
      }
      const settings = options.settings();
      const handed = await port.hand({
        ...delivery,
        // Named only when it is not the default; the hub forwards to its own gateway otherwise and refuses a stranger.
        ...(settings.gatewayUrl === REMOTE_PUSH_GATEWAY_DEFAULT_URL
          ? {}
          : { gatewayUrl: settings.gatewayUrl }),
      });
      if (handed.status === "forwarded") {
        return classifyGatewayAnswer(handed.answer.gatewayStatus, handed.answer.code);
      }
      if (settings.enabled) return options.direct.send(input);
      return notSent(handed);
    },
  };
}

/** The hub could not or would not forward, and this host may not send itself: not sent, as a failure. */
function notSent(
  handed: Exclude<PushHandoffResult, { status: "forwarded" }>,
): PushDeliverySendResult {
  if (handed.status === "unreachable") {
    return { kind: "failed", retryable: true, category: "hub-unreachable" };
  }
  if (handed.status === "not-handed") {
    return { kind: "failed", retryable: false, category: "provider-unavailable" };
  }
  // A busy hub or a gateway it could not reach may recover; a hub whose switch is off or that refused this spoke will not.
  const retryable =
    handed.kind === "rate-limited" ||
    handed.kind === "gateway-unreachable" ||
    handed.kind === "handing-back";
  return { kind: "failed", retryable, category: "hub-refused" };
}
