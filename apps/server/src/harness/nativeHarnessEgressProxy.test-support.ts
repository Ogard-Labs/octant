import { randomUUID } from "node:crypto";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { Schema } from "effect";
import {
  AggregateId,
  decodeThreadEgressDecisionsRecordedPayload,
  decodeThreadEgressLaunchStartedPayload,
  decodeThreadEgressLaunchSummarizedPayload,
  ToolEgressLaunchId,
  ToolEgressRuleId,
  type ThreadEgressDecisionsRecordedPayload,
  type ThreadEgressLaunchStartedPayload,
  type ThreadEgressLaunchSummarizedPayload,
  type ToolEgressLaunch,
} from "@octant/contracts";
import type { ToolEgressRule } from "@octant/domain/tool-egress-policy";
import {
  startToolEgressProxy,
  type ToolEgressProxy,
  type ToolEgressProxyEndpointRequest,
  type ToolEgressProxyLimits,
  type ToolEgressRecordAppend,
} from "./nativeHarnessEgressProxy";

/*
 * A harness for the tool egress proxy that never leaves this machine. Names
 * resolve through an injected resolver to public addresses (93.184.216.0/24,
 * 2606:2800:220:1::/64; documentation ranges would be refused as reserved),
 * and the injected dialer routes each such address to a loopback fixture and
 * throws for any other, so nothing is dialled on the internet.
 * The private check itself is never replaced, so every refusal it makes is
 * the production one.
 */

const aggregateId = Schema.decodeUnknownSync(AggregateId);
export const egressThread = aggregateId("00000000-0000-4000-8000-0000000000e1");
export const egressOtherThread = aggregateId("00000000-0000-4000-8000-0000000000e2");
export const egressProject = aggregateId("00000000-0000-4000-8000-0000000000e3");

export const egressStart = Date.parse("2026-10-14T08:00:00.000Z");
export const inOneHour = new Date(egressStart + 3_600_000).toISOString();

export function launchFor(threadId = egressThread): ToolEgressLaunch {
  return {
    launchId: Schema.decodeUnknownSync(ToolEgressLaunchId)(randomUUID()),
    threadId,
    projectId: egressProject,
    toolCallId: "call-egress-1",
  };
}

export function threadRule(
  host: string,
  port: number,
  options: { readonly threadId?: AggregateId; readonly expiresAt?: string } = {},
): ToolEgressRule {
  return {
    id: Schema.decodeUnknownSync(ToolEgressRuleId)(randomUUID()),
    scope: { kind: "thread", threadId: options.threadId ?? egressThread },
    host,
    port,
    expiresAt: options.expiresAt ?? inOneHour,
  };
}

export interface RecordedEgress {
  readonly started: ThreadEgressLaunchStartedPayload[];
  readonly batches: ThreadEgressDecisionsRecordedPayload[];
  readonly summaries: ThreadEgressLaunchSummarizedPayload[];
}

export interface EgressHarnessOptions {
  readonly launch?: ToolEgressLaunch;
  readonly rules?: ToolEgressRule[];
  readonly resolve?: (host: string) => Promise<ReadonlyArray<string>>;
  readonly routes?: ReadonlyMap<string, number>;
  readonly endpoint?: ToolEgressProxyEndpointRequest;
  readonly limits?: Partial<ToolEgressProxyLimits>;
  readonly failStart?: boolean;
  readonly failBatches?: () => boolean;
  readonly failSummary?: boolean;
  /** Appends that never answer, as a hung journal would. */
  readonly hangBatches?: boolean;
  readonly hangSummary?: boolean;
  readonly taint?: () => { readonly threadTainted: boolean; readonly parentTainted: boolean };
  readonly rulesRead?: () => ReadonlyArray<ToolEgressRule>;
  readonly clock?: () => string;
}

export interface EgressHarness {
  readonly proxy: ToolEgressProxy;
  readonly launch: ToolEgressLaunch;
  readonly rules: ToolEgressRule[];
  readonly records: RecordedEgress;
  /** Every address the proxy asked the dialer for, in order. */
  readonly dialed: Array<{ readonly address: string; readonly port: number }>;
  readonly resolved: string[];
  /** Moves the harness clock; decisions read it, timers do not. */
  readonly advance: (milliseconds: number) => void;
  readonly authorization: string;
}

