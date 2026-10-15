import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ListenerTrustRefused } from "@octant/client-runtime/remote-listener-trust";
import { buildHostHelloSignaturePayload, buildPairingCode } from "@octant/domain";
import {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_REFUSED,
  clearRemotePageStorage,
  forgetPairedComputer,
  installPairedComputerIpcHandlers,
  openPairedComputer,
  PAIRED_COMPUTER_CHANNELS,
  pairFromPairingCode,
  PairedComputerPins,
} from "./pairedComputers";
import { IPC_CHANNELS } from "./preload";

const ORIGIN = "https://100.101.102.103:8443";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const TICKET = {
  ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
  ticketProof: Buffer.alloc(32, 7).toString("base64url"),
};
const NOW = Date.parse("2026-10-15T12:00:00.000Z");

let directory: string;
let listenerCert: string;
let otherCert: string;

function selfSignedCertificate(name: string): string {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
    ],
    { stdio: "pipe" },
  );
  return readFileSync(cert, "utf8");
}

function pinOf(certificate: string): string {
  const spki = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" });
  return `sha256-${createHash("sha256").update(spki).digest("base64url")}`;
}

function pairingCode(pin: string, origin = ORIGIN): string {
  const built = buildPairingCode({ origin, ...TICKET, pin });
  if (built.status !== "built") throw new Error(built.reason);
  return built.code;
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "octant-paired-computers-"));
  listenerCert = selfSignedCertificate("listener");
  otherCert = selfSignedCertificate("other");
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function freshPins(): PairedComputerPins {
  return new PairedComputerPins(join(mkdtempSync(join(directory, "pins-")), "pins.json"));
}

function storagePort() {
  return {
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    clearAuthCache: vi.fn(async () => {}),
  };
}

/** A host that verifies itself with a hello signed by its identity key, answering the client's nonce. */
async function hostFetch(): Promise<typeof globalThis.fetch> {
  const hostKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = hostKey.publicKey.export({ format: "der", type: "spki" });
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const facts = {
      productId: "octant",
      hostId: HOST_ID,
      displayName: "Studio Mac",
      hostKeyFingerprint: createHash("sha256").update(spki).digest("hex"),
      serverBuildVersion: "0.1.0",
      supportedProtocolRange: { min: 1, max: 1 },
      authenticationProtocolVersions: [1],
      securityFloor: 1,
      remoteOrigin: ORIGIN,
      nonce: "host-nonce-1234567890",
      clientNonce: url.searchParams.get("clientNonce") ?? "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const signature = sign("sha256", Buffer.from(buildHostHelloSignaturePayload(facts), "utf8"), {
      key: hostKey.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return Response.json({ ...facts, hostPublicKey: spki.toString("base64url"), signature });
  };
}

describe("the pins the desktop keeps for paired computers", () => {
  it("passes only the pinned key for a pinned name, and refuses every other name", () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });

    expect(pins.judgeCertificate("100.101.102.103", listenerCert, NOW)).toBe(CERTIFICATE_ACCEPTED);
    expect(pins.judgeCertificate("100.101.102.103", otherCert, NOW)).toBe(CERTIFICATE_REFUSED);
    expect(pins.judgeCertificate("100.101.102.104", listenerCert, NOW)).toBe(CERTIFICATE_REFUSED);
    expect(pins.judgeCertificate("100.101.102.103", "not a certificate", NOW)).toBe(
      CERTIFICATE_REFUSED,
    );
  });

  it("never pins a public name or address", () => {
    const pins = freshPins();
    for (const origin of ["https://example.com", "https://203.0.113.7:8443"]) {
      expect(() =>
        pins.record({ origin, displayName: "Public", pin: pinOf(listenerCert) }),
      ).toThrow("Octant pins only a private network or Tailscale address.");
    }
    expect(pins.list()).toEqual([]);
  });

  it("keeps the pins owner-only and reads them back after a restart", () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    new PairedComputerPins(path).record({
      origin: ORIGIN,
      displayName: "Studio Mac",
      pin: pinOf(listenerCert),
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new PairedComputerPins(path).pinFor(ORIGIN)).toBe(pinOf(listenerCert));
  });

  it("holds no pins from a damaged file or a record naming a public address", () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    writeFileSync(path, "{not json");
    expect(new PairedComputerPins(path).list()).toEqual([]);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        computers: [{ origin: "https://203.0.113.7", displayName: "x", pin: pinOf(otherCert) }],
      }),
    );
    expect(new PairedComputerPins(path).judgeCertificate("203.0.113.7", otherCert, NOW)).toBe(
      CERTIFICATE_REFUSED,
    );
  });
});

