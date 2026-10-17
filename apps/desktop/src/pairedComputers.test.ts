import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ListenerTrustRefused } from "@octant/client-runtime/remote-listener-trust";
import { buildHostHelloSignaturePayload, buildPairingCode } from "@octant/domain";
import {
  clearRemotePageStorage,
  forgetPairedComputer,
  installPairedComputerIpcHandlers,
  PAIRED_COMPUTER_CHANNELS,
  pairFromPairingCode,
  PairedComputerPins,
  settlePairedComputer,
  STAGED_PIN_MS,
} from "./pairedComputers";
import { requestPairedComputer } from "./pairedComputerRequests";
import { IPC_CHANNELS } from "./preload";

const ORIGIN = "https://100.101.102.103:8443";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const TICKET = {
  ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
  ticketProof: Buffer.alloc(32, 7).toString("base64url"),
};

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
    expect(new PairedComputerPins(path).pinFor("https://203.0.113.7")).toBeUndefined();
  });
});

describe("pairing with another computer from its code", () => {
  it("stages the pin and hands back the ticket only after its hello verifies", async () => {
    const pins = freshPins();
    const fetchFor = vi.fn(await hostFetch().then((fetch) => () => fetch));

    const outcome = await pairFromPairingCode({
      code: pairingCode(pinOf(listenerCert)),
      pins,
      webBuildVersion: "0.1.0",
      fetchFor,
    });

    expect(outcome).toEqual({
      status: "verified",
      computer: { origin: ORIGIN, displayName: "Studio Mac" },
      ticket: TICKET,
      pin: pinOf(listenerCert),
    });
    expect(fetchFor).toHaveBeenCalledWith(ORIGIN, {
      current: { kind: "pinned", pin: pinOf(listenerCert) },
    });
    // Staged, not recorded: nothing persists until the other computer approves.
    expect(pins.pinFor(ORIGIN)).toBeUndefined();
    expect(pins.list()).toEqual([]);
    expect(pins.reachPinFor(ORIGIN, true)).toBe(pinOf(listenerCert));
  });

  it("records nothing when the computer serves another key", async () => {
    const pins = freshPins();

    const outcome = await pairFromPairingCode({
      code: pairingCode(pinOf(listenerCert)),
      pins,
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
  });

  it("refuses a tampered or public code without connecting", async () => {
    const fetchFor = vi.fn();
    const pins = freshPins();
    const code = pairingCode(pinOf(listenerCert));

    for (const text of [`${code}A`, 42, code.replace("octant-pair-1.", "octant-pair-2.")]) {
      const outcome = await pairFromPairingCode({
        code: text,
        pins,
        webBuildVersion: "0.1.0",
        fetchFor,
      });
      expect(outcome.status).toBe("refused");
    }
    expect(fetchFor).not.toHaveBeenCalled();
    expect(pins.list()).toEqual([]);
  });

  it("answers only a trusted local window, on the channels the preload uses", async () => {
    const handlers = new Map<string, (event: unknown, ...args: readonly unknown[]) => unknown>();
    installPairedComputerIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      resolveOwnedWindow: () => {
        throw new Error("not an Octant window");
      },
      pins: freshPins,
      webBuildVersion: "0.1.0",
    });

    expect([...handlers.keys()]).toEqual([
      IPC_CHANNELS.pairedComputerPair,
      IPC_CHANNELS.pairedComputerList,
      IPC_CHANNELS.pairedComputerForget,
      IPC_CHANNELS.pairedComputerSettle,
      IPC_CHANNELS.pairedComputerRequest,
    ]);
    expect(Object.values(PAIRED_COMPUTER_CHANNELS)).toEqual([...handlers.keys()]);
    for (const channel of handlers.keys()) {
      await expect(
        Promise.resolve().then(() => handlers.get(channel)?.({}, "octant-pair-1.x")),
      ).rejects.toThrow("Octant rejected an unauthorized paired-computer request.");
    }
  });
});

