import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteServerHostRequest } from "@octant/client-runtime/remote-server-forwarder";
import type { ListenerOriginTrust } from "@octant/client-runtime/remote-listener-trust";
import {
  createRemoteServerPages,
  decodeRemoteServerSigning,
  pageAccessHeader,
  pageNavigation,
  readRecordedForwarderPort,
  recordForwarderPort,
  sendThroughListener,
  upgradeThroughListener,
  validateRemoteServerPageOpenRequest,
  type RemoteServerPageRecord,
  type RemoteServerPages,
  type RemoteServerPagesPorts,
} from "./remoteServerPages";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const LISTENER = "https://192.168.1.20:9443";
const GRANT_ID = `rsg_${"ab".repeat(32)}`;
const OPEN = {
  hostId: HOST_ID,
  hostName: "Studio Mac",
  listenerOrigin: LISTENER,
  grant: { grantId: GRANT_ID, threadId: "77777777-7777-4777-8777-777777777777", port: 5173 },
  mode: "octant-browser",
} as const;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePorts(count: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = 40_000 + Math.floor(Math.random() * 20_000);
    const held: ReturnType<typeof createTcpServer>[] = [];
    let free = true;
    for (let offset = 0; offset < count && free; offset += 1) {
      const server = createTcpServer();
      free = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen({ port: first + offset, host: "127.0.0.1", exclusive: true }, () =>
          resolve(true),
        );
      });
      if (free) held.push(server);
    }
    await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
    if (free) return first;
  }
  throw new Error("No free ports.");
}

interface Harness {
  readonly pages: RemoteServerPages;
  readonly shown: Array<{ readonly name: string; readonly pageOrigin: string }>;
  readonly external: string[];
  readonly asked: Array<{ readonly windowId: number; readonly requestId: string }>;
  readonly sent: RemoteServerHostRequest[];
  readonly recorded: number[];
  readonly pageRecords: RemoteServerPageRecord[];
  readonly events: string[];
  readonly failClearing: Set<string>;
  /** The origins the desktop holds a pin for. */
  readonly pairedOrigins: Set<string>;
  /** The trust each relayed request was held to. */
  readonly trusts: ListenerOriginTrust[];
}

async function harness(overrides: Partial<RemoteServerPagesPorts> = {}): Promise<Harness> {
  const first = await freePorts(3);
  const shown: Harness["shown"] = [];
  const external: string[] = [];
  const asked: Harness["asked"] = [];
  const sent: RemoteServerHostRequest[] = [];
  const recorded: number[] = [];
  const pageRecords: RemoteServerPageRecord[] = [];
  const events: string[] = [];
  const failClearing = new Set<string>();
  const pairedOrigins = new Set([LISTENER, "https://192.168.1.21:9443"]);
  const trusts: ListenerOriginTrust[] = [];
  const pages = createRemoteServerPages({
    readPageRecords: async () => [...pageRecords],
    writePageRecords: async (next) => {
      pageRecords.splice(0, pageRecords.length, ...next);
    },
    closePageWindow: (name) => events.push(`close ${name}`),
    pageStorage: (name) => ({
      clearStorageData: async () => {
        if (failClearing.has(name)) throw new Error("busy");
        events.push(`clear ${name}`);
      },
      clearCache: async () => undefined,
      clearAuthCache: async () => undefined,
    }),
    readRecordedPort: async () => undefined,
    recordPort: async (port) => {
      recorded.push(port);
    },
    askWindowToSign: (windowId, requestId) => {
      asked.push({ windowId, requestId });
      return true;
    },
    showInOctantBrowser: (page) => shown.push(page),
    openExternal: async (url) => {
      external.push(url);
    },
    pairedTrust: (origin) =>
      pairedOrigins.has(origin) ? { current: { kind: "pinned", pin: "sha256-paired" } } : undefined,
    sendToHost: async (target, request) => {
      trusts.push(target.trust);
      sent.push(request);
      return new Response("relayed page", { headers: { "x-octant-server-proxy": "relayed" } });
    },
    forwarderPorts: { first, count: 3 },
    forwarderAddresses: ["127.0.0.1"],
    signTimeoutMs: 2_000,
    ...overrides,
  });
  cleanups.push(() => pages.stop());
  return {
    pages,
    shown,
    external,
    asked,
    sent,
    recorded,
    pageRecords,
    events,
    failClearing,
    pairedOrigins,
    trusts,
  };
}

