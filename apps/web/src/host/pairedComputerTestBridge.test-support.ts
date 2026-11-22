import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  PLATFORM_LISTENER_TRUST,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
  TICKET_ID,
} from "../../../../packages/client-runtime/src/remoteConnectionFixtures";

export { ORIGIN };

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 64)
    lines.push(base64.slice(index, index + 64));
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

/**
 * A ready session to a fake paired computer. `sent` collects every URL the
 * session sends; `actsAsHostPerson` is what that computer says of this device.
 */
export async function readyPairedBridge(
  sent: URL[],
  options: { readonly actsAsHostPerson?: boolean } = {},
): Promise<RemoteSessionBridge> {
  const server = createFakeRemoteServer({
    handleProductRequest: () =>
      new Response("", { headers: { "content-type": "application/x-ndjson" } }),
    ...(options.actsAsHostPerson === undefined
      ? {}
      : { actsAsHostPerson: options.actsAsHostPerson }),
  });
  const store = createInMemoryDeviceKeyStore();
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = await pemFromPublicKey(keyPair.publicKey);
  const deviceId = "22222222-2222-4222-8222-222222222222";
  server.registerDevice({ deviceId, publicKeyPem: pem, fingerprint: fingerprintFromPem(pem) });
  const hostId = decodeStableHostId(HOST_ID);
  const deviceKeyId = await store.set(keyPair, { origin: ORIGIN, hostId, deviceId });
  const bridge = createRemoteSessionBridge({
    fetch: (input, init) => {
      sent.push(new URL(input instanceof Request ? input.url : String(input)));
      return server.fetch(input, init);
    },
    deviceKeyStore: store,
  });
  bridge.connect({
    ticketId: TICKET_ID,
    hostId,
    deviceId,
    credentialGeneration: 1,
    deviceKeyId,
    origin: ORIGIN,
    hostKeyFingerprint: HOST_KEY_FINGERPRINT,
    listenerTrust: PLATFORM_LISTENER_TRUST,
  });
  const start = Date.now();
  while (bridge.getState().kind !== "ready") {
    if (Date.now() - start > 5_000) throw new Error("The paired session never became ready.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return bridge;
}
