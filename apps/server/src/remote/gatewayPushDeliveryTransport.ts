// Sends sealed envelopes through the push gateway the Notifications setting
// names.
//
// The host never holds a platform push credential: the gateway does, and it
// accepts a delivery only when the request is signed by the host key whose
// fingerprint the phone sealed into the capability. So the request carries the
// capability the phone registered, the envelope (already sealed to the phone),
// and a signature over both with the listener identity key the phone paired
// with. Nothing else about the host, its threads, or its routes leaves it.

import { createHash } from "node:crypto";
import {
  REMOTE_PUSH_DELIVERY_HEADERS,
  decodeRemotePushGatewayRefusalV1,
  type RemotePushGatewaySettingsV1,
  type RemotePushGatewayRefusalCode,
} from "@octant/contracts/remote-push-notifications";
import { remotePushDeliverySigningText } from "@octant/domain/push-notification-policy";
import type {
  PushDeliverySendResult,
  PushDeliveryTransport,
} from "../automation/pushDeliveryTransport";
import type { HostSigningPort } from "./remoteProtocolService";

const DELIVERY_PATH = "v1/deliveries";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GatewayPushDeliveryTransportOptions {
  /** Read before every send, so turning the setting off stops the next one. */
  readonly settings: () => Pick<RemotePushGatewaySettingsV1, "enabled" | "gatewayUrl">;
  /**
   * The listener identity the phones paired with. A host without one has no
   * paired phone, so it has nothing to send; undefined fails the send.
   */
  readonly signing: () => HostSigningPort | undefined;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
}

export function createGatewayPushDeliveryTransport(
  options: GatewayPushDeliveryTransportOptions,
): PushDeliveryTransport {
  const fetchImpl = options.fetch ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    providerDelivery: () => (options.settings().enabled ? "available" : "unavailable"),
    async send({ destination, envelope }) {
      const settings = options.settings();
      if (!settings.enabled) {
        return { kind: "failed", retryable: false, category: "provider-unavailable" };
      }
      let signing: HostSigningPort | undefined;
      try {
        signing = options.signing();
      } catch {
        signing = undefined;
      }
      if (signing === undefined) {
        return { kind: "failed", retryable: false, category: "host-identity-unavailable" };
      }
      const body = JSON.stringify({ capability: destination.token, envelope });
      const timestamp = clock().toISOString();
      const bodySha256 = createHash("sha256").update(body, "utf8").digest("base64url");
      let signature: string;
      try {
        signature = signing.signHostPayload(
          remotePushDeliverySigningText({ timestamp, bodySha256 }),
        );
      } catch {
        return { kind: "failed", retryable: false, category: "host-identity-unavailable" };
      }
      let response: Response;
      try {
        response = await fetchImpl(new URL(DELIVERY_PATH, withTrailingSlash(settings.gatewayUrl)), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [REMOTE_PUSH_DELIVERY_HEADERS.hostKey]: signing.hostPublicKey,
            [REMOTE_PUSH_DELIVERY_HEADERS.timestamp]: timestamp,
            [REMOTE_PUSH_DELIVERY_HEADERS.signature]: signature,
          },
          body,
          // A gateway that answers with a redirect is refused rather than
          // followed: the signed request goes only to the address the person set.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "failed", retryable: true, category: "gateway-unreachable" };
      }
      return classify(response.status, await refusalCode(response));
    },
  };
}

/**
 * The gateway's answer as a host outcome. Only a gateway that says the
 * platform refused the destination as gone clears the registration; a
 * capability another gateway issued, or one bound to a key this host no longer
 * holds, fails without clearing, so changing the setting back recovers it.
 */
function classify(
  status: number,
  code: RemotePushGatewayRefusalCode | undefined,
): PushDeliverySendResult {
  if (status === 202) return { kind: "delivered" };
  if (status === 410 || code === "destination-gone") return { kind: "destination-gone" };
  if (status === 421 || code === "capability-not-issued-here") {
    return { kind: "failed", retryable: false, category: "gateway-mismatch" };
  }
  if (status === 429 || code === "rate-limited") {
    return { kind: "failed", retryable: true, category: "gateway-rate-limited" };
  }
  if (status === 401 || status === 403) {
    return { kind: "failed", retryable: false, category: "gateway-refused" };
  }
  if (status === 400 || status === 413) {
    return { kind: "failed", retryable: false, category: "gateway-malformed" };
  }
  return { kind: "failed", retryable: true, category: "gateway-failed" };
}

async function refusalCode(response: Response): Promise<RemotePushGatewayRefusalCode | undefined> {
  if (response.status === 202) return undefined;
  try {
    return decodeRemotePushGatewayRefusalV1(await response.json()).code;
  } catch {
    return undefined;
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
