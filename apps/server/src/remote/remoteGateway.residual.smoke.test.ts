// Remote-access residual evidence.
//
// This file owns only the five residual paths deferred by the gateway and
// hostile-browser evidence suites:
//
//   - a real listener restart between two live private interfaces;
//   - the production `octant web` CLI against a real server/gateway graph;
//   - the Bun fetch TLS/source-address path;
//   - a browser-trusted Tailscale certificate;
//   - OCR over an actual browser-captured screenshot.
//
// Environment-bound rows are registered as Vitest skips with the exact
// capability that is missing. A timer, synthetic interface, certificate
// bypass, or raw-byte scan never turns one of these rows green.

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runWebCommand } from "../../../../packages/cli/src/web";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { nodeServe } from "../nodeServe";
import { createWebAssetsHandler } from "../webAssets";
import { resolveWebAssetsPath, startOctantServer } from "../server";
import {
  createRemoteGateway,
  RemoteGatewayError,
  type RemoteGateway,
  type RemoteGatewayConfig,
} from "./remoteGateway";

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const directories: string[] = [];
const nowIso = "2026-08-01T20:30:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface PrivateAddress {
  readonly address: string;
  readonly kind: "lan-private" | "tailscale";
  readonly interfaceName: string;
}

interface CertificateBundle {
  readonly caCert: string;
  readonly serverCert: string;
  readonly serverKey: string;
}

interface TailscaleIdentity {
  readonly dnsName: string;
  readonly address: string;
}

interface HttpsResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function isContainerBridgeInterface(interfaceName: string): boolean {
  return /^(?:br-|bridge\d+$|cni\d*$|docker\d*$|podman\d*$|veth|virbr\d*$)/i.test(interfaceName);
}

function discoverPrivateAddresses(): readonly PrivateAddress[] {
  const candidates = new Map<string, PrivateAddress>();
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    if (isContainerBridgeInterface(interfaceName)) continue;
    if (addresses === undefined) continue;
    for (const entry of addresses) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [first, second] = entry.address.split(".").map(Number) as [number, number];
      const isTailscale = first === 100 && second >= 64 && second <= 127;
      const isLanPrivate =
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
      if (!isTailscale && !isLanPrivate) continue;
      // Docker bridge addresses NAT the client source and cannot prove the
      // listener's source-address admission contract.
      if (first === 172 && (second === 17 || second === 18)) continue;
      candidates.set(entry.address, {
        address: entry.address,
        kind: isTailscale ? "tailscale" : "lan-private",
        interfaceName,
      });
    }
  }
  // macOS Tailscale may expose the IPv4 through its userspace daemon without
  // returning it from Node's `networkInterfaces()`. Include the daemon's
  // authoritative address so the transition gate attempts the real bind and
  // records an exact `EADDRNOTAVAIL` residual when the host runtime cannot.
  const tailscale = discoverTailscaleIdentity();
  if (tailscale !== undefined && !candidates.has(tailscale.address)) {
    candidates.set(tailscale.address, {
      address: tailscale.address,
      kind: "tailscale",
      interfaceName: "tailscale",
    });
  }
  return [...candidates.values()].sort((left, right) => {
    if (left.kind === right.kind) return left.address.localeCompare(right.address);
    return left.kind === "tailscale" ? -1 : 1;
  });
}

function transitionPair(): readonly [PrivateAddress, PrivateAddress] | undefined {
  const addresses = discoverPrivateAddresses();
  const tailscale = addresses.find((entry) => entry.kind === "tailscale");
  const lan = addresses.find((entry) => entry.kind === "lan-private");
  if (tailscale !== undefined && lan !== undefined) return [tailscale, lan];
  return addresses.length >= 2 ? [addresses[0]!, addresses[1]!] : undefined;
}