describe("pairing with another computer from its code", () => {
  it("records the pin and opens that computer's pairing page only after its hello verifies", async () => {
    const pins = freshPins();
    const open = vi.fn();
    const fetchFor = vi.fn(await hostFetch().then((fetch) => () => fetch));

    const outcome = await pairFromPairingCode({
      code: pairingCode(pinOf(listenerCert)),
      pins,
      windows: { open, closeAll: vi.fn() },
      webBuildVersion: "0.1.0",
      fetchFor,
    });

    expect(outcome).toEqual({
      status: "opened",
      computer: { origin: ORIGIN, displayName: "Studio Mac" },
    });
    expect(fetchFor).toHaveBeenCalledWith(ORIGIN, {
      current: { kind: "pinned", pin: pinOf(listenerCert) },
    });
    expect(pins.pinFor(ORIGIN)).toBe(pinOf(listenerCert));
    expect(open).toHaveBeenCalledWith({
      origin: ORIGIN,
      url: `${ORIGIN}/#ticketId=${TICKET.ticketId}&ticketProof=${TICKET.ticketProof}`,
    });
  });

  it("records nothing and opens nothing when the computer serves another key", async () => {
    const pins = freshPins();
    const open = vi.fn();

    const outcome = await pairFromPairingCode({
      code: pairingCode(pinOf(listenerCert)),
      pins,
      windows: { open, closeAll: vi.fn() },
      webBuildVersion: "0.1.0",
      fetchFor: () => async () => {
        throw new ListenerTrustRefused("pin-mismatch");
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      message:
        "This isn't the computer you paired with: its security key has changed. Octant stopped before sending anything. If its key was replaced on purpose, pair again from that computer.",
    });
    expect(pins.list()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a tampered or public code without connecting", async () => {
    const fetchFor = vi.fn();
    const pins = freshPins();
    const open = vi.fn();
    const code = pairingCode(pinOf(listenerCert));

    for (const text of [`${code}A`, 42, code.replace("octant-pair-1.", "octant-pair-2.")]) {
      const outcome = await pairFromPairingCode({
        code: text,
        pins,
        windows: { open, closeAll: vi.fn() },
        webBuildVersion: "0.1.0",
        fetchFor,
      });
      expect(outcome.status).toBe("refused");
    }
    expect(fetchFor).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a paired computer again only after its key matches the pin", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const open = vi.fn();

    await expect(
      openPairedComputer({
        origin: ORIGIN,
        pins,
        windows: { open, closeAll: vi.fn() },
        connect: async () => ({ status: "refused", reason: "pin-mismatch" }),
      }),
    ).resolves.toMatchObject({ status: "refused" });
    await expect(
      openPairedComputer({
        origin: "https://100.101.102.104:8443",
        pins,
        windows: { open, closeAll: vi.fn() },
      }),
    ).resolves.toEqual({ status: "refused", message: "Octant isn't paired with that computer." });
    expect(open).not.toHaveBeenCalled();
  });

  it("answers only a trusted local window, on the channels the preload uses", async () => {
    const handlers = new Map<string, (event: unknown, ...args: readonly unknown[]) => unknown>();
    installPairedComputerIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      resolveOwnedWindow: () => {
        throw new Error("not an Octant window");
      },
      pins: freshPins,
      windows: { open: vi.fn(), closeAll: vi.fn() },
      storage: storagePort(),
      webBuildVersion: "0.1.0",
    });

    expect([...handlers.keys()]).toEqual([
      IPC_CHANNELS.pairedComputerPair,
      IPC_CHANNELS.pairedComputerList,
      IPC_CHANNELS.pairedComputerOpen,
      IPC_CHANNELS.pairedComputerForget,
    ]);
    expect(Object.values(PAIRED_COMPUTER_CHANNELS)).toEqual([...handlers.keys()]);
    await expect(
      Promise.resolve().then(() => handlers.get(PAIRED_COMPUTER_CHANNELS.list)?.({})),
    ).rejects.toThrow("Octant rejected an unauthorized paired-computer request.");
  });
});

