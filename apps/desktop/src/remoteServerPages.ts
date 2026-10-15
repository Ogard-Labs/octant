// The desktop's half of opening a dev server that runs on another paired
// computer: the loopback forwarder's lifecycle and recorded port, the signing
// round trip to the Octant window that holds the grant, the transport to the
// paired host's listener, and where the page is shown.
//
// The forwarder holds no key. Each request a page sends is signed by the
// window that opened it, which signs only for a grant it holds; with that
// window gone the page says an Octant window must be open. Electron itself is
// reached only through the ports the main process passes in, so the policy
// here is testable without it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Schema } from "effect";
import { RemoteServerGrant } from "@octant/contracts";
import {
  createRemoteServerForwarder,
  type RemoteServerForwarder,
  type RemoteServerForwarderSignRequest,
  type RemoteServerForwarderSigning,
  type RemoteServerHostRequest,
} from "@octant/client-runtime/remote-server-forwarder";
import { connectListener } from "@octant/client-runtime/remote-listener-tls-node";
import {
  decodeListenerOriginTrust,
  LISTENER_TRUST_REFUSAL_COPY,
  type ListenerOriginTrust,
  type ListenerTrustRefusal,
} from "@octant/client-runtime/remote-listener-trust";
import { REMOTE_SERVER_PAGE_ACCESS_HEADER } from "@octant/domain";
import { clearRemotePageStorage, type PageStoragePort } from "./pairedComputers";

export type RemoteServerPageMode = "octant-browser" | "default-browser";

/** What a window asks for after the host granted it a server. */
export interface RemoteServerPageOpenRequest {
  readonly hostId: string;
  readonly hostName: string;
  readonly listenerOrigin: string;
  readonly listenerTrust: ListenerOriginTrust;
  readonly grant: RemoteServerGrant;
  readonly mode: RemoteServerPageMode;
}

export type RemoteServerPageOpenOutcome =
  | {
      readonly kind: "opened";
      /** Said once, when the forwarder had to leave its recorded port. */
      readonly notice?: string;
    }
  | { readonly kind: "refused"; readonly message: string };

const decodeGrant = Schema.decodeUnknownSync(RemoteServerGrant);
const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks a window's open request before anything listens or connects. The
 * listener must be exactly an HTTPS origin, as a pairing record holds it, and
 * the grant must be one the host could have minted.
 */
export function validateRemoteServerPageOpenRequest(value: unknown): RemoteServerPageOpenRequest {
  if (typeof value !== "object" || value === null) throw invalidOpen();
  const record = value as Record<string, unknown>;
  const { hostId, hostName, listenerOrigin, mode } = record;
  if (typeof hostId !== "string" || !HOST_ID_PATTERN.test(hostId)) throw invalidOpen();
  if (typeof hostName !== "string" || hostName.trim() === "" || hostName.length > 200) {
    throw invalidOpen();
  }
  if (typeof listenerOrigin !== "string" || !isHttpsOrigin(listenerOrigin)) throw invalidOpen();
  if (mode !== "octant-browser" && mode !== "default-browser") throw invalidOpen();
  const listenerTrust = decodeListenerOriginTrust(record.listenerTrust);
  if (listenerTrust === undefined) throw invalidOpen();
  let grant: RemoteServerGrant;
  try {
    grant = decodeGrant(record.grant);
  } catch {
    throw invalidOpen();
  }
  return { hostId, hostName: hostName.trim(), listenerOrigin, listenerTrust, grant, mode };
}

function invalidOpen(): Error {
  return new Error("Octant rejected an invalid request to open a server.");
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/** The headers a window may hand back for a request: Octant's own, and nothing the page could use. */
const SIGNED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "cookie",
  "origin",
  "sec-fetch-site",
  "x-octant-device-proof",
  "x-octant-csrf",
  "x-octant-command-id",
]);

