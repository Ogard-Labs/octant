import { describe, expect, it } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  PLATFORM_LISTENER_TRUST,
} from "@octant/client-runtime";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
  TICKET_ID,
} from "../../../../packages/client-runtime/src/remoteConnectionFixtures";
import { createPairedComputerCodeClients } from "./pairedComputerCodeClients";

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 64)
    lines.push(base64.slice(index, index + 64));
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function readyBridge(sent: URL[]) {
  const server = createFakeRemoteServer({
    handleProductRequest: () =>
      new Response("", { headers: { "content-type": "application/x-ndjson" } }),
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

describe("a paired computer's Code clients", () => {
  it("send Code reads over that computer's session and read thread events without waiting", async () => {
    const sent: URL[] = [];
    const clients = createPairedComputerCodeClients(await readyBridge(sent));
    const thread = "a1b2c3d4-0000-4000-8000-000000000001";

    for await (const frame of clients.code.subscribe(
      thread as never,
      4,
      new AbortController().signal,
    )) {
      void frame;
    }

    expect(clients.code.threadEvents).toBe("poll");
    const read = sent.find((url) => url.pathname === `/api/code/threads/${thread}/events`);
    // The read goes to the paired computer's origin over its signed session and
    // asks it not to hold the read open.
    expect(read?.origin).toBe(ORIGIN);
    expect(read?.searchParams.get("wait")).toBe("0");
    expect(read?.searchParams.get("afterSequence")).toBe("4");
  });
});