describe("forgetting a paired computer", () => {
  it("closes its windows, drops its pin so its key is trusted by nothing, and clears its page storage", async () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    const pins = new PairedComputerPins(path);
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const other = "https://100.101.102.104:8443";
    pins.record({ origin: other, displayName: "Laptop", pin: pinOf(otherCert) });
    const storage = storagePort();
    const closeAll = vi.fn();

    const outcome = await forgetPairedComputer({
      origin: ORIGIN,
      pins,
      windows: { open: vi.fn(), closeAll },
      storage,
    });

    expect(outcome).toEqual({ status: "forgotten" });
    expect(closeAll).toHaveBeenCalledWith(ORIGIN);
    expect(pins.judgeCertificate("100.101.102.103", listenerCert, NOW)).toBe(CERTIFICATE_REFUSED);
    expect(new PairedComputerPins(path).list()).toEqual([{ origin: other, displayName: "Laptop" }]);
    expect(storage.clearStorageData).toHaveBeenCalledWith({ origin: ORIGIN });
    expect(storage.clearCache).toHaveBeenCalledOnce();
    expect(storage.clearAuthCache).toHaveBeenCalledOnce();
  });

  it("forgets the pages of that computer's servers too, and says so when they could not be cleared", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const forgetListener = vi.fn().mockResolvedValue({ status: "incomplete" });

    const outcome = await forgetPairedComputer({
      origin: ORIGIN,
      pins,
      windows: { open: vi.fn(), closeAll: vi.fn() },
      storage: storagePort(),
      serverPages: { forgetListener },
    });

    expect(forgetListener).toHaveBeenCalledWith(ORIGIN);
    expect(outcome.status).toBe("refused");
    expect(pins.list()).toEqual([]);
  });

  it("refuses a computer it isn't paired with and touches nothing", async () => {
    const pins = freshPins();
    const storage = storagePort();
    const closeAll = vi.fn();

    for (const origin of [ORIGIN, 42]) {
      await expect(
        forgetPairedComputer({ origin, pins, windows: { open: vi.fn(), closeAll }, storage }),
      ).resolves.toEqual({ status: "refused", message: "Octant isn't paired with that computer." });
    }
    expect(closeAll).not.toHaveBeenCalled();
    expect(storage.clearStorageData).not.toHaveBeenCalled();
  });

  it("still forgets the pin and says so when the page storage cannot be cleared", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const storage = {
      ...storagePort(),
      clearStorageData: vi.fn().mockRejectedValue(new Error("x")),
    };

    const outcome = await forgetPairedComputer({
      origin: ORIGIN,
      pins,
      windows: { open: vi.fn(), closeAll: vi.fn() },
      storage,
    });

    expect(outcome.status).toBe("refused");
    expect(pins.list()).toEqual([]);
  });

  it("attempts every clearing step even when an earlier one fails", async () => {
    const storage = {
      ...storagePort(),
      clearStorageData: vi.fn().mockRejectedValue(new Error("x")),
    };

    await expect(clearRemotePageStorage(storage, ORIGIN)).rejects.toThrow("x");
    expect(storage.clearCache).toHaveBeenCalledOnce();
    expect(storage.clearAuthCache).toHaveBeenCalledOnce();
  });

  it("opens no window for an Open still connecting when the computer is forgotten", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const open = vi.fn();

    const outcome = await openPairedComputer({
      origin: ORIGIN,
      pins,
      windows: { open, closeAll: vi.fn() },
      connect: async () => {
        pins.forget(ORIGIN);
        return { status: "connected", socket: { destroy: vi.fn() } } as never;
      },
    });

    expect(outcome.status).toBe("refused");
    expect(open).not.toHaveBeenCalled();
  });

  it("clears one origin's page storage through the helper any unpair path can call", async () => {
    const storage = storagePort();
    await clearRemotePageStorage(storage, ORIGIN);
    expect(storage.clearStorageData).toHaveBeenCalledWith({ origin: ORIGIN });
  });
});