function pageRequest(
  pageOrigin: string,
  access: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(pageOrigin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        path: "/",
        headers: { host: url.host, "x-octant-page-access": access },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out.");
}

describe("what a window may ask the desktop to open", () => {
  it("accepts a granted server on a paired host's HTTPS listener", () => {
    expect(validateRemoteServerPageOpenRequest(OPEN).grant.port).toBe(5173);
  });

  it("refuses a listener that is not exactly an HTTPS origin, a malformed grant, or an unknown mode", () => {
    for (const bad of [
      { ...OPEN, listenerOrigin: "http://192.168.1.20:9443" },
      { ...OPEN, listenerOrigin: `${LISTENER}/api` },
      { ...OPEN, grant: { ...OPEN.grant, grantId: "rsg_short" } },
      { ...OPEN, grant: { ...OPEN.grant, url: "http://127.0.0.1:5173" } },
      { ...OPEN, mode: "agent-browser" },
      { ...OPEN, hostId: "../../etc" },
    ]) {
      expect(() => validateRemoteServerPageOpenRequest(bad)).toThrow(
        "Octant rejected an invalid request to open a server.",
      );
    }
  });
});

describe("opening a page of another computer", () => {
  it("shows it in Octant's browser at its own name and records the forwarder's port", async () => {
    const { pages, shown, recorded } = await harness();
    expect(await pages.open(7, validateRemoteServerPageOpenRequest(OPEN))).toEqual({
      kind: "opened",
    });
    const page = shown[0];
    expect(page?.pageOrigin).toMatch(/^http:\/\/5173-[a-z2-7]{16}\.octant\.localhost:\d+$/);
    expect(recorded).toEqual([Number(new URL(page?.pageOrigin ?? "http://x:1").port)]);
  });

  it("opens the default browser on the one-time claim address", async () => {
    const { pages, external, shown } = await harness();
    await pages.open(7, validateRemoteServerPageOpenRequest({ ...OPEN, mode: "default-browser" }));
    expect(shown).toEqual([]);
    expect(external[0]).toMatch(
      /^http:\/\/5173-[a-z2-7]{16}\.octant\.localhost:\d+\/\.octant\/claim#[A-Za-z0-9_-]{43}$/,
    );
  });

  it("refuses Open with the port range in its words when every forwarder port is taken", async () => {
    const first = await freePorts(2);
    const blockers = await Promise.all(
      [first, first + 1].map(
        (port) =>
          new Promise<ReturnType<typeof createTcpServer>>((resolve) => {
            const server = createTcpServer();
            server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(server));
          }),
      ),
    );
    cleanups.push(async () => {
      await Promise.all(blockers.map((server) => new Promise((resolve) => server.close(resolve))));
    });
    const { pages, shown } = await harness({ forwarderPorts: { first, count: 2 } });
    expect(await pages.open(7, validateRemoteServerPageOpenRequest(OPEN))).toEqual({
      kind: "refused",
      message: `Octant can't open pages here: its local ports ${String(first)}–${String(first + 1)} are in use.`,
    });
    expect(shown).toEqual([]);
  });

  it("says once that pages start with empty storage when the recorded port was taken", async () => {
    const first = await freePorts(3);
    const blocker = createTcpServer();
    await new Promise<void>((resolve) =>
      blocker.listen({ port: first, host: "127.0.0.1", exclusive: true }, () => resolve()),
    );
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const { pages } = await harness({
      readRecordedPort: async () => first,
      forwarderPorts: { first, count: 3 },
    });
    const opened = await pages.open(7, validateRemoteServerPageOpenRequest(OPEN));
    expect(opened).toEqual({
      kind: "opened",
      notice: "Octant moved its local port, so pages opened before start with empty storage.",
    });
    expect(await pages.open(7, validateRemoteServerPageOpenRequest(OPEN))).toEqual({
      kind: "opened",
    });
  });
});

