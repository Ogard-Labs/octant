import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createInMemoryDeviceKeyStore, createRemoteSessionBridge } from "@octant/client-runtime";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
  TICKET_ID,
} from "../../../../packages/client-runtime/src/remoteConnectionFixtures";
import { RemoteDeviceSelfPanel } from "./RemoteDeviceSelfPanel";

const hostId = decodeStableHostId(HOST_ID);
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function readyBridge(config: Parameters<typeof createFakeRemoteServer>[0] = {}) {
  const server = createFakeRemoteServer(config);
  const pairingStore = createInMemoryDeviceKeyStore();
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = await pemFromPublicKey(keyPair.publicKey);
  server.registerDevice({
    deviceId: DEVICE_ID,
    publicKeyPem: pem,
    fingerprint: fingerprintFromPem(pem),
  });
  const deviceKeyId = await pairingStore.set(keyPair, {
    origin: ORIGIN,
    hostId,
    deviceId: DEVICE_ID,
  });
  await pairingStore.updateMetadata(deviceKeyId, {
    deviceId: DEVICE_ID,
    credentialGeneration: 1,
    hostKeyFingerprint: HOST_KEY_FINGERPRINT,
  });
  const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: pairingStore });
  bridge.connect({
    ticketId: TICKET_ID,
    hostId,
    deviceId: DEVICE_ID,
    credentialGeneration: 1,
    deviceKeyId,
    origin: ORIGIN,
  });
  const start = Date.now();
  while (bridge.getState().kind !== "ready") {
    if (Date.now() - start > 5000) throw new Error("Timed out waiting for ready.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { bridge, server };
}

function renderPanel(bridge: Awaited<ReturnType<typeof readyBridge>>["bridge"]) {
  return render(
    <RemoteDeviceSelfPanel bridge={bridge} onRevoked={vi.fn()} onSignedOut={vi.fn()} />,
  );
}

describe("RemoteDeviceSelfPanel key rotation", () => {
  it("requires explicit confirmation before rotating and can be cancelled", async () => {
    const user = userEvent.setup();
    const { bridge, server } = await readyBridge();
    renderPanel(bridge);
    const originalPem = server.devicePublicKey();

    const rotate = await screen.findByRole("button", { name: "Rotate this device's key" });
    expect(rotate).toHaveAttribute("aria-expanded", "false");
    await user.click(rotate);

    // Naming the button is not enough: nothing may leave the browser until the
    // second, explicit confirmation.
    expect(rotate).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Confirm device key rotation" })).toBeInTheDocument();
    expect(server.devicePublicKey()).toBe(originalPem);

    await user.click(screen.getByRole("button", { name: "Keep current key" }));
    expect(
      screen.queryByRole("group", { name: "Confirm device key rotation" }),
    ).not.toBeInTheDocument();
    expect(server.devicePublicKey()).toBe(originalPem);
    expect(bridge.getState().kind).toBe("ready");
  });

  it("rotates on confirmation and says the session ended", async () => {
    const user = userEvent.setup();
    const { bridge, server } = await readyBridge();
    renderPanel(bridge);
    const originalPem = server.devicePublicKey();

    await user.click(await screen.findByRole("button", { name: "Rotate this device's key" }));
    await user.click(screen.getByRole("button", { name: "Rotate key" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/Device key rotated/);
    // Rotation invalidates the session, so the panel must direct the user to
    // reconnect rather than imply the session continues.
    expect(status).toHaveTextContent(/reconnect this browser/i);
    expect(server.devicePublicKey()).not.toBe(originalPem);
    expect(server.credentialGeneration()).toBe(2);
    await waitFor(() => expect(bridge.getState()).toEqual({ kind: "idle" }));
  });

  it("alerts without claiming success when the host rejects the rotation", async () => {
    const user = userEvent.setup();
    const { bridge, server } = await readyBridge({ rotateKeyStatus: 403 });
    renderPanel(bridge);
    const originalPem = server.devicePublicKey();

    await user.click(await screen.findByRole("button", { name: "Rotate this device's key" }));
    await user.click(screen.getByRole("button", { name: "Rotate key" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/rotation failed/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // The device keeps the key the host still trusts.
    expect(server.devicePublicKey()).toBe(originalPem);
    expect(server.credentialGeneration()).toBe(1);
    expect(bridge.getState().kind).toBe("ready");
  });

  it("keeps the rotate action keyboard operable", async () => {
    const user = userEvent.setup();
    const { bridge, server } = await readyBridge();
    renderPanel(bridge);

    const rotate = await screen.findByRole("button", { name: "Rotate this device's key" });
    rotate.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Rotate key" }));

    await screen.findByRole("status");
    expect(server.credentialGeneration()).toBe(2);
  });

  it("disables device actions while the session is not ready", async () => {
    const { bridge } = await readyBridge();
    renderPanel(bridge);
    await screen.findByRole("button", { name: "Rotate this device's key" });

    bridge.connection()?.disconnect();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rotate this device's key" })).toBeDisabled(),
    );
  });
});