describe("settling a pairing", () => {
  const pairing = async (pins: PairedComputerPins, certificate: string) =>
    pairFromPairingCode({
      code: pairingCode(pinOf(certificate)),
      pins,
      webBuildVersion: "0.1.0",
      fetchFor: await hostFetch().then((fetch) => () => fetch),
    });

  it("records the pin only when the other computer approved, and keeps it after a restart", async () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    const pins = new PairedComputerPins(path);
    await pairing(pins, listenerCert);
    expect(new PairedComputerPins(path).list()).toEqual([]);

    expect(settlePairedComputer({ origin: ORIGIN, outcome: "approved", pins })).toEqual({
      status: "settled",
    });

    expect(new PairedComputerPins(path).pinFor(ORIGIN)).toBe(pinOf(listenerCert));
  });

  it("drops an abandoned pairing and leaves nothing recorded", async () => {
    const pins = freshPins();
    await pairing(pins, listenerCert);

    expect(settlePairedComputer({ origin: ORIGIN, outcome: "abandoned", pins }).status).toBe(
      "settled",
    );

    expect(pins.reachPinFor(ORIGIN, true)).toBeUndefined();
    expect(pins.list()).toEqual([]);
  });

  it("leaves a completed pairing alone when a fresh code for the same computer is abandoned", async () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    const pins = new PairedComputerPins(path);
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });

    await pairing(pins, otherCert);
    // While the second pairing is open, only its own routes use the new pin.
    expect(pins.reachPinFor(ORIGIN, true)).toBe(pinOf(otherCert));
    expect(pins.reachPinFor(ORIGIN, false)).toBe(pinOf(listenerCert));
    settlePairedComputer({ origin: ORIGIN, outcome: "abandoned", pins });

    expect(pins.pinFor(ORIGIN)).toBe(pinOf(listenerCert));
    expect(pins.reachPinFor(ORIGIN, true)).toBe(pinOf(listenerCert));
    expect(new PairedComputerPins(path).pinFor(ORIGIN)).toBe(pinOf(listenerCert));
    await expect(forgetPairedComputer({ origin: ORIGIN, pins })).resolves.toEqual({
      status: "forgotten",
    });
  });

  it("replaces the recorded pin when the fresh code is approved", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });

    await pairing(pins, otherCert);
    settlePairedComputer({ origin: ORIGIN, outcome: "approved", pins });

    expect(pins.pinFor(ORIGIN)).toBe(pinOf(otherCert));
  });

  it("lets a pairing that was never settled lapse, and refuses to approve one that lapsed", async () => {
    let now = 1_000_000;
    const pins = new PairedComputerPins(
      join(mkdtempSync(join(directory, "pins-")), "pins.json"),
      () => now,
    );
    await pairing(pins, listenerCert);
    now += STAGED_PIN_MS + 1;

    expect(pins.reachPinFor(ORIGIN, true)).toBeUndefined();
    expect(settlePairedComputer({ origin: ORIGIN, outcome: "approved", pins }).status).toBe(
      "refused",
    );
    expect(pins.list()).toEqual([]);
  });

  it("refuses approval when no pairing is open, and an outcome it does not know", () => {
    const pins = freshPins();
    expect(settlePairedComputer({ origin: ORIGIN, outcome: "approved", pins }).status).toBe(
      "refused",
    );
    expect(settlePairedComputer({ origin: ORIGIN, outcome: "forgotten", pins }).status).toBe(
      "refused",
    );
    expect(settlePairedComputer({ origin: 42, outcome: "approved", pins }).status).toBe("refused");
  });

  it("forgetting a computer also drops a pairing open for it", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    await pairing(pins, otherCert);

    await forgetPairedComputer({ origin: ORIGIN, pins });

    expect(pins.reachPinFor(ORIGIN, true)).toBeUndefined();
  });
});

describe("forgetting a paired computer", () => {
  it("drops its pin so nothing can reach it, and keeps the pins of other computers", async () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    const pins = new PairedComputerPins(path);
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const other = "https://100.101.102.104:8443";
    pins.record({ origin: other, displayName: "Laptop", pin: pinOf(otherCert) });

    const outcome = await forgetPairedComputer({ origin: ORIGIN, pins });

    expect(outcome).toEqual({ status: "forgotten" });
    expect(new PairedComputerPins(path).list()).toEqual([{ origin: other, displayName: "Laptop" }]);
    await expect(
      requestPairedComputer({
        request: { origin: ORIGIN, method: "GET", path: "/api/remote/hello" },
        pins,
        fetchFor: () => {
          throw new Error("a forgotten computer must not be dialled");
        },
      }),
    ).resolves.toEqual({ status: "refused", message: "Octant isn't paired with that computer." });
  });

  it("forgets the pages of that computer's servers too", async () => {
    const pins = freshPins();
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });
    const forgetListener = vi.fn().mockResolvedValue({ status: "forgotten" });

    const outcome = await forgetPairedComputer({
      origin: ORIGIN,
      pins,
      serverPages: { forgetListener },
    });

    expect(forgetListener).toHaveBeenCalledWith(ORIGIN);
    expect(outcome).toEqual({ status: "forgotten" });
  });

  it("forgets the computer and says so when its server pages could not be cleared", async () => {
    for (const forgetListener of [
      vi.fn().mockResolvedValue({ status: "incomplete" }),
      vi.fn().mockRejectedValue(new Error("x")),
    ]) {
      const pins = freshPins();
      pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: pinOf(listenerCert) });

      const outcome = await forgetPairedComputer({
        origin: ORIGIN,
        pins,
        serverPages: { forgetListener },
      });

      expect(outcome.status).toBe("forgotten");
      expect(outcome).toHaveProperty("warning");
      expect(pins.list()).toEqual([]);
    }
  });

  it("refuses a computer it isn't paired with and touches nothing", async () => {
    const pins = freshPins();
    const forgetListener = vi.fn();

    for (const origin of [ORIGIN, 42]) {
      await expect(
        forgetPairedComputer({ origin, pins, serverPages: { forgetListener } }),
      ).resolves.toEqual({ status: "refused", message: "Octant isn't paired with that computer." });
    }
    expect(forgetListener).not.toHaveBeenCalled();
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

  it("clears one origin's page storage through the helper any unpair path can call", async () => {
    const storage = storagePort();
    await clearRemotePageStorage(storage, ORIGIN);
    expect(storage.clearStorageData).toHaveBeenCalledWith({ origin: ORIGIN });
  });
});