/** A window's answer to a signing request, refused unless it carries only Octant's headers. */
export function decodeRemoteServerSigning(value: unknown): RemoteServerForwarderSigning {
  if (typeof value === "object" && value !== null) {
    const record = value as { readonly status?: unknown; readonly headers?: unknown };
    if (record.status === "signed" && typeof record.headers === "object" && record.headers) {
      const headers: Record<string, string> = {};
      for (const [name, header] of Object.entries(record.headers)) {
        if (!SIGNED_HEADER_NAMES.has(name.toLowerCase()) || typeof header !== "string") {
          return { status: "refused", reason: "refused" };
        }
        headers[name.toLowerCase()] = header;
      }
      return { status: "signed", headers };
    }
  }
  return { status: "refused", reason: "refused" };
}

/** A page of another computer's server that Octant's browser keeps storage for. */
export interface RemoteServerPageRecord {
  readonly name: string;
  readonly hostId: string;
  readonly listenerOrigin: string;
}

export type ForgetRemoteServerPagesOutcome =
  | { readonly status: "forgotten" }
  | { readonly status: "incomplete"; readonly message: string };

export interface RemoteServerPagesPorts {
  /** The pages whose storage Octant's browser keeps, from the app's data folder. */
  readonly readPageRecords: () => Promise<ReadonlyArray<RemoteServerPageRecord>>;
  readonly writePageRecords: (records: ReadonlyArray<RemoteServerPageRecord>) => Promise<void>;
  /** Closes the Octant-browser window of a page, without waiting on the page. */
  readonly closePageWindow: (name: string) => void;
  /**
   * The page's persistent partition. The partition holds nothing but that
   * page, so clearing it ignores the origin: the forwarder's port may have
   * moved since the page stored what it did.
   */
  readonly pageStorage: (name: string) => PageStoragePort;
  readonly readRecordedPort: () => Promise<number | undefined>;
  readonly recordPort: (port: number) => Promise<void>;
  /** Asks one window to sign; `false` when that window is gone. Its answer arrives through `answer`. */
  readonly askWindowToSign: (
    windowId: number,
    requestId: string,
    request: RemoteServerForwarderSignRequest,
  ) => boolean;
  /** Shows the page in Octant's own browser, confined to its origin. */
  readonly showInOctantBrowser: (page: {
    readonly name: string;
    readonly pageOrigin: string;
  }) => void;
  readonly openExternal: (url: string) => Promise<void>;
  /** The transport to a paired host's listener; production uses {@link sendThroughListener}. */
  readonly sendToHost?: (
    target: { readonly listenerOrigin: string; readonly trust: ListenerOriginTrust },
    request: RemoteServerHostRequest,
  ) => Promise<Response>;
  readonly signTimeoutMs?: number;
  readonly randomId?: () => string;
  /** Test seams for the forwarder's ports and addresses. */
  readonly forwarderPorts?: { readonly first: number; readonly count: number };
  readonly forwarderAddresses?: ReadonlyArray<"127.0.0.1" | "::1">;
}

export interface RemoteServerPages {
  /** Opens a granted server for the window that asked. */
  readonly open: (
    windowId: number,
    request: RemoteServerPageOpenRequest,
  ) => Promise<RemoteServerPageOpenOutcome>;
  /** A window's answer to a signing request; ignored unless that window was asked. */
  readonly answer: (windowId: number, requestId: unknown, signing: unknown) => void;
  /** The secret Octant's browser adds, for exactly this origin. */
  readonly accessFor: (origin: string) => string | undefined;
  /** A window closed: its pending signatures fail now rather than at the timeout. */
  readonly windowClosed: (windowId: number) => void;
  /**
   * Forgets every page of one paired host: its windows close, its partitions
   * are cleared, and its page names are dropped. A name whose storage could
   * not be cleared is kept, so the next forget retries it.
   */
  readonly forgetHost: (hostId: string) => Promise<ForgetRemoteServerPagesOutcome>;
  /** The same for every page served from one listener, when a paired computer is forgotten. */
  readonly forgetListener: (listenerOrigin: string) => Promise<ForgetRemoteServerPagesOutcome>;
  readonly stop: () => Promise<void>;
}

const SIGN_TIMEOUT_MS = 10_000;

type ForwarderReadiness =
  | { readonly kind: "listening"; readonly notice?: string }
  | { readonly kind: "refused"; readonly message: string };

