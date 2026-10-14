import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { nodeServe } from "../nodeServe";
import { validatePrivateListenerTls } from "../privateListener";
import { certificatePem, encodeListenerCertificate } from "./listenerCertificateDer";
import {
  createSelfMadeListenerCertificateStore,
  listenerTlsPin,
  SELF_MADE_LISTENER_CERTIFICATE_FILE,
  SELF_MADE_LISTENER_KEY_FILE,
} from "./selfMadeListenerCertificate";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-listener-certificate-"));
  directories.push(directory);
  return directory;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const START = new Date("2026-10-14T09:30:15.250Z");

function ready(
  result: ReturnType<ReturnType<typeof createSelfMadeListenerCertificateStore>["ensure"]>,
) {
  if (result.status !== "ready") throw new Error(`expected a certificate, got ${result.code}`);
  return result;
}

describe("listener certificate DER writer", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const notBefore = new Date("2026-10-14T09:30:15.000Z");
  const notAfter = new Date(notBefore.getTime() + 365 * DAY_MS);

  it("writes a self-signed P-256 server certificate the platform X.509 reader accepts", () => {
    const certificate = new X509Certificate(
      encodeListenerCertificate({
        privateKey,
        publicKey,
        hostname: "100.64.0.7",
        notBefore,
        notAfter,
      }),
    );
    expect(certificate.subject).toBe("CN=Octant private listener");
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.ca).toBe(false);
    expect(certificate.verify(publicKey)).toBe(true);
    expect(certificate.checkIssued(certificate)).toBe(true);
    expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(certificate.subjectAltName).toBe("IP Address:100.64.0.7");
    expect(certificate.checkIP("100.64.0.7")).toBe("100.64.0.7");
    expect(Date.parse(certificate.validFrom)).toBe(notBefore.getTime());
    expect(Date.parse(certificate.validTo)).toBe(notAfter.getTime());
    expect(
      certificate.publicKey
        .export({ format: "der", type: "spki" })
        .equals(publicKey.export({ format: "der", type: "spki" })),
    ).toBe(true);
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(certificate.toString()).toContain("BEGIN CERTIFICATE");
  });

  it("gives each certificate a fresh positive serial of at most 128 bits", () => {
    const serials = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const serial = new X509Certificate(
        encodeListenerCertificate({
          privateKey,
          publicKey,
          hostname: "100.64.0.7",
          notBefore,
          notAfter,
        }),
      ).serialNumber;
      expect(serial).toMatch(/^[0-9A-F]+$/);
      expect(BigInt(`0x${serial}`) > 0n).toBe(true);
      expect(BigInt(`0x${serial}`) < 2n ** 128n).toBe(true);
      serials.add(serial);
    }
    expect(serials.size).toBe(32);
  });

  it("names a DNS listener and compressed or IPv4-mapped IPv6 listeners exactly", () => {
    const named = new X509Certificate(
      encodeListenerCertificate({
        privateKey,
        publicKey,
        hostname: "Station.example.ts.net",
        notBefore,
        notAfter,
      }),
    );
    expect(named.subjectAltName).toBe("DNS:station.example.ts.net");
    expect(named.checkHost("station.example.ts.net")).toBe("station.example.ts.net");
    expect(named.checkHost("other.example.ts.net")).toBeUndefined();

    for (const address of ["fd7a:115c:a1e0::7033:4105", "fd00::1", "::ffff:192.168.1.20"]) {
      const certificate = new X509Certificate(
        encodeListenerCertificate({
          privateKey,
          publicKey,
          hostname: address,
          notBefore,
          notAfter,
        }),
      );
      expect(certificate.checkIP(address)).toBe(address);
      expect(certificate.checkIP("fd7a:115c:a1e0::7033:4106")).toBeUndefined();
    }
  });

  it("encodes a certificate ending in 2050 or later with a four-digit year", () => {
    const certificate = new X509Certificate(
      encodeListenerCertificate({
        privateKey,
        publicKey,
        hostname: "100.64.0.7",
        notBefore: new Date("2049-12-31T23:00:00.000Z"),
        notAfter: new Date("2050-12-31T23:00:00.000Z"),
      }),
    );
    expect(Date.parse(certificate.validTo)).toBe(Date.parse("2050-12-31T23:00:00.000Z"));
  });

  it("refuses a key that is not P-256 and a name that is not an address or ASCII DNS name", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      encodeListenerCertificate({ ...rsa, hostname: "100.64.0.7", notBefore, notAfter }),
    ).toThrow();
    expect(() =>
      encodeListenerCertificate({
        privateKey,
        publicKey,
        hostname: "stätion.ts.net",
        notBefore,
        notAfter,
      }),
    ).toThrow();
    for (const hostname of [
      "a..b.ts.net",
      "-station.ts.net",
      "station-.ts.net",
      `${"a".repeat(64)}.ts.net`,
      "station.ts.net.",
      "fe80::1%en0",
      "a\u0000b",
    ]) {
      expect(() =>
        encodeListenerCertificate({ privateKey, publicKey, hostname, notBefore, notAfter }),
      ).toThrow();
    }
  });

  it("passes the listener's own certificate check for the address it names", () => {
    const pem = certificatePem(
      encodeListenerCertificate({
        privateKey,
        publicKey,
        hostname: "100.64.0.7",
        notBefore,
        notAfter,
      }),
    );
    const key = String(privateKey.export({ format: "pem", type: "pkcs8" }));
    const at = () => new Date(notBefore.getTime() + DAY_MS);
    expect(() =>
      validatePrivateListenerTls({ cert: pem, key }, { hostname: "100.64.0.7", now: at }),
    ).not.toThrow();
    expect(() =>
      validatePrivateListenerTls({ cert: pem, key }, { hostname: "100.64.0.8", now: at }),
    ).toThrow();
  });
});