describe("forgetting a host's pages", () => {
  const OTHER_HOST = "22222222-2222-4222-8222-222222222222";
  const OTHER_LISTENER = "https://192.168.1.21:9443";

  async function openBoth(h: Awaited<ReturnType<typeof harness>>) {
    await h.pages.open(7, validateRemoteServerPageOpenRequest(OPEN));
    await h.pages.open(
      7,
      validateRemoteServerPageOpenRequest({
        ...OPEN,
        hostId: OTHER_HOST,
        listenerOrigin: OTHER_LISTENER,
        grant: { ...OPEN.grant, port: 3000 },
      }),
    );
  }

  it("closes the host's windows, then clears its partitions and forgets their names, leaving other hosts alone", async () => {
    const h = await harness();
    await openBoth(h);
    const [mine, theirs] = h.shown.map((page) => page.name);
    h.events.length = 0;

    expect(await h.pages.forgetHost(HOST_ID)).toEqual({ status: "forgotten" });

    expect(h.events).toEqual([`close ${mine}`, `clear ${mine}`]);
    expect(h.pageRecords.map((record) => record.name)).toEqual([theirs]);
    // The forwarder no longer serves the forgotten name.
    const page = h.shown[0];
    expect((await pageRequest(page?.pageOrigin ?? "", "x")).status).not.toBe(200);
  });

  it("clears partitions a past launch left, which this launch never opened", async () => {
    const h = await harness();
    h.pageRecords.push({ name: "old-page", hostId: HOST_ID, listenerOrigin: LISTENER });

    await h.pages.forgetHost(HOST_ID);

    expect(h.events).toEqual(["close old-page", "clear old-page"]);
    expect(h.pageRecords).toEqual([]);
  });

  it("forgets every page of one listener when a paired computer is forgotten", async () => {
    const h = await harness();
    await openBoth(h);
    const theirs = h.shown[1]?.name;
    h.events.length = 0;

    expect(await h.pages.forgetListener(LISTENER)).toEqual({ status: "forgotten" });

    expect(h.pageRecords.map((record) => record.name)).toEqual([theirs]);
  });

  it("keeps a name whose storage could not be cleared so a later forget retries it", async () => {
    const h = await harness();
    await openBoth(h);
    const mine = h.shown[0]?.name ?? "";
    h.failClearing.add(mine);

    const outcome = await h.pages.forgetHost(HOST_ID);

    expect(outcome.status).toBe("incomplete");
    expect(h.pageRecords.map((record) => record.name)).toContain(mine);

    h.failClearing.clear();
    expect(await h.pages.forgetHost(HOST_ID)).toEqual({ status: "forgotten" });
    expect(h.pageRecords.map((record) => record.name)).not.toContain(mine);
  });

  it("follows a host paired again at another address, so forgetting the new address clears the page", async () => {
    const h = await harness();
    await h.pages.open(7, validateRemoteServerPageOpenRequest(OPEN));
    await h.pages.open(
      7,
      validateRemoteServerPageOpenRequest({ ...OPEN, listenerOrigin: OTHER_LISTENER }),
    );

    expect(h.pageRecords.map((record) => record.listenerOrigin)).toEqual([OTHER_LISTENER]);
    expect(await h.pages.forgetListener(OTHER_LISTENER)).toEqual({ status: "forgotten" });
    expect(h.pageRecords).toEqual([]);
  });

  it("retries recording a page after a write failed instead of trusting the failed entry", async () => {
    let failWrites = true;
    const h = await harness({
      writePageRecords: async (next) => {
        if (failWrites) throw new Error("disk busy");
        h.pageRecords.splice(0, h.pageRecords.length, ...next);
      },
    });
    await expect(h.pages.open(7, validateRemoteServerPageOpenRequest(OPEN))).rejects.toThrow();
    failWrites = false;
    await h.pages.open(7, validateRemoteServerPageOpenRequest(OPEN));

    expect(h.pageRecords.map((record) => record.hostId)).toEqual([HOST_ID]);
  });

  it("does nothing for a host with no pages", async () => {
    const h = await harness();
    expect(await h.pages.forgetHost(HOST_ID)).toEqual({ status: "forgotten" });
    expect(h.events).toEqual([]);
  });
});