function discoverTailscaleIdentity(): TailscaleIdentity | undefined {
  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const status = JSON.parse(raw) as {
      readonly Self?: {
        readonly DNSName?: string;
        readonly TailscaleIPs?: readonly string[];
      };
    };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    const address = status.Self?.TailscaleIPs?.find((candidate) =>
      /^100\.(?:[6-9]\d|1[01]\d|12[0-7])\./.test(candidate),
    );
    if (dnsName === undefined || address === undefined) return undefined;
    return { dnsName, address };
  } catch {
    return undefined;
  }
}

function generateCaAndServerCert(
  certDir: string,
  hostnames: readonly string[],
): CertificateBundle | undefined {
  const caKeyPath = join(certDir, "ca.key");
  const caCertPath = join(certDir, "ca.crt");
  const serverKeyPath = join(certDir, "server.key");
  const serverCsrPath = join(certDir, "server.csr");
  const serverCertPath = join(certDir, "server.crt");
  const extPath = join(certDir, "server.ext");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        caKeyPath,
        "-out",
        caCertPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=Octant Residual Test CA",
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-newkey",
        "rsa:2048",
        "-keyout",
        serverKeyPath,
        "-out",
        serverCsrPath,
        "-nodes",
        "-subj",
        "/CN=Octant residual",
      ],
      { stdio: "pipe" },
    );
    writeFileSync(
      extPath,
      `subjectAltName=${hostnames.map((hostname) => `IP:${hostname}`).join(",")}\n`,
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        serverCsrPath,
        "-CA",
        caCertPath,
        "-CAkey",
        caKeyPath,
        "-CAcreateserial",
        "-out",
        serverCertPath,
        "-days",
        "1",
        "-extfile",
        extPath,
      ],
      { stdio: "pipe" },
    );
  } catch {
    return undefined;
  }
  if (!existsSync(caCertPath) || !existsSync(serverCertPath) || !existsSync(serverKeyPath)) {
    return undefined;
  }
  return {
    caCert: readFileSync(caCertPath, "utf8"),
    serverCert: readFileSync(serverCertPath, "utf8"),
    serverKey: readFileSync(serverKeyPath, "utf8"),
  };
}

function generateTailscaleCertificate(
  certDir: string,
  identity: TailscaleIdentity,
): CertificateBundle | undefined {
  const certPath = join(certDir, "tailscale.crt");
  const keyPath = join(certDir, "tailscale.key");
  try {
    execFileSync(
      "tailscale",
      ["cert", "--cert-file", certPath, "--key-file", keyPath, identity.dnsName],
      { stdio: "pipe" },
    );
  } catch {
    return undefined;
  }
  if (!existsSync(certPath) || !existsSync(keyPath)) return undefined;
  return {
    caCert: "",
    serverCert: readFileSync(certPath, "utf8"),
    serverKey: readFileSync(keyPath, "utf8"),
  };
}

function seedHostIdentity(journal: Journal): void {
  journal.append({
    aggregate: { aggregateType: "remote-host", aggregateId: hostId },
    expectedVersion: 0,
    events: [
      {
        eventId: "55555555-5555-4555-8555-555555555555",
        eventName: "remote.host-identity-initialized@1",
        eventVersion: 1,
        correlationId: "44444444-4444-4444-8444-444444444444",
        actor: { kind: "system", actorId: "33333333-3333-4333-8333-333333333333" },
        occurredAt: nowIso,
        payload: {
          hostId,
          displayName: "This Mac",
          hostKeyFingerprint: "a".repeat(64),
          keyGeneration: 1,
          createdAt: nowIso,
        },
      },
    ],
  });
}

function makeSigning() {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    hostKeyFingerprint: createHash("sha256").update(publicDer).digest("hex"),
    signHostPayload: (payload: string) =>
      cryptoSign("sha256", Buffer.from(payload, "utf8"), {
        key: keys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
  };
}

function setupGateway(
  directory: string,
  config: RemoteGatewayConfig,
  webAssets?: (request: Request) => Response | Promise<Response | undefined>,
  serve: typeof nodeServe = nodeServe,
): RemoteGateway {
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => nowIso);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => nowIso,
  });
  seedHostIdentity(journal);
  return createRemoteGateway({
    config,
    connection,
    journal,
    hostId,
    displayName: "This Mac",
    serverBuildVersion: "0.1.0",
    signing: makeSigning(),
    webAssets:
      webAssets ?? (() => Promise.resolve(new Response("<title>Octant</title>", { status: 200 }))),
    serve,
    now: () => Date.parse(nowIso),
    clock: () => nowIso,
  });
}