describe("self-made listener certificate", () => {
  it("pins the key as sha256- and the unpadded base64url hash of its SubjectPublicKeyInfo", () => {
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: dataDirectory() });
    const made = ready(store.ensure("100.64.0.7"));
    const spki = createPublicKey(made.tls.key).export({ format: "der", type: "spki" });
    expect(made.tlsPin).toBe(`sha256-${createHash("sha256").update(spki).digest("base64url")}`);
    expect(made.tlsPin).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/);
    expect(listenerTlsPin(made.tls.cert)).toBe(made.tlsPin);
  });

  it("keeps its key and certificate owner-only in an owner-only folder", () => {
    const directory = dataDirectory();
    // The host identity key may have made the folder first with the umask's mode.
    mkdirSync(join(directory, "remote"), { mode: 0o755 });
    chmodSync(join(directory, "remote"), 0o755);
    ready(
      createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure("100.64.0.7"),
    );
    expect(statSync(join(directory, "remote")).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "remote", SELF_MADE_LISTENER_KEY_FILE)).mode & 0o777).toBe(
      0o600,
    );
    expect(
      statSync(join(directory, "remote", SELF_MADE_LISTENER_CERTIFICATE_FILE)).mode & 0o777,
    ).toBe(0o600);
  });

  it("is not the host identity key", () => {
    const directory = dataDirectory();
    const made = ready(
      createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure("100.64.0.7"),
    );
    const key = readFileSync(join(directory, "remote", SELF_MADE_LISTENER_KEY_FILE), "utf8");
    expect(made.tls.key).toBe(key);
    expect(createPrivateKey(key).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("serves the same certificate and pin after a restart", () => {
    const directory = dataDirectory();
    const first = ready(
      createSelfMadeListenerCertificateStore({ dataDirectory: directory, now: () => START }).ensure(
        "100.64.0.7",
      ),
    );
    const later = new Date(START.getTime() + 10 * DAY_MS);
    const second = ready(
      createSelfMadeListenerCertificateStore({ dataDirectory: directory, now: () => later }).ensure(
        "100.64.0.7",
      ),
    );
    expect(second.tls).toEqual(first.tls);
    expect(second.tlsPin).toBe(first.tlsPin);
  });

  it("renews the certificate within 30 days of its end with the same key and pin", () => {
    const directory = dataDirectory();
    let now = START;
    const store = createSelfMadeListenerCertificateStore({
      dataDirectory: directory,
      now: () => now,
    });
    const first = ready(store.ensure("100.64.0.7"));
    const firstEnd = Date.parse(new X509Certificate(first.tls.cert).validTo);

    now = new Date(firstEnd - 31 * DAY_MS);
    expect(ready(store.ensure("100.64.0.7")).tls.cert).toBe(first.tls.cert);

    now = new Date(firstEnd - 29 * DAY_MS);
    const renewed = ready(store.ensure("100.64.0.7"));
    expect(renewed.tls.cert).not.toBe(first.tls.cert);
    expect(renewed.tls.key).toBe(first.tls.key);
    expect(renewed.tlsPin).toBe(first.tlsPin);
    const certificate = new X509Certificate(renewed.tls.cert);
    expect(Date.parse(certificate.validFrom)).toBe(Math.floor(now.getTime() / 1_000) * 1_000);
    expect(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)).toBe(365 * DAY_MS);
    expect(
      readFileSync(join(directory, "remote", SELF_MADE_LISTENER_CERTIFICATE_FILE), "utf8"),
    ).toBe(renewed.tls.cert);

    // An expired certificate, or one whose start is ahead of a corrected clock,
    // is renewed the same way.
    now = new Date(firstEnd + 400 * DAY_MS);
    expect(ready(store.ensure("100.64.0.7")).tlsPin).toBe(first.tlsPin);
    now = new Date(START.getTime() - DAY_MS);
    const backwards = ready(store.ensure("100.64.0.7"));
    expect(backwards.tlsPin).toBe(first.tlsPin);
    expect(Date.parse(new X509Certificate(backwards.tls.cert).validFrom)).toBeLessThanOrEqual(
      now.getTime(),
    );
  });

  it("makes a certificate for a new address with the same key and pin", () => {
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: dataDirectory() });
    const first = ready(store.ensure("100.64.0.7"));
    const moved = ready(store.ensure("station.example.ts.net"));
    expect(moved.tlsPin).toBe(first.tlsPin);
    expect(new X509Certificate(moved.tls.cert).subjectAltName).toBe("DNS:station.example.ts.net");
    const bracketed = ready(store.ensure("[fd7a:115c:a1e0::7033:4105]"));
    expect(bracketed.tlsPin).toBe(first.tlsPin);
    expect(new X509Certificate(bracketed.tls.cert).checkIP("fd7a:115c:a1e0::7033:4105")).toBe(
      "fd7a:115c:a1e0::7033:4105",
    );
  });

  it("replaces a certificate made for another key or damaged on disk, keeping the key", () => {
    const directory = dataDirectory();
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: directory });
    const first = ready(store.ensure("100.64.0.7"));
    const certificatePath = join(directory, "remote", SELF_MADE_LISTENER_CERTIFICATE_FILE);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeFileSync(
      certificatePath,
      certificatePem(
        encodeListenerCertificate({
          ...other,
          hostname: "100.64.0.7",
          notBefore: new Date(Date.now() - DAY_MS),
          notAfter: new Date(Date.now() + 300 * DAY_MS),
        }),
      ),
    );
    expect(ready(store.ensure("100.64.0.7")).tlsPin).toBe(first.tlsPin);
    writeFileSync(certificatePath, "not a certificate");
    expect(ready(store.ensure("100.64.0.7")).tlsPin).toBe(first.tlsPin);
  });

  it("refuses a key other users can read and leaves it untouched", () => {
    const directory = dataDirectory();
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: directory });
    ready(store.ensure("100.64.0.7"));
    const keyPath = join(directory, "remote", SELF_MADE_LISTENER_KEY_FILE);
    const key = readFileSync(keyPath, "utf8");
    for (const mode of [0o644, 0o640, 0o604, 0o620]) {
      chmodSync(keyPath, mode);
      expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "tls-key-exposed" });
      expect(readFileSync(keyPath, "utf8")).toBe(key);
      expect(statSync(keyPath).mode & 0o777).toBe(mode);
    }
  });

  it("refuses a name it cannot certify without making a key or throwing", () => {
    const directory = dataDirectory();
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: directory });
    for (const hostname of ["a\u0000b", "a..b.ts.net", "-station.ts.net", "fe80::1%en0"]) {
      expect(store.ensure(hostname)).toEqual({ status: "refused", code: "invalid-tls" });
    }
    expect(existsSync(join(directory, "remote"))).toBe(false);

    // A certificate already made for the unscoped address does not make a
    // scoped one acceptable.
    ready(store.ensure("fe80::1"));
    expect(store.ensure("fe80::1%en0")).toEqual({ status: "refused", code: "invalid-tls" });
    expect(store.ensure("[fe80::1%en0]")).toEqual({ status: "refused", code: "invalid-tls" });
  });

  it("refuses a FIFO in place of the key without waiting for a writer, and replaces one in place of the certificate", () => {
    const directory = dataDirectory();
    const remote = join(directory, "remote");
    mkdirSync(remote, { mode: 0o700 });
    const keyPath = join(remote, SELF_MADE_LISTENER_KEY_FILE);
    execFileSync("mkfifo", ["-m", "600", keyPath]);
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: directory });
    expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "invalid-tls" });
    expect(statSync(keyPath).isFIFO()).toBe(true);

    rmSync(keyPath);
    const first = ready(store.ensure("100.64.0.7"));
    const certificatePath = join(remote, SELF_MADE_LISTENER_CERTIFICATE_FILE);
    rmSync(certificatePath);
    execFileSync("mkfifo", ["-m", "600", certificatePath]);
    const replaced = ready(store.ensure("100.64.0.7"));
    expect(replaced.tlsPin).toBe(first.tlsPin);
    expect(statSync(certificatePath).isFile()).toBe(true);
  });

  it("makes a new key only in place of an empty owner-only key file", () => {
    const directory = dataDirectory();
    const remote = join(directory, "remote");
    mkdirSync(remote, { mode: 0o700 });
    const keyPath = join(remote, SELF_MADE_LISTENER_KEY_FILE);
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: directory });

    writeFileSync(keyPath, "", { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "tls-key-exposed" });
    expect(readFileSync(keyPath, "utf8")).toBe("");

    chmodSync(keyPath, 0o600);
    const made = ready(store.ensure("100.64.0.7"));
    expect(readFileSync(keyPath, "utf8")).toBe(made.tls.key);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    const truncated = String(made.tls.key).slice(0, 60);
    writeFileSync(keyPath, truncated, { mode: 0o600 });
    expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "invalid-tls" });
    expect(readFileSync(keyPath, "utf8")).toBe(truncated);
  });

  it("writes past a staging file or link a crashed write left behind, without following it", () => {
    const directory = dataDirectory();
    const remote = join(directory, "remote");
    mkdirSync(remote, { mode: 0o700 });
    const elsewhere = join(directory, "elsewhere.txt");
    writeFileSync(elsewhere, "outside");
    symlinkSync(elsewhere, join(remote, `${SELF_MADE_LISTENER_KEY_FILE}.${process.pid}.tmp`));
    writeFileSync(
      join(remote, `${SELF_MADE_LISTENER_CERTIFICATE_FILE}.${process.pid}.tmp`),
      "old",
      {
        mode: 0o644,
      },
    );
    const made = ready(
      createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure("100.64.0.7"),
    );
    expect(readFileSync(elsewhere, "utf8")).toBe("outside");
    expect(readFileSync(join(remote, SELF_MADE_LISTENER_KEY_FILE), "utf8")).toBe(made.tls.key);
    expect(statSync(join(remote, SELF_MADE_LISTENER_CERTIFICATE_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(remote).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a key reached through a link or that is not a P-256 key, and keeps it", () => {
    const directory = dataDirectory();
    const remote = join(directory, "remote");
    mkdirSync(remote, { mode: 0o700 });
    const keyPath = join(remote, SELF_MADE_LISTENER_KEY_FILE);
    const elsewhere = join(directory, "elsewhere.pem");
    writeFileSync(
      elsewhere,
      String(
        generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
      ),
      { mode: 0o600 },
    );
    symlinkSync(elsewhere, keyPath);
    const store = createSelfMadeListenerCertificateStore({ dataDirectory: directory });
    expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "invalid-tls" });

    rmSync(keyPath);
    const rsa = String(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    );
    writeFileSync(keyPath, rsa, { mode: 0o600 });
    expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "invalid-tls" });
    expect(readFileSync(keyPath, "utf8")).toBe(rsa);

    writeFileSync(keyPath, "not a key", { mode: 0o600 });
    expect(store.ensure("100.64.0.7")).toEqual({ status: "refused", code: "invalid-tls" });
    expect(readFileSync(keyPath, "utf8")).toBe("not a key");
  });

  it("completes a TLS handshake with a client that pins its key and refuses one holding another pin", async () => {
    const made = ready(
      createSelfMadeListenerCertificateStore({ dataDirectory: dataDirectory() }).ensure(
        "127.0.0.1",
      ),
    );
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      listenerTrust: "remote",
      tls: made.tls,
      fetch: () => new Response("served"),
    });
    try {
      const port = Number(server.url.port);
      expect(await pinnedRequest(port, made.tlsPin, String(made.tls.cert))).toEqual({
        status: "served",
        pin: made.tlsPin,
      });

      const otherPin = listenerTlsPin(
        certificatePem(
          encodeListenerCertificate({
            ...generateKeyPairSync("ec", { namedCurve: "P-256" }),
            hostname: "127.0.0.1",
            notBefore: new Date(Date.now() - DAY_MS),
            notAfter: new Date(Date.now() + DAY_MS),
          }),
        ),
      );
      expect(await pinnedRequest(port, otherPin, String(made.tls.cert))).toEqual({
        status: "refused-before-sending",
        pin: made.tlsPin,
      });
      // A client that relies on platform trust alone never accepts it.
      await expect(platformTrustHandshake(port)).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  });
});

/**
 * A minimal pinning client. Chain validation stays on, anchored at the
 * certificate under test, and the identity check is the pin: a key whose pin
 * differs fails the handshake, so it never sees a request.
 */
function pinnedRequest(
  port: number,
  pin: string,
  anchor: string,
): Promise<{ readonly status: "served" | "refused-before-sending"; readonly pin: string }> {
  return new Promise((resolve, reject) => {
    let servedPin = "";
    let sent = false;
    const socket: TLSSocket = connect({
      host: "127.0.0.1",
      port,
      ca: anchor,
      checkServerIdentity: (_host, certificate) => {
        servedPin = listenerTlsPin(certificate.raw);
        return servedPin === pin ? undefined : new Error("The served key does not match the pin.");
      },
    });
    let received = "";
    socket.once("secureConnect", () => {
      sent = true;
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.once("end", () =>
      resolve({
        status: received.includes("served") ? "served" : "refused-before-sending",
        pin: servedPin,
      }),
    );
    socket.once("error", (error) => {
      if (!sent && servedPin !== "" && servedPin !== pin) {
        resolve({ status: "refused-before-sending", pin: servedPin });
      } else {
        reject(error);
      }
    });
  });
}

function platformTrustHandshake(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}