describe("which listeners the forwarder will reach", () => {
  it("holds a paired computer to the pin the desktop recorded, whatever trust the window names", async () => {
    const { pages, shown, asked, trusts } = await harness();
    await pages.open(
      7,
      validateRemoteServerPageOpenRequest({
        ...OPEN,
        listenerTrust: { current: { kind: "platform" } },
      }),
    );
    const pageOrigin = shown[0]?.pageOrigin ?? "";
    const reply = pageRequest(pageOrigin, pages.accessFor(pageOrigin) ?? "");
    const question = await waitFor(() => asked[0]);
    pages.answer(7, question.requestId, { status: "signed", headers: { cookie: "c=1" } });
    await reply;

    expect(trusts).toEqual([{ current: { kind: "pinned", pin: "sha256-paired" } }]);
  });

  it("refuses an origin the desktop holds no pin for, and listens and records nothing", async () => {
    const { pages, shown, recorded, pageRecords, external } = await harness();

    for (const mode of ["octant-browser", "default-browser"] as const) {
      expect(
        await pages.open(
          7,
          validateRemoteServerPageOpenRequest({
            ...OPEN,
            mode,
            listenerOrigin: "https://10.0.0.9:8443",
          }),
        ),
      ).toEqual({ kind: "refused", message: "Octant isn't paired with that computer." });
    }
    expect(shown).toEqual([]);
    expect(external).toEqual([]);
    expect(recorded).toEqual([]);
    expect(pageRecords).toEqual([]);
  });

  it("stops relaying for a computer forgotten after its page opened, in either browser", async () => {
    for (const mode of ["octant-browser", "default-browser"] as const) {
      const h = await harness();
      await h.pages.open(7, validateRemoteServerPageOpenRequest({ ...OPEN, mode }));
      const pageOrigin =
        mode === "octant-browser"
          ? (h.shown[0]?.pageOrigin ?? "")
          : new URL(h.external[0] ?? "http://x").origin;
      const access = h.pages.accessFor(pageOrigin) ?? "";
      // While the computer is paired the page is served.
      const served = pageRequest(pageOrigin, access);
      const question = await waitFor(() => h.asked[0]);
      h.pages.answer(7, question.requestId, { status: "signed", headers: { cookie: "c=1" } });
      expect((await served).status).toBe(200);
      h.sent.length = 0;
      h.pairedOrigins.delete(LISTENER);

      await h.pages.forgetListener(LISTENER);

      expect((await pageRequest(pageOrigin, access)).status).not.toBe(200);
      expect(h.sent).toEqual([]);
    }
  });
});

describe("forgetting one of two listeners a host was opened from", () => {
  it("stops the forgotten listener's page and leaves the other's up, whichever opened last", async () => {
    const h = await harness();
    const OTHER = "https://192.168.1.21:9443";
    await h.pages.open(
      7,
      validateRemoteServerPageOpenRequest({ ...OPEN, mode: "default-browser" }),
    );
    await h.pages.open(
      7,
      validateRemoteServerPageOpenRequest({
        ...OPEN,
        mode: "default-browser",
        listenerOrigin: OTHER,
        grant: { ...OPEN.grant, port: 3000 },
      }),
    );
    const [first, second] = h.external.map((url) => new URL(url).origin);
    const served = async (origin: string) => {
      const reply = pageRequest(origin, h.pages.accessFor(origin) ?? "");
      const question = await waitFor(() => h.asked.find((entry) => !answered.has(entry.requestId)));
      answered.add(question.requestId);
      h.pages.answer(7, question.requestId, { status: "signed", headers: { cookie: "c=1" } });
      return (await reply).status;
    };
    const answered = new Set<string>();
    h.pairedOrigins.delete(LISTENER);

    await h.pages.forgetListener(LISTENER);

    expect((await pageRequest(first ?? "", "x")).status).not.toBe(200);
    expect(h.pages.accessFor(first ?? "")).toBeUndefined();
    expect(await served(second ?? "")).toBe(200);
  });
});