export function createRemoteServerPages(ports: RemoteServerPagesPorts): RemoteServerPages {
  const signTimeoutMs = ports.signTimeoutMs ?? SIGN_TIMEOUT_MS;
  const randomId = ports.randomId ?? (() => globalThis.crypto.randomUUID());
  const sendToHost = ports.sendToHost ?? sendThroughListener;
  // Which window holds each grant, and the trust each host's listener is held to.
  const signerByGrant = new Map<string, number>();
  const trustByHost = new Map<string, ListenerOriginTrust>();
  const pending = new Map<
    string,
    {
      readonly windowId: number;
      readonly resolve: (signing: RemoteServerForwarderSigning) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  let forwarder: RemoteServerForwarder | undefined;
  let starting: Promise<ForwarderReadiness> | undefined;
  let noticeGiven = false;
  let records: Map<string, RemoteServerPageRecord> | undefined;
  // Page changes run one at a time so a forget never races an open's write.
  let recordsQueue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = recordsQueue.then(work, work);
    recordsQueue = run.catch(() => undefined);
    return run;
  };
  const loadRecords = async (): Promise<Map<string, RemoteServerPageRecord>> => {
    records ??= new Map((await ports.readPageRecords()).map((record) => [record.name, record]));
    return records;
  };
  const forgetPages = (
    matches: (record: RemoteServerPageRecord) => boolean,
    hostIds: ReadonlyArray<string> = [],
  ): Promise<ForgetRemoteServerPagesOutcome> =>
    exclusive(async () => {
      const held = await loadRecords();
      const doomed = [...held.values()].filter(matches);
      for (const record of doomed) ports.closePageWindow(record.name);
      for (const hostId of new Set([...hostIds, ...doomed.map((record) => record.hostId)])) {
        forwarder?.closeHost(hostId);
        trustByHost.delete(hostId);
      }
      let failed = 0;
      for (const record of doomed) {
        try {
          await clearRemotePageStorage(ports.pageStorage(record.name), `http://${record.name}`);
          held.delete(record.name);
        } catch {
          failed += 1;
        }
      }
      if (doomed.length > 0) await ports.writePageRecords([...held.values()]);
      return failed === 0
        ? { status: "forgotten" }
        : {
            status: "incomplete",
            message:
              "Octant forgot that computer, but couldn't clear everything its pages stored. Remove it again to retry.",
          };
    });

  const sign = (
    request: RemoteServerForwarderSignRequest,
  ): Promise<RemoteServerForwarderSigning> => {
    const windowId = signerByGrant.get(request.grantId);
    if (windowId === undefined) return Promise.resolve({ status: "refused", reason: "no-window" });
    const requestId = randomId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ status: "refused", reason: "no-window" });
      }, signTimeoutMs);
      pending.set(requestId, { windowId, resolve, timer });
      if (!ports.askWindowToSign(windowId, requestId, request)) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve({ status: "refused", reason: "no-window" });
      }
    });
  };

  const ensureListening = async (): Promise<ForwarderReadiness> => {
    if (forwarder !== undefined) return { kind: "listening" };
    const recordedPort = await ports.readRecordedPort();
    const created = createRemoteServerForwarder({
      ...(recordedPort === undefined ? {} : { recordedPort }),
      ...(ports.forwarderPorts === undefined ? {} : { ports: ports.forwarderPorts }),
      ...(ports.forwarderAddresses === undefined ? {} : { addresses: ports.forwarderAddresses }),
      sign,
      sendToHost: (target, request) => {
        const trust = trustByHost.get(target.hostId);
        if (trust === undefined) return Promise.reject(new Error("No trust for this host."));
        return sendToHost({ listenerOrigin: target.listenerOrigin, trust }, request);
      },
    });
    const started = await created.start();
    if (started.status === "refused") return { kind: "refused", message: started.message };
    forwarder = created;
    if (started.port !== recordedPort) await ports.recordPort(started.port);
    return started.moved
      ? {
          kind: "listening",
          notice: "Octant moved its local port, so pages opened before start with empty storage.",
        }
      : { kind: "listening" };
  };

  return {
    open: async (windowId, request) => {
      starting ??= ensureListening().finally(() => {
        starting = undefined;
      });
      const listening = await starting;
      if (listening.kind === "refused") return listening;
      const active = forwarder;
      if (active === undefined)
        return { kind: "refused", message: "Octant could not open this server." };
      trustByHost.set(request.hostId, request.listenerTrust);
      signerByGrant.set(String(request.grant.grantId), windowId);
      const page = active.open({
        hostId: request.hostId,
        hostName: request.hostName,
        listenerOrigin: request.listenerOrigin,
        grant: request.grant,
      });
      if (request.mode === "octant-browser") {
        // Recorded before the window shows, so no partition exists that a
        // later forget could not find.
        await exclusive(async () => {
          const held = await loadRecords();
          if (held.has(page.name)) return;
          held.set(page.name, {
            name: page.name,
            hostId: request.hostId,
            listenerOrigin: request.listenerOrigin,
          });
          await ports.writePageRecords([...held.values()]);
        });
        ports.showInOctantBrowser({ name: page.name, pageOrigin: page.pageOrigin });
      } else {
        await ports.openExternal(page.claimUrl());
      }
      const notice = noticeGiven ? undefined : listening.notice;
      if (notice !== undefined) noticeGiven = true;
      return notice === undefined ? { kind: "opened" } : { kind: "opened", notice };
    },
    answer: (windowId, requestId, signing) => {
      if (typeof requestId !== "string") return;
      const waiting = pending.get(requestId);
      // Only the window that was asked may answer, so another renderer cannot
      // put its own headers on a page's request.
      if (waiting === undefined || waiting.windowId !== windowId) return;
      pending.delete(requestId);
      clearTimeout(waiting.timer);
      waiting.resolve(decodeRemoteServerSigning(signing));
    },
    accessFor: (origin) => forwarder?.accessFor(origin),
    windowClosed: (windowId) => {
      for (const [requestId, waiting] of pending) {
        if (waiting.windowId !== windowId) continue;
        pending.delete(requestId);
        clearTimeout(waiting.timer);
        waiting.resolve({ status: "refused", reason: "no-window" });
      }
      for (const [grantId, signer] of signerByGrant) {
        if (signer === windowId) signerByGrant.delete(grantId);
      }
    },
    forgetHost: (hostId) => forgetPages((record) => record.hostId === hostId, [hostId]),
    forgetListener: (listenerOrigin) =>
      forgetPages((record) => record.listenerOrigin === listenerOrigin),
    stop: async () => {
      for (const waiting of pending.values()) clearTimeout(waiting.timer);
      pending.clear();
      await forwarder?.stop();
      forwarder = undefined;
    },
  };
}

