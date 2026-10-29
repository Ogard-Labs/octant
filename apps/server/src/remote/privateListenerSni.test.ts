import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTcp, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPinnedHubTransport, type HubNetwork } from "../hub/pinnedHubTransport";
import { nodeServe } from "../nodeServe";
import {
  PrivateListenerError,
  validatePrivateListenerNamedTls,
  type PrivateListenerNamedTls,
  type PrivateListenerTls,
} from "../privateListener";
import {
  createSelfMadeListenerCertificateStore,
  listenerTlsPin,
} from "./selfMadeListenerCertificate";

const TAILNET_NAME = "mini.tail1234.ts.net";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function certificateFor(name: string, now?: () => Date): { tls: PrivateListenerTls; pin: string } {
  const directory = mkdtempSync(join(tmpdir(), "octant-sni-"));
  directories.push(directory);
  const made = createSelfMadeListenerCertificateStore({
    dataDirectory: directory,
    ...(now === undefined ? {} : { now }),
  }).ensure(name);
  if (made.status !== "ready") throw new Error(`expected a certificate for ${name}`);
  return { tls: made.tls, pin: made.tlsPin };
}

interface Handshake {
  readonly pin: string;
  readonly status: number | undefined;
}

/** Connects with the given SNI name (none when undefined) and a Host header, and reads the status line. */
function handshake(port: number, sni: string | undefined, host: string): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false,
      ...(sni === undefined ? {} : { servername: sni }),
    });
    let pin = "";
    let received = "";
    socket.on("secureConnect", () => {
      const raw = socket.getPeerCertificate().raw;
      pin = listenerTlsPin(new X509Certificate(raw));
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(received)?.[1];
      resolve({ pin, status: status === undefined ? undefined : Number(status) });
    });
  });
}

/**
 * A hub transport that reaches the listener on loopback while the origin names
 * the tailnet machine, as a peer host does: the name resolves to a tailnet
 * address, and the connection lands on the test listener.
 */
function pinnedFetchByTailnetName(port: number, pin: string) {
  const network: HubNetwork = {
    resolve: async () => ["100.101.102.103"],
    dial: (_address, dialPort) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connectTcp({ host: "127.0.0.1", port: dialPort });
        socket.once("error", reject);
        socket.once("connect", () => {
          Object.defineProperty(socket, "remoteAddress", { value: "100.101.102.103" });
          resolve(socket);
        });
      }),
  };
  return createPinnedHubTransport(network)({
    origin: `https://${TAILNET_NAME}:${port}`,
    pin,
  });
}

function suite(
  label: string,
  start: (own: PrivateListenerTls, tailnet: PrivateListenerNamedTls) => Promise<number>,
  stop: () => Promise<void>,
) {
  describe(`${label} listener with a tailnet certificate beside the pinned one`, () => {
    const own = certificateFor("127.0.0.1");
    const tailnet = certificateFor(TAILNET_NAME);
    let port = 0;

    beforeAll(async () => {
      port = await start(own.tls, { ...tailnet.tls, serverName: TAILNET_NAME });
    });
    afterAll(stop);

    it("serves the tailnet certificate to a client that asks for this machine's tailnet name", async () => {
      const result = await handshake(port, TAILNET_NAME, `${TAILNET_NAME}:${port}`);

      expect(result.pin).toBe(tailnet.pin);
      expect(result.pin).not.toBe(own.pin);
      expect(result.status).toBe(204);
    });

    it("serves the pinned certificate, with its pin unchanged, to a client that sends no name", async () => {
      const result = await handshake(port, undefined, `127.0.0.1:${port}`);

      expect(result.pin).toBe(own.pin);
      expect(result.status).toBe(204);
    });

    it("serves a pinned client that reaches this machine by its tailnet name the pinned certificate", async () => {
      const response = await pinnedFetchByTailnetName(
        port,
        own.pin,
      )(`https://${TAILNET_NAME}:${port}/`);

      expect(response.status).toBe(204);
    });

    it("still refuses a pinned client whose pin is not the pinned certificate's", async () => {
      await expect(
        pinnedFetchByTailnetName(port, tailnet.pin)(`https://${TAILNET_NAME}:${port}/`),
      ).rejects.toMatchObject({ reason: "pin-mismatch" });
    });

    it("serves the pinned certificate to a client that asks for any other name", async () => {
      expect((await handshake(port, "other.example.com", `127.0.0.1:${port}`)).pin).toBe(own.pin);
      expect((await handshake(port, "evil.tail1234.ts.net", `127.0.0.1:${port}`)).pin).toBe(
        own.pin,
      );
    });

    it("accepts the tailnet name as a Host and nothing broader", async () => {
      expect((await handshake(port, TAILNET_NAME, `${TAILNET_NAME}:${port}`)).status).toBe(204);
      expect((await handshake(port, TAILNET_NAME, `evil.tail1234.ts.net:${port}`)).status).toBe(
        400,
      );
      expect((await handshake(port, TAILNET_NAME, `tail1234.ts.net:${port}`)).status).toBe(400);
    });
  });
}