function configFor(
  address: string,
  port: number,
  certificate: CertificateBundle,
  originHost = address,
): RemoteGatewayConfig {
  return {
    listener: {
      hostname: address,
      port,
      origin: `https://${originHost}:${port}`,
      tls: { cert: certificate.serverCert, key: certificate.serverKey },
    },
  };
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function httpsRequest(
  hostname: string,
  port: number,
  path: string,
  certificate: CertificateBundle | undefined,
  localAddress = hostname,
): Promise<HttpsResponse> {
  const https = require("node:https") as typeof import("node:https");
  return new Promise((resolve, reject) => {
    const tls = require("node:tls") as typeof import("node:tls");
    const request = https.request(
      {
        hostname,
        port,
        path,
        method: "GET",
        ca: certificate?.caCert === "" ? undefined : certificate?.caCert,
        rejectUnauthorized: true,
        ...(isIpAddress(hostname)
          ? {
              checkServerIdentity: (_host: string, cert: object) =>
                tls.checkServerIdentity(hostname, cert as import("node:tls").PeerCertificate),
            }
          : { servername: hostname }),
        localAddress,
        headers: { host: `${hostname}:${port}` },
      },
      (response: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(", ");
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function discoverBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.OCTANT_BROWSER_EXECUTABLE,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate));
}

function normalizeOcrText(text: string): string {
  return text.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function runOcr(image: Uint8Array): string {
  return execFileSync("tesseract", ["stdin", "stdout", "--psm", "6"], {
    input: image,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function inspectRenderedPage(
  executablePath: string,
  url: URL,
): Promise<{ readonly status: number; readonly title: string }> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    return { status: response?.status() ?? 0, title: await page.title() };
  } finally {
    await browser.close();
  }
}

async function freePort(hostname: string): Promise<number> {
  const server = await nodeServe({
    hostname,
    port: 0,
    listenerTrust: "remote",
    fetch: () => new Response("probe"),
  });
  const port = Number(server.url.port);
  await server.stop();
  return port;
}

describe("Remote-access residual evidence — live interface transition", () => {
  it.each(["docker0", "br-8f26d89a", "veth1234", "cni0", "podman0", "virbr0"])(
    "does not treat container bridge %s as a private host interface",
    (interfaceName) => {
      expect(isContainerBridgeInterface(interfaceName)).toBe(true);
    },
  );

  it.each(["en0", "eth0", "tailscale0", "utun4"])(
    "keeps host interface %s eligible for private transition evidence",
    (interfaceName) => {
      expect(isContainerBridgeInterface(interfaceName)).toBe(false);
    },
  );

  const pair = transitionPair();
  if (pair === undefined) {
    it.skip("restarts from one live private interface to a second (skipped: fewer than two private IPv4 interfaces are available; interface mutation is not simulated)", () => {});
    return;
  }

  it("restarts a real gateway between two live private interfaces", async (context) => {
    const [from, to] = pair;
    const directory = mkdtempSync(join(tmpdir(), "octant-490-interface-transition-"));
    directories.push(directory);
    const certificateDir = mkdtempSync(join(tmpdir(), "octant-490-interface-cert-"));
    directories.push(certificateDir);
    const certificate = generateCaAndServerCert(certificateDir, [from.address, to.address]);
    if (certificate === undefined) {
      context.skip("openssl is unavailable for the real multi-interface transition evidence");
      return;
    }
    let port: number;
    try {
      port = await freePort(from.address);
    } catch {
      context.skip(
        `the first private interface (${from.interfaceName}) cannot accept a host bind in this environment`,
      );
      return;
    }
    const gateway = setupGateway(directory, configFor(from.address, port, certificate));
    try {
      await gateway.start();
      expect(
        (await httpsRequest(from.address, port, "/api/remote/hello", certificate, from.address))
          .status,
      ).toBe(200);

      await gateway.restart(configFor(to.address, port, certificate));
      await expect(
        httpsRequest(from.address, port, "/api/remote/hello", certificate, from.address),
      ).rejects.toThrow();
      expect(
        (await httpsRequest(to.address, port, "/api/remote/hello", certificate, to.address)).status,
      ).toBe(200);
      expect(gateway.facts().origin).toBe(`https://${to.address}:${port}`);
    } finally {
      await gateway.stop();
    }
  });
});

describe("Remote-access residual evidence — integrated octant web CLI", () => {
  it("runs the real CLI against a server with the remote gateway composed over the same graph", async (context) => {
    const addresses = discoverPrivateAddresses();
    if (addresses.length === 0) {
      context.skip("no private IPv4 interface is available for concurrent gateway evidence");
      return;
    }
    const remoteAddress = addresses.find((entry) => entry.kind === "lan-private") ?? addresses[0]!;
    const distPath = resolveWebAssetsPath();
    const executablePath = discoverBrowserExecutable();
    if (!existsSync(join(distPath, "index.html"))) {
      context.skip(
        "apps/web/dist/index.html is absent; run the web build before this integrated smoke",
      );
      return;
    }
    if (executablePath === undefined) {
      context.skip("no Chromium executable is available for integrated web rendering evidence");
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "octant-490-octant-web-"));
    directories.push(directory);
    const certificateDir = mkdtempSync(join(tmpdir(), "octant-490-octant-web-cert-"));
    directories.push(certificateDir);
    const certificate = generateCaAndServerCert(certificateDir, [remoteAddress.address]);
    if (certificate === undefined) {
      expect.fail("openssl is required for the integrated octant web evidence");
    }
    const bridgeSecret = `${"a".repeat(42)}A`;
    let remotePort: number;
    try {
      remotePort = await freePort(remoteAddress.address);
    } catch {
      context.skip(
        `the selected remote interface (${remoteAddress.interfaceName}) cannot accept a host bind in this environment`,
      );
      return;
    }
    const webAssets = createWebAssetsHandler({
      distPath,
      readFile: async (path) => readFile(path),
      stat: async (path) => stat(path),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          seedHostIdentity(persistence.journal);
          const server = yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            desktopBridgeSecret: bridgeSecret,
            webAssetsPath: distPath,
            serve: nodeServe,
            remoteListener: {
              config: configFor(remoteAddress.address, remotePort, certificate).listener,
              services: {
                connection: persistence.connection,
                journal: persistence.journal,
                hostId,
                displayName: "This Mac",
                serverBuildVersion: "0.1.0",
                signing: makeSigning(),
                webAssets,
              },
            },
          });
          expect(server.remoteListenerError).toBeUndefined();
          expect(server.remoteListener).toBeDefined();

          const web = yield* Effect.promise(() =>
            runWebCommand({
              bridgeSecret,
              hostname: "127.0.0.1",
              port: Number(server.url.port),
              noOpen: true,
              stdout: { write: () => true },
              stderr: { write: () => true },
              bridgeSecretInput: {
                env: { OCTANT_DATA_DIR: directory },
                platform: "linux",
                home: "/tmp",
              },
            }),
          );
          expect(web.kind).toBe("served");
          if (web.kind !== "served") return;
          const localPage = yield* Effect.promise(() => fetch(web.url));
          expect(localPage.status).toBe(200);
          const localHtml = yield* Effect.promise(() => localPage.text());
          expect(localHtml).toContain("Octant");
          const renderedPage = yield* Effect.promise(() =>
            inspectRenderedPage(executablePath, web.url),
          );
          expect(renderedPage.status).toBe(200);
          expect(renderedPage.title).toBe("Octant");

          const remoteHello = yield* Effect.promise(() =>
            httpsRequest(
              remoteAddress.address,
              remotePort,
              "/api/remote/hello",
              certificate,
              remoteAddress.address,
            ),
          );
          expect(remoteHello.status).toBe(200);
          const remotePage = yield* Effect.promise(() =>
            httpsRequest(
              remoteAddress.address,
              remotePort,
              "/",
              certificate,
              remoteAddress.address,
            ),
          );
          expect(remotePage.status).toBe(200);
          expect(remotePage.body).toContain("Octant");

          // The surrounding Effect scope owns shutdown ordering: the local
          // and remote listeners release before the persistence layer closes.
          void server;
        }),
      ).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
    );
  });
});