const PAGE_RECORDS_FILE = "remote-server-pages.json";

/**
 * The pages Octant's browser keeps storage for, from the app's data folder.
 * Page names are derived, so without this record a partition left by an
 * earlier launch would have no name to clear it by.
 */
export async function readRecordedRemotePages(
  directory: string,
): Promise<ReadonlyArray<RemoteServerPageRecord>> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, PAGE_RECORDS_FILE), "utf8")) as {
      readonly pages?: unknown;
    };
    if (!Array.isArray(parsed.pages)) return [];
    const pages: RemoteServerPageRecord[] = [];
    for (const entry of parsed.pages) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, hostId, listenerOrigin } = entry as Record<string, unknown>;
      if (
        typeof name === "string" &&
        typeof hostId === "string" &&
        typeof listenerOrigin === "string"
      ) {
        pages.push({ name, hostId, listenerOrigin });
      }
    }
    return pages;
  } catch {
    return [];
  }
}

export async function recordRemotePages(
  directory: string,
  pages: ReadonlyArray<RemoteServerPageRecord>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, PAGE_RECORDS_FILE);
  const staged = `${path}.${String(process.pid)}.tmp`;
  await writeFile(staged, `${JSON.stringify({ version: 1, pages })}\n`, { mode: 0o600 });
  await rename(staged, path);
}

const FORWARDER_PORT_FILE = "remote-server-forwarder.json";

/**
 * The port the forwarder held last, from the app's own data folder. A page's
 * origin includes it, so keeping it keeps every opened page's cookies and
 * storage across launches. A missing or damaged record starts from the
 * default port.
 */
