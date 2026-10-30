// The push gateway's rules, served by a hub for a phone app its person built
// themselves. The wire shapes are the gateway's (`remotePushNotifications.ts`)
// and the signing text is the domain policy's, both unchanged; this is the
// service on the other side of them (docs/design/mobile-maturity.md § Gateway
// rules).
//
// It keeps nothing per device. A capability is the platform token, platform,
// and host-key fingerprint sealed under a key only this hub holds; a delivery is
// accepted only when the request is signed by the key whose fingerprint is
// sealed in it. What it holds in memory is rate counters and the signed text of
// recent deliveries, so a captured request cannot be sent twice. It logs and
// returns nothing of a token, capability, fingerprint, or credential.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import {
  REMOTE_PUSH_DELIVERY_SKEW_MS,
  decodeRemotePushCapabilityRequestV1,
  decodeRemotePushDeliveryRequestV1,
  type RemotePushGatewayRefusalCode,
  type RemotePushPlatform,
} from "@octant/contracts";
import { decidePushRate } from "@octant/domain";
import { remotePushDeliverySigningText } from "@octant/domain/push-notification-policy";
import type { DirectPushSender } from "./directPushSenders";

/** The name of the key every capability this hub issues is sealed under. */
export const DIRECT_PUSH_SEALING_KEY_ID = "hub1";

const CAPABILITY_ASSOCIATED_DATA_PREFIX = "octant-push-capability-v1\n";
const REQUEST_MAX_BYTES = 8_192;
const TOKEN_MAX_BYTES = 512;
const CAPABILITIES_PER_CLIENT_PER_MINUTE = 30;
const DELIVERIES_PER_MINUTE = 12;
const RATE_WINDOW_MS = 60_000;
const REPLAY_WINDOW_MS = 600_000;
const PRUNE_ABOVE = 2_048;

export type DirectPushGatewayAnswer =
  | { readonly status: 200; readonly capability: string }
  | { readonly status: 202 }
  | { readonly status: number; readonly code: RemotePushGatewayRefusalCode };

export interface DirectPushGatewayOptions {
  /** Whether this hub sends directly. Read on every request, so turning it off answers `unavailable` at once. */
  readonly enabled: () => boolean;
  /** The 32-byte key capabilities are sealed under, made on first use; undefined when the credential store is unavailable. */
  readonly sealingKey: () => Promise<Buffer | undefined>;
  /** Whether this hub holds a credential for the platform, so it never issues a capability it cannot deliver. */
  readonly holdsCredential: (platform: RemotePushPlatform) => Promise<boolean>;
  readonly sender: DirectPushSender;
  readonly now: () => number;
}

export interface DirectPushGateway {
  readonly issueCapability: (body: string, clientKey: string) => Promise<DirectPushGatewayAnswer>;
  readonly deliver: (
    body: string,
    headers: {
      readonly hostKey: string | null;
      readonly timestamp: string | null;
      readonly signature: string | null;
    },
  ) => Promise<DirectPushGatewayAnswer>;
}

interface OpenedCapability {
  readonly platform: RemotePushPlatform;
  readonly token: string;
  readonly hostKeyFingerprint: string;
}

const refuse = (status: number, code: RemotePushGatewayRefusalCode): DirectPushGatewayAnswer => ({
  status,
  code,
});