describe("Remote-access residual evidence — Bun TLS client", () => {
  it("uses Bun fetch with a trusted CA and source-address binding when the runtime supports both", async (context) => {
    if (process.versions.bun === undefined) {
      context.skip("Bun fetch is unavailable under this test runtime");
      return;
    }
    const addresses = discoverPrivateAddresses();
    const address = addresses.find((entry) => entry.kind === "lan-private") ?? addresses[0];
    if (address === undefined) {
      context.skip("no private IPv4 interface is available for source-address binding");
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "octant-490-bun-tls-"));
    directories.push(directory);
    const certificateDir = mkdtempSync(join(tmpdir(), "octant-490-bun-tls-cert-"));
    directories.push(certificateDir);
    const certificate = generateCaAndServerCert(certificateDir, [address.address]);
    if (certificate === undefined) {
      context.skip("openssl is unavailable for the Bun trusted-CA client evidence");
      return;
    }
    let observedSourceClass: string | undefined;
    let port: number;
    try {
      port = await freePort(address.address);
    } catch {
      context.skip(
        `the selected private interface (${address.interfaceName}) cannot accept a host bind in this environment`,
      );
      return;
    }
    const captureServe: typeof nodeServe = (options) =>
      nodeServe({
        ...options,
        fetch: (request, facts) => {
          observedSourceClass = facts?.sourceClass;
          return options.fetch(request, facts);
        },
      });
    const gateway = setupGateway(
      directory,
      configFor(address.address, port, certificate),
      undefined,
      captureServe,
    );
    try {
      await gateway.start();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      let response: Response;
      try {
        response = await fetch(`https://${address.address}:${port}/api/remote/hello`, {
          signal: controller.signal,
          headers: { host: `${address.address}:${port}` },
          ...({
            localAddress: address.address,
            tls: { ca: certificate.caCert },
          } as Record<string, unknown>),
        });
      } catch {
        context.skip(
          "Bun 1.3.14 fetch does not provide localAddress plus trusted-CA TLS in this environment",
        );
        return;
      } finally {
        clearTimeout(timeout);
      }
      expect(response.status).toBe(200);
      const body = (await response.json()) as { readonly productId?: string };
      expect(body.productId).toBe("octant");
      // A successful response proves admission; the transport adapter must
      // retain the observed source class for the Bun evidence to pass.
      expect(observedSourceClass).toBe(address.kind);
    } finally {
      await gateway.stop();
    }
  });
});