const proxies: ToolEgressProxy[] = [];
const fixtures: Server[] = [];
const fixtureSockets: Socket[] = [];

export async function closeEgressHarnesses(): Promise<void> {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  for (const socket of fixtureSockets.splice(0)) socket.destroy();
  await Promise.all(
    fixtures
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}

export async function startEgressHarness(
  options: EgressHarnessOptions = {},
): Promise<EgressHarness> {
  const launch = options.launch ?? launchFor();
  const rules = options.rules ?? [];
  const records: RecordedEgress = { started: [], batches: [], summaries: [] };
  const dialed: Array<{ address: string; port: number }> = [];
  const resolved: string[] = [];
  let now = egressStart;
  const routes = options.routes ?? new Map<string, number>();
  const appended = (fail: boolean): ToolEgressRecordAppend =>
    fail ? { status: "unavailable" } : { status: "appended" };
  const started = await startToolEgressProxy({
    launch,
    taint: options.taint ?? (() => ({ threadTainted: false, parentTainted: false })),
    rules: options.rulesRead ?? (() => rules),
    clock: options.clock ?? (() => new Date(now).toISOString()),
    endpoint: options.endpoint ?? { kind: "loopback" },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    resolveAll: async (host) => {
      resolved.push(host);
      return options.resolve === undefined ? ["93.184.216.10"] : options.resolve(host);
    },
    connect: ({ address, port }) => {
      dialed.push({ address, port });
      const fixturePort = routes.get(address);
      if (fixturePort === undefined) throw new Error(`no fixture routed for ${address}`);
      return netConnect({ host: "127.0.0.1", port: fixturePort, allowHalfOpen: true });
    },
    records: {
      launchStarted: async (payload) => {
        if (options.failStart === true) return appended(true);
        records.started.push(decodeThreadEgressLaunchStartedPayload(payload));
        return appended(false);
      },
      decisionsRecorded: async (payload) => {
        if (options.hangBatches === true) return new Promise(() => undefined);
        if (options.failBatches?.() === true) return appended(true);
        records.batches.push(decodeThreadEgressDecisionsRecordedPayload(payload));
        return appended(false);
      },
      launchSummarized: async (payload) => {
        if (options.hangSummary === true) return new Promise(() => undefined);
        if (options.failSummary === true) return appended(true);
        records.summaries.push(decodeThreadEgressLaunchSummarizedPayload(payload));
        return appended(false);
      },
    },
  });
  if (started.status !== "listening") throw new Error(`proxy refused: ${started.reason}`);
  proxies.push(started.proxy);
  return {
    proxy: started.proxy,
    launch,
    rules,
    records,
    dialed,
    resolved,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    authorization: basicAuthorization(started.proxy.token),
  };
}

export function basicAuthorization(token: string, user = "octant"): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

/** A loopback TCP fixture; `seen` holds every byte it received. */
export async function tcpFixture(
  onConnection: (socket: Socket) => void = (socket) => socket.pipe(socket),
): Promise<{
  readonly port: number;
  readonly seen: () => string;
  readonly connections: () => number;
}> {
  let seen = "";
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections += 1;
    fixtureSockets.push(socket);
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
    });
    socket.on("error", () => socket.destroy());
    onConnection(socket);
  });
  fixtures.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, seen: () => seen, connections: () => connections };
}

function proxySocket(proxy: ToolEgressProxy): Socket {
  const endpoint = proxy.endpoint;
  const socket =
    endpoint.kind === "loopback"
      ? netConnect({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true })
      : netConnect({ path: endpoint.path, allowHalfOpen: true });
  // Close our side once the proxy closes its own, so `close` reports the end.
  socket.on("end", () => socket.end());
  return socket;
}

/** Sends raw bytes to the proxy and returns everything it answers until it closes. */
export function exchange(
  proxy: ToolEgressProxy,
  request: string | Buffer,
  options: { readonly endAfterWrite?: boolean } = {},
): Promise<string> {
  return new Promise((resolve) => {
    const socket = proxySocket(proxy);
    let answer = "";
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString("latin1");
    });
    socket.on("error", () => resolve(answer));
    socket.on("close", () => resolve(answer));
    socket.write(request);
    if (options.endAfterWrite === true) socket.end();
  });
}