export async function readRecordedForwarderPort(directory: string): Promise<number | undefined> {
  try {
    const record = JSON.parse(await readFile(join(directory, FORWARDER_PORT_FILE), "utf8")) as {
      readonly port?: unknown;
    };
    return typeof record.port === "number" && Number.isInteger(record.port)
      ? record.port
      : undefined;
  } catch {
    return undefined;
  }
}

export async function recordForwarderPort(directory: string, port: number): Promise<void> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, FORWARDER_PORT_FILE);
  const staged = `${path}.${String(process.pid)}.tmp`;
  await writeFile(staged, `${JSON.stringify({ port })}\n`, { mode: 0o600 });
  await rename(staged, path);
}

/**
 * Whether Octant's browser adds the page's secret to a request: only for the
 * page's exact origin, so no other port or name ever sees it.
 */
export function pageAccessHeader(
  url: string,
  pageOrigin: string,
  accessFor: (origin: string) => string | undefined,
): { readonly name: string; readonly value: string } | undefined {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  if (origin !== pageOrigin) return undefined;
  const value = accessFor(origin);
  return value === undefined ? undefined : { name: REMOTE_SERVER_PAGE_ACCESS_HEADER, value };
}

/**
 * Where a navigation in Octant's browser goes: the page stays on its own
 * origin, and a link elsewhere opens in the default browser, never in a view
 * that carries the page's secret.
 */
export function pageNavigation(url: string, pageOrigin: string): "stay" | "external" | "block" {
  try {
    const target = new URL(url);
    if (target.origin === pageOrigin) return "stay";
    return target.protocol === "http:" || target.protocol === "https:" ? "external" : "block";
  } catch {
    return "block";
  }
}

export type ListenerConnect = (options: {
  readonly origin: string;
  readonly trust: ListenerOriginTrust;
}) => Promise<
  | { readonly status: "connected"; readonly socket: Duplex }
  | { readonly status: "refused"; readonly reason: ListenerTrustRefusal }
  | { readonly status: "failed"; readonly reason: string }
>;

/**
 * Sends one request to a paired host's listener over a connection that
 * carries nothing until its address and certificate pass the listener trust
 * rule, and hands the answer back without a cookie jar, so nothing the dev
 * server sets is stored under the listener's origin.
 */
export async function sendThroughListener(
  target: { readonly listenerOrigin: string; readonly trust: ListenerOriginTrust },
  request: RemoteServerHostRequest,
  connect: ListenerConnect = connectListener,
): Promise<Response> {
  const connection = await connect({ origin: target.listenerOrigin, trust: target.trust });
  if (connection.status === "refused") {
    throw new Error(LISTENER_TRUST_REFUSAL_COPY[connection.reason]);
  }
  if (connection.status === "failed") throw new Error("The host could not be reached.");
  const socket = connection.socket;
  const headers: Record<string, string> = { host: new URL(target.listenerOrigin).host };
  for (const [name, value] of request.headers) headers[name] = value;
  if (request.body !== undefined) headers["content-length"] = String(request.body.byteLength);
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        method: request.method,
        path: request.pathQuery,
        headers,
        createConnection: () => socket,
        signal: request.signal,
      },
      (incoming) => {
        const answered = new Headers();
        for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) answered.append(name, value);
        }
        const status = incoming.statusCode ?? 502;
        // Null-body statuses: a Response refuses a body for any of them.
        const bodiless =
          request.method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (bodiless) incoming.resume();
        const chunks = incoming[Symbol.asyncIterator]();
        const body = bodiless
          ? null
          : new ReadableStream<Uint8Array>({
              pull: async (controller) => {
                try {
                  const next = (await chunks.next()) as IteratorResult<Buffer>;
                  if (next.done === true) controller.close();
                  else controller.enqueue(new Uint8Array(next.value));
                } catch (error) {
                  controller.error(error);
                }
              },
              cancel: () => {
                incoming.destroy();
              },
            });
        // Constructing the answer runs in Node's response callback, where a
        // throw would escape as an uncaught main-process error rather than
        // reach the forwarder; refuse the request instead.
        try {
          resolve(new Response(body, { status, headers: answered }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    outgoing.on("error", reject);
    outgoing.end(request.body === undefined ? undefined : Buffer.from(request.body));
  });
}