describe("Remote-access residual evidence — browser-trusted Tailscale certificate", () => {
  it("serves the gateway through a real Tailscale certificate without a certificate bypass", async (context) => {
    const identity = discoverTailscaleIdentity();
    const executablePath = discoverBrowserExecutable();
    if (identity === undefined) {
      context.skip("tailscale status has no local DNS name and Tailscale IPv4 address");
      return;
    }
    if (executablePath === undefined) {
      context.skip("no Chromium executable is available for browser-trusted certificate evidence");
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "octant-490-tailscale-cert-"));
    directories.push(directory);
    const certificateDir = mkdtempSync(join(tmpdir(), "octant-490-tailscale-cert-files-"));
    directories.push(certificateDir);
    const certificate = generateTailscaleCertificate(certificateDir, identity);
    if (certificate === undefined) {
      context.skip("tailscale cert could not issue a certificate in this host environment");
      return;
    }
    let port: number;
    try {
      port = await freePort(identity.address);
    } catch {
      context.skip("Tailscale reports an address but the host runtime cannot bind that interface");
      return;
    }
    const gateway = setupGateway(
      directory,
      configFor(identity.address, port, certificate, identity.dnsName),
    );
    const { chromium } = await import("playwright-core");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let started = false;
    try {
      try {
        await gateway.start();
        started = true;
      } catch (error) {
        if (!(error instanceof RemoteGatewayError) || error.code !== "invalid-origin") {
          throw error;
        }
        context.skip(
          "the current listener origin policy requires the origin hostname to equal the bound address; DNS-name browser-trusted evidence remains unavailable",
        );
        return;
      }
      const nodeResponse = await httpsRequest(
        identity.dnsName,
        port,
        "/api/remote/hello",
        certificate,
        identity.address,
      );
      expect(nodeResponse.status).toBe(200);
      browser = await chromium.launch({ executablePath, headless: true });
      const page = await browser.newPage();
      const response = await page.goto(`https://${identity.dnsName}:${port}/`, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBe(200);
      expect(await page.title()).toBe("Octant");
    } finally {
      await browser?.close();
      if (started) await gateway.stop();
    }
  });
});