/**
 * Opens a `CONNECT` tunnel and returns the proxy's answer head and the socket,
 * which is the tunnel when the answer is 200.
 */
export function openTunnel(
  proxy: ToolEgressProxy,
  target: string,
  authorization: string | undefined,
): Promise<{ readonly status: number; readonly answer: string; readonly socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = proxySocket(proxy);
    let answer = "";
    const onData = (chunk: Buffer) => {
      answer += chunk.toString("latin1");
      const end = answer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0);
      if (status !== 200) return; // wait for the refusal body and close
      socket.off("data", onData);
      resolve({ status, answer: answer.slice(0, end + 4), socket });
    };
    socket.on("data", onData);
    socket.on("close", () =>
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0), answer, socket }),
    );
    socket.on("error", reject);
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (authorization !== undefined) lines.push(`Proxy-Authorization: ${authorization}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

/** Writes through an open tunnel and resolves with what comes back, or "" when it closes. */
export function roundTrip(socket: Socket, payload: string, expectedBytes: number): Promise<string> {
  return new Promise((resolve) => {
    let answer = "";
    const onData = (chunk: Buffer) => {
      answer += chunk.toString("latin1");
      if (answer.length >= expectedBytes) {
        socket.off("data", onData);
        resolve(answer);
      }
    };
    socket.on("data", onData);
    socket.once("close", () => resolve(answer));
    socket.write(payload);
  });
}

export function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("condition not met in time"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

/**
 * A minimal TLS 1.2 ClientHello naming `serverNames` (none omits the
 * extension), cut into records of at most `recordSize` bytes so a hello that
 * spans records can be sent.
 */
export function clientHello(serverNames: ReadonlyArray<string>, recordSize = 16_384): Buffer {
  const extensions: Buffer[] = [];
  if (serverNames.length > 0) {
    const entries = Buffer.concat(
      serverNames.map((name) => {
        const bytes = Buffer.from(name, "latin1");
        const entry = Buffer.alloc(3 + bytes.length);
        entry[0] = 0;
        entry.writeUInt16BE(bytes.length, 1);
        bytes.copy(entry, 3);
        return entry;
      }),
    );
    const list = Buffer.alloc(2 + entries.length);
    list.writeUInt16BE(entries.length, 0);
    entries.copy(list, 2);
    const extension = Buffer.alloc(4 + list.length);
    extension.writeUInt16BE(0, 0);
    extension.writeUInt16BE(list.length, 2);
    list.copy(extension, 4);
    extensions.push(extension);
  }
  // A padding extension so the hello is long enough to split meaningfully.
  const padding = Buffer.alloc(4 + 200);
  padding.writeUInt16BE(0x0015, 0);
  padding.writeUInt16BE(200, 2);
  extensions.push(padding);
  const extensionBytes = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x02, 0x13, 0x01]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([extensionBytes.length >> 8, extensionBytes.length & 0xff]),
    extensionBytes,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  const records: Buffer[] = [];
  for (let at = 0; at < handshake.length; at += recordSize) {
    const fragment = handshake.subarray(at, at + recordSize);
    records.push(
      Buffer.from([0x16, 0x03, 0x01, fragment.length >> 8, fragment.length & 0xff]),
      fragment,
    );
  }
  return Buffer.concat(records);
}

/**
 * The injected resolver and dialer a launch started through the rules store
 * uses: every name answers a documentation address, and each such address is
 * routed to a loopback fixture.
 */
export function fixtureNetwork(routes: ReadonlyMap<string, number>): {
  readonly resolveAll: (host: string) => Promise<ReadonlyArray<string>>;
  readonly connect: (destination: { readonly address: string; readonly port: number }) => Socket;
  readonly dialed: ReadonlyArray<{ readonly address: string; readonly port: number }>;
  readonly resolved: ReadonlyArray<string>;
} {
  const dialed: Array<{ address: string; port: number }> = [];
  const resolved: string[] = [];
  return {
    resolveAll: async (host) => {
      resolved.push(host);
      return ["203.0.113.10"];
    },
    connect: ({ address, port }) => {
      dialed.push({ address, port });
      const fixturePort = routes.get(address);
      if (fixturePort === undefined) throw new Error(`no fixture routed for ${address}`);
      return netConnect({ host: "127.0.0.1", port: fixturePort, allowHalfOpen: true });
    },
    dialed,
    resolved,
  };
}