describe("signing a page's requests", () => {
  it("asks the window that opened the page, and relays with its headers", async () => {
    const { pages, shown, asked, sent } = await harness();
    await pages.open(7, validateRemoteServerPageOpenRequest(OPEN));
    const pageOrigin = shown[0]?.pageOrigin ?? "";
    const reply = pageRequest(pageOrigin, pages.accessFor(pageOrigin) ?? "");
    const question = await waitFor(() => asked[0]);
    expect(question.windowId).toBe(7);
    // Another window's answer is not this request's answer.
    pages.answer(8, question.requestId, {
      status: "signed",
      headers: { "x-octant-device-proof": "forged" },
    });
    pages.answer(7, question.requestId, {
      status: "signed",
      headers: {
        cookie: "__Secure-octant-server-proxy-session=proxy-1",
        "x-octant-device-proof": "proof",
      },
    });
    expect(await reply).toEqual({ status: 200, body: "relayed page" });
    expect(new Map(sent[0]?.headers).get("x-octant-device-proof")).toBe("proof");
  });

  it("says an Octant window must be open once the window that opened it is gone", async () => {
    const { pages, shown, asked, sent } = await harness();
    await pages.open(7, validateRemoteServerPageOpenRequest(OPEN));
    const pageOrigin = shown[0]?.pageOrigin ?? "";
    const pending = pageRequest(pageOrigin, pages.accessFor(pageOrigin) ?? "");
    await waitFor(() => asked[0]);
    pages.windowClosed(7);
    const reply = await pending;
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("Open an Octant window to keep this page connected.");
    const after = await pageRequest(pageOrigin, pages.accessFor(pageOrigin) ?? "");
    expect(after.body).toContain("Open an Octant window to keep this page connected.");
    expect(sent).toEqual([]);
  });

  it("accepts only Octant's own headers in a window's answer", () => {
    expect(
      decodeRemoteServerSigning({
        status: "signed",
        headers: { "x-octant-device-proof": "proof", authorization: "Bearer page" },
      }),
    ).toEqual({ status: "refused", reason: "refused" });
    expect(decodeRemoteServerSigning({ status: "refused" })).toEqual({
      status: "refused",
      reason: "refused",
    });
  });
});

describe("Octant's browser for an opened page", () => {
  const pageOrigin = "http://5173-abcdefghijklmnop.octant.localhost:47610";
  const accessFor = (origin: string) => (origin === pageOrigin ? "s3cret" : undefined);

  it("adds the page's secret only to requests for its exact origin", () => {
    expect(pageAccessHeader(`${pageOrigin}/src/main.ts`, pageOrigin, accessFor)).toEqual({
      name: "x-octant-page-access",
      value: "s3cret",
    });
    // The page's live-reload socket to its own name and port.
    const socketUrl = `${pageOrigin.replace("http:", "ws:")}/hmr`;
    expect(pageAccessHeader(socketUrl, pageOrigin, accessFor)).toEqual({
      name: "x-octant-page-access",
      value: "s3cret",
    });
    for (const other of [
      "ws://5173-abcdefghijklmnop.octant.localhost:47611/hmr",
      "wss://5173-abcdefghijklmnop.octant.localhost:47610/hmr",
      "http://5173-abcdefghijklmnop.octant.localhost:47611/",
      "http://3000-zzzzzzzzzzzzzzzz.octant.localhost:47610/",
      "https://cdn.example.com/lib.js",
      "http://localhost:47610/",
    ]) {
      expect(pageAccessHeader(other, pageOrigin, accessFor)).toBeUndefined();
    }
  });

  it("keeps navigation on the page and sends other links to the default browser", () => {
    expect(pageNavigation(`${pageOrigin}/settings`, pageOrigin)).toBe("stay");
    expect(pageNavigation("https://docs.example.com/", pageOrigin)).toBe("external");
    expect(pageNavigation("file:///etc/passwd", pageOrigin)).toBe("block");
  });
});

describe("the forwarder's recorded port", () => {
  it("keeps the port across launches and starts fresh from a damaged record", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-forwarder-port-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    expect(await readRecordedForwarderPort(directory)).toBeUndefined();
    await recordForwarderPort(directory, 47_611);
    expect(await readRecordedForwarderPort(directory)).toBe(47_611);
  });
});