let nodeServer: Awaited<ReturnType<typeof nodeServe>> | undefined;
suite(
  "Node",
  async (own, tailnet) => {
    nodeServer = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      listenerTrust: "remote",
      fetch: () => new Response(null, { status: 204 }),
      tls: own,
      tailnetTls: tailnet,
    });
    return Number(nodeServer.url.port);
  },
  async () => {
    await nodeServer?.stop(true);
  },
);

let bunChild: ChildProcessWithoutNullStreams | undefined;
const bunDirectories: string[] = [];
suite(
  "Bun",
  async (own, tailnet) => {
    const directory = mkdtempSync(join(tmpdir(), "octant-sni-bun-"));
    bunDirectories.push(directory);
    writeFileSync(join(directory, "own.crt"), String(own.cert));
    writeFileSync(join(directory, "own.key"), String(own.key), { mode: 0o600 });
    writeFileSync(join(directory, "tailnet.crt"), String(tailnet.cert));
    writeFileSync(join(directory, "tailnet.key"), String(tailnet.key), { mode: 0o600 });
    writeFileSync(join(directory, "tailnet.name"), tailnet.serverName);
    const child = spawn("bun", [
      fileURLToPath(new URL("./privateListenerSni.integration-fixture.ts", import.meta.url)),
      directory,
    ]);
    bunChild = child;
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const newline = output.indexOf("\n");
        if (newline !== -1) resolve(output.slice(0, newline).trim());
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Bun fixture exited before ready (${code}).`)));
    });
    return Number(new URL(url).port);
  },
  async () => {
    const child = bunChild;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    }
    for (const directory of bunDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  },
);

describe("the tailnet certificate is checked the way the listener checks its own", () => {
  const refusal = (tls: PrivateListenerNamedTls) => {
    try {
      validatePrivateListenerNamedTls(tls);
    } catch (error) {
      return error instanceof PrivateListenerError ? error.code : "other";
    }
    return "accepted";
  };

  it("accepts a current certificate whose key matches and that covers its tailnet name", () => {
    expect(refusal({ ...certificateFor(TAILNET_NAME).tls, serverName: TAILNET_NAME })).toBe(
      "accepted",
    );
  });

  it("refuses a certificate whose key belongs to another certificate", () => {
    const first = certificateFor(TAILNET_NAME);
    const second = certificateFor(TAILNET_NAME);

    expect(refusal({ cert: first.tls.cert, key: second.tls.key, serverName: TAILNET_NAME })).toBe(
      "invalid-tls",
    );
  });

  it("refuses a certificate that does not parse and an empty one", () => {
    const good = certificateFor(TAILNET_NAME).tls;

    expect(refusal({ cert: "not a certificate", key: good.key, serverName: TAILNET_NAME })).toBe(
      "invalid-tls",
    );
    expect(refusal({ cert: "", key: "", serverName: TAILNET_NAME })).toBe("invalid-tls");
  });

  it("refuses a certificate that has expired", () => {
    const longAgo = certificateFor(TAILNET_NAME, () => new Date("2020-01-01T00:00:00Z")).tls;

    expect(refusal({ ...longAgo, serverName: TAILNET_NAME })).toBe("invalid-tls");
  });

  it("refuses a certificate made for another name, and a name that is not a tailnet name", () => {
    const other = certificateFor("other.tail1234.ts.net").tls;
    const address = certificateFor("100.101.102.103").tls;

    expect(refusal({ ...other, serverName: TAILNET_NAME })).toBe("invalid-tls");
    expect(refusal({ ...address, serverName: "100.101.102.103" })).toBe("invalid-tls");
    expect(refusal({ ...other, serverName: "mini.example.com" })).toBe("invalid-tls");
  });
});