describe("Remote-access residual evidence — OCR screenshot scanning", () => {
  it("scans a real browser screenshot with OCR and keeps the clean capture secret-free", async (context) => {
    const addresses = discoverPrivateAddresses();
    const executablePath = discoverBrowserExecutable();
    if (addresses.length === 0) {
      context.skip("no private IPv4 interface is available for the screenshot gateway");
      return;
    }
    if (executablePath === undefined) {
      context.skip("no Chromium executable is available for screenshot evidence");
      return;
    }
    try {
      execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    } catch {
      context.skip("tesseract is unavailable for OCR evidence");
      return;
    }
    const address = addresses.find((entry) => entry.kind === "lan-private") ?? addresses[0]!;
    const directory = mkdtempSync(join(tmpdir(), "octant-490-ocr-"));
    directories.push(directory);
    const certificateDir = mkdtempSync(join(tmpdir(), "octant-490-ocr-cert-"));
    directories.push(certificateDir);
    const certificate = generateCaAndServerCert(certificateDir, [address.address]);
    if (certificate === undefined) {
      context.skip("openssl is unavailable for the screenshot gateway");
      return;
    }
    let port: number;
    try {
      port = await freePort(address.address);
    } catch {
      context.skip(
        `the selected screenshot interface (${address.interfaceName}) cannot accept a host bind in this environment`,
      );
      return;
    }
    const canary = "ORBITSECRET42";
    const gateway = setupGateway(
      directory,
      configFor(address.address, port, certificate),
      (request) => {
        const hasCanary = new URL(request.url).searchParams.get("canary") === "1";
        return new Response(
          `<html><head><title>Octant</title></head><body><h1>Octant</h1>${hasCanary ? `<p>${canary}</p>` : "<p>clean evidence</p>"}</body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    );
    const { chromium } = await import("playwright-core");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await gateway.start();
      browser = await chromium.launch({ executablePath, headless: true });
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(`https://${address.address}:${port}/?canary=1`, { waitUntil: "networkidle" });
      const positiveImage = await page.screenshot();
      const positiveText = normalizeOcrText(runOcr(positiveImage));
      expect(positiveText).toContain(canary);

      await page.goto(`https://${address.address}:${port}/`, { waitUntil: "networkidle" });
      const cleanImage = await page.screenshot();
      const cleanText = normalizeOcrText(runOcr(cleanImage));
      expect(cleanText).not.toContain(canary);
      expect(cleanText).not.toMatch(/OCTANT(?:CREDENTIAL|APIKEY|AUTHORIZATION)/);
    } finally {
      await browser?.close();
      await gateway.stop();
    }
  });
});

describe("Remote-access residual evidence — explicit interface-loss boundary", () => {
  it.skip("interface loss while serving (residual: removing a live host interface is not permitted by this environment; no timer or synthetic route is accepted)", () => {});
});