export function createDirectPushGateway(options: DirectPushGatewayOptions): DirectPushGateway {
  const clientRates = new Map<string, ReadonlyArray<number>>();
  const capabilityRates = new Map<string, ReadonlyArray<number>>();
  const phoneRates = new Map<string, ReadonlyArray<number>>();
  const seenDeliveries = new Map<string, number>();

  const prune = (rates: Map<string, ReadonlyArray<number>>, now: number) => {
    if (rates.size <= PRUNE_ABOVE) return;
    for (const [key, times] of rates) {
      if (!times.some((at) => at > now - RATE_WINDOW_MS)) rates.delete(key);
    }
  };

  return {
    async issueCapability(body, clientKey) {
      if (!options.enabled()) return refuse(503, "unavailable");
      if (Buffer.byteLength(body, "utf8") > REQUEST_MAX_BYTES) return refuse(400, "malformed");
      let request;
      try {
        request = decodeRemotePushCapabilityRequestV1(JSON.parse(body));
      } catch {
        return refuse(400, "malformed");
      }
      if (
        Buffer.byteLength(request.token, "utf8") > TOKEN_MAX_BYTES ||
        // An Apple token is hexadecimal; anything else could never be delivered to.
        (request.platform === "ios" && !/^[0-9a-fA-F]+$/.test(request.token))
      ) {
        return refuse(400, "malformed");
      }
      const now = options.now();
      const decision = decidePushRate({
        recent: clientRates.get(clientKey) ?? [],
        nowMs: now,
        windowMs: RATE_WINDOW_MS,
        max: CAPABILITIES_PER_CLIENT_PER_MINUTE,
      });
      if (decision.status === "refuse") return refuse(429, "rate-limited");
      clientRates.set(clientKey, decision.recent);
      prune(clientRates, now);
      if (!(await options.holdsCredential(request.platform))) return refuse(503, "unavailable");
      const key = await options.sealingKey();
      if (key === undefined) return refuse(503, "unavailable");
      return { status: 200, capability: sealCapability(key, request) };
    },

    async deliver(body, headers) {
      if (!options.enabled()) return refuse(503, "unavailable");
      if (Buffer.byteLength(body, "utf8") > REQUEST_MAX_BYTES) return refuse(400, "malformed");
      let request;
      try {
        request = decodeRemotePushDeliveryRequestV1(JSON.parse(body));
      } catch {
        return refuse(400, "malformed");
      }
      const key = await options.sealingKey();
      if (key === undefined) return refuse(503, "unavailable");
      const opened = openCapability(key, request.capability);
      if (opened === undefined) return refuse(421, "capability-not-issued-here");

      const hostKeyDer = headers.hostKey === null ? undefined : decodeBase64Url(headers.hostKey);
      if (
        hostKeyDer === undefined ||
        createHash("sha256").update(hostKeyDer).digest("hex") !== opened.hostKeyFingerprint
      ) {
        return refuse(403, "host-key-mismatch");
      }
      const now = options.now();
      if (
        headers.timestamp === null ||
        headers.signature === null ||
        !Number.isFinite(Date.parse(headers.timestamp)) ||
        Math.abs(now - Date.parse(headers.timestamp)) > REMOTE_PUSH_DELIVERY_SKEW_MS
      ) {
        return refuse(401, "signature-invalid");
      }
      const signedText = remotePushDeliverySigningText({
        timestamp: headers.timestamp,
        bodySha256: createHash("sha256").update(body, "utf8").digest("base64url"),
      });
      if (!signatureHolds(hostKeyDer, signedText, headers.signature)) {
        return refuse(401, "signature-invalid");
      }
      for (const [text, seenAt] of seenDeliveries) {
        if (seenAt <= now - REPLAY_WINDOW_MS) seenDeliveries.delete(text);
      }
      // Keyed by the signed text: an ECDSA signature has a second valid form, so the signature itself would let a replay through.
      if (seenDeliveries.has(signedText)) return refuse(401, "signature-invalid");
      seenDeliveries.set(signedText, now);

      const capabilityKey = hash(request.capability);
      // APNs tokens are hex in either case and the sender lowercases them, so every spelling of
      // one phone must share one counter.
      const phoneToken = opened.platform === "ios" ? opened.token.toLowerCase() : opened.token;
      const phoneKey = hash(`${opened.platform}\n${phoneToken}`);
      const perCapability = decidePushRate({
        recent: capabilityRates.get(capabilityKey) ?? [],
        nowMs: now,
        windowMs: RATE_WINDOW_MS,
        max: DELIVERIES_PER_MINUTE,
      });
      const perPhone = decidePushRate({
        recent: phoneRates.get(phoneKey) ?? [],
        nowMs: now,
        windowMs: RATE_WINDOW_MS,
        max: DELIVERIES_PER_MINUTE,
      });
      if (perCapability.status === "refuse" || perPhone.status === "refuse") {
        return refuse(429, "rate-limited");
      }
      capabilityRates.set(capabilityKey, perCapability.recent);
      phoneRates.set(phoneKey, perPhone.recent);
      prune(capabilityRates, now);
      prune(phoneRates, now);

      const outcome = await options.sender.send({
        platform: opened.platform,
        token: opened.token,
        envelope: request.envelope,
      });
      if (outcome === "accepted") return { status: 202 };
      if (outcome === "destination-gone") return refuse(410, "destination-gone");
      if (outcome === "unavailable") return refuse(503, "unavailable");
      return refuse(502, "platform-failed");
    },
  };
}

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("base64url");

/** `v1.<key id>.<sealed>`: a random 12-byte nonce, then AES-256-GCM over the three fields, tag last. */
function sealCapability(
  key: Buffer,
  request: {
    readonly platform: string;
    readonly token: string;
    readonly hostKeyFingerprint: string;
  },
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${CAPABILITY_ASSOCIATED_DATA_PREFIX}${DIRECT_PUSH_SEALING_KEY_ID}`));
  const sealed = Buffer.concat([
    cipher.update(
      JSON.stringify({
        platform: request.platform,
        token: request.token,
        hostKeyFingerprint: request.hostKeyFingerprint,
      }),
      "utf8",
    ),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `v1.${DIRECT_PUSH_SEALING_KEY_ID}.${Buffer.concat([nonce, sealed]).toString("base64url")}`;
}

/** Undefined for a capability another gateway issued, another key sealed, or anyone altered. */
function openCapability(key: Buffer, capability: string): OpenedCapability | undefined {
  const [version, keyId, sealed, ...rest] = capability.split(".");
  if (version !== "v1" || keyId !== DIRECT_PUSH_SEALING_KEY_ID || sealed === undefined) {
    return undefined;
  }
  if (rest.length > 0) return undefined;
  const bytes = decodeBase64Url(sealed);
  if (bytes === undefined || bytes.length < 12 + 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${CAPABILITY_ASSOCIATED_DATA_PREFIX}${keyId}`));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    const value: unknown = JSON.parse(plain);
    if (typeof value !== "object" || value === null) return undefined;
    const platform = "platform" in value ? value.platform : undefined;
    const token = "token" in value ? value.token : undefined;
    const hostKeyFingerprint = "hostKeyFingerprint" in value ? value.hostKeyFingerprint : undefined;
    if (
      (platform !== "ios" && platform !== "android") ||
      typeof token !== "string" ||
      typeof hostKeyFingerprint !== "string"
    ) {
      return undefined;
    }
    return { platform, token, hostKeyFingerprint };
  } catch {
    return undefined;
  }
}

function decodeBase64Url(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  return Buffer.from(text, "base64url");
}

function signatureHolds(hostKeyDer: Buffer, signedText: string, signature: string): boolean {
  const bytes = decodeBase64Url(signature);
  if (bytes === undefined) return false;
  try {
    return verify(
      "sha256",
      Buffer.from(signedText, "utf8"),
      {
        key: createPublicKey({ key: hostKeyDer, format: "der", type: "spki" }),
        dsaEncoding: "ieee-p1363",
      },
      bytes,
    );
  } catch {
    return false;
  }
}
