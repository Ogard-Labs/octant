import type { KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeRemotePushEnvelopeV1, type RemotePushEnvelopeV1 } from "@octant/contracts";
import { sealPushNotification } from "./pushNotificationSealing";
import {
  openSealedPushNotification,
  phoneNotificationKeys as phone,
  referenceOpen,
  x25519PrivateFromRaw,
} from "./pushNotificationSealing.test-support";

const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const threadId = "00000000-0000-4000-8000-000000000001";
const collapseKey = Buffer.alloc(32, 7).toString("base64url");
const content = {
  kind: "approval-needed",
  hostId,
  threadId,
  mode: "code",
  title: "Approval needed: Acme rollback",
  body: "On Studio Mac",
} as const;

function openEnvelope(
  envelope: RemotePushEnvelopeV1,
  recipient: KeyObject,
  binding: { readonly hostId: string; readonly deviceId: string } = { hostId, deviceId },
): unknown {
  return openSealedPushNotification({ envelope, recipient, ...binding });
}

describe("sealed push notifications", () => {
  it("uses a reference opener that opens the published RFC 9180 vector for this suite", () => {
    // RFC 9180 test vectors (CFRG test-vectors.json): mode 0, KEM 0x0020,
    // KDF 0x0001, AEAD 0x0002, first encryption.
    const opened = referenceOpen({
      recipient: x25519PrivateFromRaw(
        Buffer.from("497b4502664cfea5d5af0b39934dac72242a74f8480451e1aee7d6a53320333d", "hex"),
      ),
      enc: Buffer.from("6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256", "hex"),
      info: Buffer.from("4f6465206f6e2061204772656369616e2055726e", "hex"),
      aad: Buffer.from("436f756e742d30", "hex"),
      ciphertext: Buffer.from(
        "e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a",
        "hex",
      ),
    });
    expect(opened.toString("hex")).toBe(
      "4265617574792069732074727574682c20747275746820626561757479",
    );
  });

  it("opens only with the key of the phone it was sealed to, for that host and device", () => {
    const device = phone();
    const sealed = sealPushNotification({
      hostId,
      deviceId,
      notificationPublicKey: device.publicKey,
      collapseKey,
      threadId,
      kind: "approval-needed",
      content,
    });
    expect(sealed.status).toBe("sealed");
    if (sealed.status !== "sealed") return;

    expect(openEnvelope(sealed.envelope, device.privateKey)).toEqual(content);
    expect(() => openEnvelope(sealed.envelope, phone().privateKey)).toThrow();
    expect(() =>
      openEnvelope(sealed.envelope, device.privateKey, {
        hostId,
        deviceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toThrow();
    expect(() =>
      openEnvelope(sealed.envelope, device.privateKey, {
        hostId: "44444444-4444-4444-8444-444444444444",
        deviceId,
      }),
    ).toThrow();
  });

  it("puts nothing in the envelope but the placeholder, a keyed collapse id, the urgency, and sealed bytes", () => {
    const device = phone();
    const sealed = sealPushNotification({
      hostId,
      deviceId,
      notificationPublicKey: device.publicKey,
      collapseKey,
      threadId,
      kind: "approval-needed",
      content,
    });
    if (sealed.status !== "sealed") throw new Error("expected a sealed envelope");
    expect(decodeRemotePushEnvelopeV1(sealed.envelope)).toEqual(sealed.envelope);
    expect(sealed.envelope.alert).toEqual({
      title: "Octant",
      body: "A paired computer has an update",
    });
    expect(sealed.envelope.urgency).toBe("high");
    // Only the visible fields are searched: random base64url can spell any short word.
    const { sealed: opaque, ...visible } = sealed.envelope;
    expect(Object.keys(opaque).sort()).toEqual(["ciphertext", "encapsulatedKey"]);
    const wire = JSON.stringify(visible);
    for (const revealing of [hostId, deviceId, threadId, "Acme", "Studio", "approval", "code"]) {
      expect(wire).not.toContain(revealing);
    }
    // The ciphertext is not the content in another encoding.
    expect(
      Buffer.from(sealed.envelope.sealed.ciphertext, "base64url").toString("utf8"),
    ).not.toContain("Acme");
  });

  it("seals every notification to the same size, so its length names no kind or title", () => {
    const device = phone();
    const sizeOf = (sealedContent: Record<string, string>) => {
      const sealed = sealPushNotification({
        hostId,
        deviceId,
        notificationPublicKey: device.publicKey,
        collapseKey,
        threadId,
        kind: "completion",
        content: sealedContent,
      });
      if (sealed.status !== "sealed") throw new Error("expected a sealed envelope");
      expect(openEnvelope(sealed.envelope, device.privateKey)).toEqual(sealedContent);
      return sealed.envelope.sealed.ciphertext.length;
    };
    const sizes = [
      sizeOf({ ...content, kind: "approval-needed", title: "Approval needed" }),
      sizeOf({ ...content, kind: "waiting", title: "Waiting for you" }),
      sizeOf({ ...content, kind: "failure", title: "Thread failed" }),
      sizeOf({ ...content, kind: "completion", title: "Thread completed: a longer title" }),
    ];
    expect(new Set(sizes).size).toBe(1);
  });

  it("derives the collapse id per destination and thread with the destination's own key", () => {
    const device = phone();
    const collapseOf = (overrides: { threadId?: string; collapseKey?: string }) => {
      const sealed = sealPushNotification({
        hostId,
        deviceId,
        notificationPublicKey: device.publicKey,
        collapseKey: overrides.collapseKey ?? collapseKey,
        threadId: overrides.threadId ?? threadId,
        kind: "completion",
        content: { ...content, kind: "completion" },
      });
      if (sealed.status !== "sealed") throw new Error("expected a sealed envelope");
      return sealed.envelope.collapseId;
    };
    expect(collapseOf({})).toBe(collapseOf({}));
    expect(collapseOf({})).not.toBe(
      collapseOf({ threadId: "00000000-0000-4000-8000-000000000002" }),
    );
    expect(collapseOf({})).not.toBe(
      collapseOf({ collapseKey: Buffer.alloc(32, 9).toString("base64url") }),
    );
    expect(collapseOf({})).not.toContain(threadId);
  });

  it("refuses a key that is not a usable X25519 public key and content over the sealed bound", () => {
    const device = phone();
    const base = {
      hostId,
      deviceId,
      collapseKey,
      threadId,
      kind: "waiting" as const,
      content,
    };
    // The all-zero point gives an all-zero shared secret, which RFC 9180 refuses.
    expect(
      sealPushNotification({
        ...base,
        notificationPublicKey: Buffer.alloc(32).toString("base64url"),
      }),
    ).toEqual({ status: "refused", reason: "unusable-key" });
    expect(sealPushNotification({ ...base, notificationPublicKey: "short" })).toEqual({
      status: "refused",
      reason: "unusable-key",
    });
    expect(
      sealPushNotification({
        ...base,
        notificationPublicKey: device.publicKey,
        content: { ...content, body: "x".repeat(4_096) },
      }),
    ).toEqual({ status: "refused", reason: "too-large" });
  });
});