describe("the transport to a paired host's listener", () => {
  it("sends the request over the judged connection and returns every Set-Cookie and the body", async () => {
    const seen: Array<{ url: string; host: string | undefined; body: string }> = [];
    const server: Server = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          url: request.url ?? "",
          host: request.headers.host,
          body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(200, [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
          ["x-octant-server-proxy", "relayed"],
        ]);
        response.end("page body");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const response = await sendThroughListener(
      { listenerOrigin: LISTENER, trust: { current: { kind: "platform" } } },
      {
        method: "POST",
        pathQuery: `/api/server-proxy/${GRANT_ID}/items?a=1`,
        headers: [["content-type", "text/plain"]],
        body: new TextEncoder().encode("hello"),
        signal: new AbortController().signal,
      },
      async () => ({ status: "connected", socket: connectTcp(port, "127.0.0.1") }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await response.text()).toBe("page body");
    expect(seen).toEqual([
      { url: `/api/server-proxy/${GRANT_ID}/items?a=1`, host: "192.168.1.20:9443", body: "hello" },
    ]);
  });

  it("hands back a 205 Reset Content answer without a body", async () => {
    const server: Server = createHttpServer((_request, response) => {
      response.writeHead(205, [["x-octant-server-proxy", "relayed"]]);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const response = await sendThroughListener(
      { listenerOrigin: LISTENER, trust: { current: { kind: "platform" } } },
      {
        method: "POST",
        pathQuery: `/api/server-proxy/${GRANT_ID}/form`,
        headers: [],
        body: new TextEncoder().encode("a=1"),
        signal: new AbortController().signal,
      },
      async () => ({ status: "connected", socket: connectTcp(port, "127.0.0.1") }),
    );
    expect(response.status).toBe(205);
    expect(response.body).toBeNull();
  });

  it("hands back the switched connection when the host accepts a WebSocket upgrade, and the answer when it refuses", async () => {
    const seen: Array<{ url: string; host: string | undefined; upgrade: string | undefined }> = [];
    const server: Server = createHttpServer((_request, response) => {
      response.writeHead(410, [["content-type", "application/json"]]);
      response.end('{"kind":"remote-server-proxy-refused"}');
    });
    const switchedSockets: Socket[] = [];
    server.on("upgrade", (request, socket: Socket) => {
      switchedSockets.push(socket);
      seen.push({
        url: request.url ?? "",
        host: request.headers.host,
        upgrade: request.headers.upgrade,
      });
      if (request.url?.endsWith("/closed") === true) {
        socket.end("HTTP/1.1 410 Gone\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: accept\r\n\r\nfirst",
      );
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          // A switched connection is no longer the server's to close.
          for (const socket of switchedSockets) socket.destroy();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;
    const headers = [
      ["connection", "Upgrade"],
      ["upgrade", "websocket"],
      ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
      ["sec-websocket-version", "13"],
    ] as const;
    const switched = await upgradeThroughListener(
      { listenerOrigin: LISTENER, trust: { current: { kind: "platform" } } },
      { pathQuery: `/api/server-proxy/${GRANT_ID}/hmr`, headers },
      async () => ({ status: "connected", socket: connectTcp(port, "127.0.0.1") }),
    );
    if (switched.status !== "switched") throw new Error("The host did not switch.");
    cleanups.push(() => void switched.socket.destroy());
    expect(new Map(switched.headers).get("Sec-WebSocket-Accept")).toBe("accept");
    expect(new TextDecoder().decode(switched.head)).toBe("first");
    switched.socket.write("frame");
    const echoed = await new Promise<string>((resolve) =>
      switched.socket.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    expect(echoed).toBe("frame");

    const refused = await upgradeThroughListener(
      { listenerOrigin: LISTENER, trust: { current: { kind: "platform" } } },
      { pathQuery: `/api/server-proxy/${GRANT_ID}/closed`, headers },
      async () => ({ status: "connected", socket: connectTcp(port, "127.0.0.1") }),
    );
    if (refused.status !== "answered") throw new Error("The host did not answer.");
    expect(refused.response.status).toBe(410);
    expect(await refused.response.text()).toBe("{}");
    expect(seen).toEqual([
      { url: `/api/server-proxy/${GRANT_ID}/hmr`, host: "192.168.1.20:9443", upgrade: "websocket" },
      {
        url: `/api/server-proxy/${GRANT_ID}/closed`,
        host: "192.168.1.20:9443",
        upgrade: "websocket",
      },
    ]);
  });

  it("sends nothing when the listener's trust refuses the connection", async () => {
    await expect(
      sendThroughListener(
        { listenerOrigin: LISTENER, trust: { current: { kind: "pinned", pin: "sha256/x" } } },
        {
          method: "GET",
          pathQuery: `/api/server-proxy/${GRANT_ID}/`,
          headers: [],
          body: undefined,
          signal: new AbortController().signal,
        },
        async () => ({ status: "refused", reason: "pin-mismatch" }),
      ),
    ).rejects.toThrow("This isn't the computer you paired with");
  });
});
