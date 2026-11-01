import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect, createServer, Socket, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { Option, Schema } from "effect";
import {
  MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES,
  MAX_TOOL_EGRESS_SUMMARY_ENTRIES,
  type ThreadEgressDecisionsRecordedPayload,
  type ThreadEgressLaunchStartedPayload,
  type ThreadEgressLaunchSummarizedPayload,
  type ToolEgressDecisionEntry,
  type ToolEgressLaunch,
  type ToolEgressRefusalReason,
  type SafeNetworkPlace,
  type ToolEgressRuleId,
  UtcTimestamp,
} from "@octant/contracts";
import {
  runtimeEgressPrivateAddressAllowed,
  safeNetworkPlaceAllows,
  type RuntimeEgressAllowedBy,
  type RuntimeEgressDecision,
} from "@octant/domain/safe-network-policy";
import {
  canonicalToolEgressHost,
  decideToolEgress,
  type ToolEgressDecision,
  type ToolEgressLaunchFacts,
  type ToolEgressRule,
} from "@octant/domain/tool-egress-policy";
import {
  fieldValue,
  forwardedRequestHead,
  type ProxyRequestHead,
  readClientHelloServerName,
  readProxyRequestHead,
  RequestContent,
} from "./nativeHarnessEgressWire";
import { defaultResolveAll, isPrivateAddress } from "./nativeHarnessWebFetch";

/**
 * The host's forward proxy for one confined harness launch: a fresh listener
 * and launch token, `CONNECT` tunnels and absolute-form plain `http://`
 * requests, resolution pinned to the addresses it checked, and the batched
 * decision records and launch summary the journal keeps. Canonical:
 * docs/architecture.md § Harness tool egress rules.
 *
 * Every allow or refuse comes from `decideToolEgress`; the proxy adds only
 * what that pure decision cannot know: the token, the resolved addresses, the
 * TLS server name, and its own limits. It decides afresh for every request
 * and before every chunk it relays, so a rule that expires or is revoked
 * closes its tunnels whatever a timer did. The harness shell starts one per
 * command on `proxied` network, and the OS rules of that launch reach nothing
 * else.
 */

export const TOOL_EGRESS_PROXY_LIMITS = {
  maxTunnels: 128,
  maxPending: 16,
  maxHeadBytes: 32 * 1_024,
  headTimeoutMs: 10_000,
  maxClientHelloBytes: 16 * 1_024,
  resolveTimeoutMs: 10_000,
  escalateTimeoutMs: 20_000,
  connectTimeoutMs: 10_000,
  flushIntervalMs: 5_000,
  recordTimeoutMs: 10_000,
} as const;

export interface ToolEgressProxyLimits {
  /** Open tunnels and forwarded requests at once. */
  readonly maxTunnels: number;
  /** Requests past the decision and still resolving or connecting. */
  readonly maxPending: number;
  readonly maxHeadBytes: number;
  /** The whole request head must arrive within this, however it trickles in. */
  readonly headTimeoutMs: number;
  readonly maxClientHelloBytes: number;
  readonly resolveTimeoutMs: number;
  /** How long a reviewer may take over an unlisted host before the refusal stands. */
  readonly escalateTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly flushIntervalMs: number;
  /** A record append that has not answered by then counts as `unavailable`. */
  readonly recordTimeoutMs: number;
}

export type ToolEgressRecordAppend =
  | { readonly status: "appended" }
  | { readonly status: "unavailable" };

/** Where the launch's records go. A rejected promise counts as `unavailable`. */
export interface ToolEgressRecords {
  readonly launchStarted: (
    payload: ThreadEgressLaunchStartedPayload,
  ) => Promise<ToolEgressRecordAppend>;
  readonly decisionsRecorded: (
    payload: ThreadEgressDecisionsRecordedPayload,
  ) => Promise<ToolEgressRecordAppend>;
  readonly launchSummarized: (
    payload: ThreadEgressLaunchSummarizedPayload,
  ) => Promise<ToolEgressRecordAppend>;
}

export type ToolEgressProxyEndpointRequest =
  /** A loopback port the OS chooses (macOS). */
  | { readonly kind: "loopback" }
  /** A socket in a fresh `0700` directory under `parentDirectory` (Linux). */
  | { readonly kind: "unix-socket"; readonly parentDirectory: string };

export type ToolEgressProxyEndpoint =
  | { readonly kind: "loopback"; readonly host: "127.0.0.1"; readonly port: number }
  | { readonly kind: "unix-socket"; readonly path: string };

export interface ToolEgressProxyOptions {
  readonly launch: ToolEgressLaunch;
  /** Read for every decision. A read that throws counts as tainted. */
  readonly taint: () => { readonly threadTainted: boolean; readonly parentTainted: boolean };
  /** The rule projection, read for every decision. A read that throws is an empty rule set. */
  readonly rules: () => ReadonlyArray<ToolEgressRule>;
  /** An ISO timestamp with milliseconds, as the journal stores times. */
  readonly clock: () => string;
  readonly records: ToolEgressRecords;
  readonly endpoint: ToolEgressProxyEndpointRequest;
  /** Every address a name resolves to. Defaults to the lookup `web-fetch` uses. */
  readonly resolveAll?: (host: string) => Promise<ReadonlyArray<string>>;
  /**
   * Opens a connection to an address the proxy already checked. It receives
   * an address, never a name, so nothing resolves again at connect time. The
   * connection must allow half-open closes and emit `connect` once it is
   * open. A caller may dial its own, such as a stream the host carries, rather
   * than a socket of this host's.
   */
  readonly connect?: (destination: { readonly address: string; readonly port: number }) => Duplex;
  readonly limits?: Partial<ToolEgressProxyLimits>;
  /**
   * Told of every request refused for `no-rule` or `expired`, the two
   * refusals learn mode may propose a rule for. It is told after the refusal
   * is decided and answered; nothing it does or throws changes a decision.
   */
  readonly onProposable?: (refusal: ToolEgressProposableRefusal) => void;
  /**
   * What decides each request. `tool-rules` (the default) is a harness
   * command's: the thread's and Project's rules. A provider runtime's
   * decider reaches its provider's endpoints, its own loopback ports, its
   * Project's rules, and the person's safe networks, and nothing it refuses
   * is proposed.
   */
  readonly decision?: "tool-rules" | ProviderRuntimeEgressDecider;
  /**
   * The person's safe networks for a harness command's `tool-rules`: a
   * destination its rules refuse passes when a place names it. Read for every
   * decision and ignored while the thread or its parent is tainted, as
   * standing rules are. Absent is no places (Network limits off).
   */
  readonly places?: () => ReadonlyArray<SafeNetworkPlace>;
  /**
   * Asked about a harness command's `no-rule` or `expired` refusal before it
   * is answered: the reviewer path for a per-call network prompt. Like a
   * runtime's hook, the proxy decides again once it settles or times out, so
   * only a `call` rule it granted lets the request through.
   */
  readonly escalate?: (destination: {
    readonly host: string;
    readonly port: number;
  }) => Promise<void>;
  /**
   * `launch-token` (the default) refuses a request without the launch's token.
   * `none` serves a client that cannot send one: a provider sandbox that
   * points its commands at a bare loopback port. Any process on this machine
   * that can reach the port can then use it, so it reaches only what the
   * decider allows.
   */
  readonly authentication?: "launch-token" | "none";
}

/**
 * How a provider runtime's proxy decides, read afresh for every request and
 * relayed chunk. Canonical: docs/architecture.md § Provider runtime network.
 */
export interface ProviderRuntimeEgressDecider {
  readonly kind: "provider-runtime";
  readonly decide: (destination: {
    readonly host: string;
    readonly port: number;
  }) => RuntimeEgressDecision;
  /** Whether a private address a destination resolved to may be connected, for what allowed it. */
  readonly privateAddressAllowed: (input: {
    readonly address: string;
    readonly port: number;
    readonly by: RuntimeEgressAllowedBy;
  }) => boolean;
  /**
   * Asked about an unlisted host before its refusal is answered: the reviewer
   * hook. The proxy decides again once it settles or times out, so only what
   * the decider then allows goes through; nothing it returns or throws allows
   * a request by itself.
   */
  readonly escalate?: (destination: {
    readonly host: string;
    readonly port: number;
  }) => Promise<void>;
}

/** A decision as the proxy acts on it: an allowance names its rule when a rule made it. */
type ProxyDecision =
  | Exclude<ToolEgressDecision, { readonly kind: "allow" }>
  | {
      readonly kind: "allow";
      readonly host: string;
      readonly port: number;
      readonly ruleId: ToolEgressRuleId | undefined;
      /** What allowed it, for a provider runtime's decider. */
      readonly by?: RuntimeEgressAllowedBy;
    };

export interface ToolEgressProposableRefusal {
  readonly host: string;
  readonly port: number;
  readonly reason: "no-rule" | "expired";
}

export type ToolEgressProxyStart =
  | { readonly status: "listening"; readonly proxy: ToolEgressProxy }
  /** The launch must not run: no listener, or no record that it started. */
  | { readonly status: "refused"; readonly reason: "listener-unavailable" | "audit-unavailable" };

export type ToolEgressProxyClose =
  | { readonly status: "summarized"; readonly summary: ThreadEgressLaunchSummarizedPayload }
  /** The summary is not in the journal, so the call reports `unavailable`. */
  | { readonly status: "unavailable" };

export function startToolEgressProxy(
  options: ToolEgressProxyOptions,
): Promise<ToolEgressProxyStart> {
  return ToolEgressProxy.start(options);
}

interface Tally {
  readonly key: string;
  readonly host: string;
  readonly port: number;
  readonly decision: "allowed" | "refused";
  readonly reason: ToolEgressRefusalReason | undefined;
  requests: number;
  bytesSent: number;
  bytesReceived: number;
}

interface Tunnel {
  readonly client: Socket;
  readonly upstream: Duplex;
  readonly host: string;
  readonly port: number;
  /** The checked address the upstream connected to; a private one is decided again on every recheck. */
  readonly address: string;
  readonly tally: Tally;
  expiry: NodeJS.Timeout | undefined;
  closed: boolean;
}

type ProxyFailureStatus = 400 | 403 | 407 | 408 | 431 | 502;

const STATUS_TEXT: Readonly<Record<ProxyFailureStatus, string>> = {
  400: "Bad Request",
  403: "Forbidden",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
};

const PROXY_USER = "octant";
const decodeUtcTimestampOption = Schema.decodeUnknownOption(UtcTimestamp);
const HEAD_END = Buffer.from("\r\n\r\n", "latin1");
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Distinct destinations one launch records by name. Past these, a decision
 * still counts, under one overflow entry per decision and reason, so a
 * command cannot grow the journal or push real destinations out of its
 * summary with junk names. Allowed and refused destinations are capped
 * apart so refusals cannot crowd out what the command actually reached.
 * With one overflow entry for allowed and one per refusal reason (eleven),
 * a summary holds at most 24 + 28 + 12 = 64 entries and is never truncated.
 */
const MAX_ALLOWED_DESTINATIONS = 24;
const MAX_REFUSED_DESTINATIONS = 28;
/** Under the reserved `.invalid` name, which no recorded request can carry. */
const OVERFLOW_DESTINATION = { host: "overflow.invalid", port: 0 } as const;
/**
 * A request without the launch token names nothing the proxy may trust, and
 * anyone on the machine can send one, so every such refusal counts under one
 * entry rather than the host it claimed.
 */
const UNAUTHENTICATED_DESTINATION = { host: "invalid", port: 0 } as const;

export class ToolEgressProxy {
  readonly #options: ToolEgressProxyOptions;
  readonly #limits: ToolEgressProxyLimits;
  readonly #token: string;
  readonly #credentials: Buffer;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #tunnels = new Set<Tunnel>();
  readonly #tallies = new Map<string, Tally>();
  readonly #dirty = new Set<string>();
  /** Dirty entries decided for the first time since the last batch. */
  readonly #fresh = new Set<string>();
  #allowedDestinations = 0;
  #refusedDestinations = 0;
  #endpoint: ToolEgressProxyEndpoint | undefined;
  #directory: string | undefined;
  #pending = 0;
  #bytesSent = 0;
  #bytesReceived = 0;
  #malformedRequests = 0;
  #accepting = false;
  #closed = false;
  #auditUnavailable = false;
  #flushing: Promise<void> | undefined;
  #flushTimer: NodeJS.Timeout | undefined;
  #closing: Promise<ToolEgressProxyClose> | undefined;

  private constructor(options: ToolEgressProxyOptions) {
    this.#options = options;
    this.#limits = { ...TOOL_EGRESS_PROXY_LIMITS, ...options.limits };
    this.#token = randomBytes(32).toString("hex");
    this.#credentials = Buffer.from(`${PROXY_USER}:${this.#token}`, "latin1");
    this.#server = createServer({ allowHalfOpen: true }, (socket) => this.#accept(socket));
  }

  /**
   * Binds the listener, then records that the launch started. A launch whose
   * listener cannot bind, or whose start cannot be recorded, gets no proxy and
   * must refuse before its command runs; it never falls back to open network.
   */
  static async start(options: ToolEgressProxyOptions): Promise<ToolEgressProxyStart> {
    const proxy = new ToolEgressProxy(options);
    if (!(await proxy.#bind())) {
      await proxy.#shutdown();
      return { status: "refused", reason: "listener-unavailable" };
    }
    const startedAt = proxy.#timestamp();
    const started =
      startedAt === undefined
        ? ({ status: "unavailable" } as const)
        : await proxy.#append(() =>
            options.records.launchStarted({
              launch: options.launch,
              startedAt,
              threadTainted: proxy.#facts().threadTainted,
            }),
          );
    if (started.status !== "appended") {
      await proxy.#shutdown();
      return { status: "refused", reason: "audit-unavailable" };
    }
    proxy.#accepting = true;
    proxy.#flushTimer = setInterval(() => proxy.#flush(true), proxy.#limits.flushIntervalMs);
    proxy.#flushTimer.unref();
    return { status: "listening", proxy };
  }

  get endpoint(): ToolEgressProxyEndpoint {
    if (this.#endpoint === undefined) throw new Error("The egress proxy has no endpoint.");
    return this.#endpoint;
  }

  /**
   * The launch token. It goes into the launch's proxy variables, so the
   * command can read it; the host never journals or logs it.
   */
  get token(): string {
    return this.#token;
  }

  /** Decides every open tunnel again now; one whose rule was revoked or expired closes. */
  recheck(): void {
    for (const tunnel of this.#tunnels) this.#recheckTunnel(tunnel);
  }

  /**
   * Ends the launch: the listener and every connection close, and the summary
   * is recorded. The caller returns the tool result only after this settles,
   * and reports `unavailable` when the summary could not be recorded.
   */
  close(): Promise<ToolEgressProxyClose> {
    this.#closing ??= this.#summarize();
    return this.#closing;
  }

  async #summarize(): Promise<ToolEgressProxyClose> {
    await this.#shutdown();
    await this.#flushing;
    const endedAt = this.#timestamp();
    if (endedAt === undefined) return { status: "unavailable" };
    const tallies = [...this.#tallies.values()];
    const summary: ThreadEgressLaunchSummarizedPayload = {
      launch: this.#options.launch,
      endedAt,
      bytesSent: this.#bytesSent,
      bytesReceived: this.#bytesReceived,
      malformedRequests: this.#malformedRequests,
      entries: tallies.slice(0, MAX_TOOL_EGRESS_SUMMARY_ENTRIES).map(decisionEntry),
      truncated: tallies.length > MAX_TOOL_EGRESS_SUMMARY_ENTRIES,
      threadTainted: this.#facts().threadTainted,
    };
    const appended = await this.#append(() => this.#options.records.launchSummarized(summary));
    return appended.status === "appended"
      ? { status: "summarized", summary }
      : { status: "unavailable" };
  }

  async #bind(): Promise<boolean> {
    const request = this.#options.endpoint;
    try {
      if (request.kind === "loopback") {
        await listen(this.#server, { host: "127.0.0.1", port: 0, exclusive: true });
        const address = this.#server.address();
        if (address === null || typeof address !== "object") return false;
        this.#endpoint = { kind: "loopback", host: "127.0.0.1", port: address.port };
        return true;
      }
      this.#directory = mkdtempSync(join(request.parentDirectory, "egress-"));
      chmodSync(this.#directory, 0o700);
      const path = join(this.#directory, "proxy.sock");
      await listen(this.#server, { path, exclusive: true });
      this.#endpoint = { kind: "unix-socket", path };
      return true;
    } catch {
      return false;
    }
  }

  async #shutdown(): Promise<void> {
    this.#accepting = false;
    this.#closed = true;
    if (this.#flushTimer !== undefined) clearInterval(this.#flushTimer);
    for (const tunnel of this.#tunnels) this.#closeTunnel(tunnel);
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
    if (this.#directory !== undefined) rmSync(this.#directory, { recursive: true, force: true });
  }

  #accept(socket: Socket): void {
    socket.on("error", () => socket.destroy());
    // Connections still reading their head count against the limits too, so a
    // command cannot hold the listener open with idle sockets past them.
    if (
      !this.#accepting ||
      this.#sockets.size >= this.#limits.maxTunnels + this.#limits.maxPending
    ) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.setNoDelay(true);

    // One bounded buffer, filled once: a head that trickles in a byte at a
    // time is neither recopied nor rescanned from the start for each byte.
    const received = Buffer.allocUnsafe(this.#limits.maxHeadBytes);
    let length = 0;
    let searchFrom = 0;
    const stop = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.pause();
    };
    const timer = setTimeout(() => {
      stop();
      respond(socket, 408, "octant-egress-refused: request-head-timeout");
    }, this.#limits.headTimeoutMs);
    const onEnd = () => {
      stop();
      socket.destroy();
    };
    const onData = (chunk: Buffer) => {
      const copied = chunk.copy(received, length);
      length += copied;
      const found = received.subarray(0, length).indexOf(HEAD_END, searchFrom);
      if (found === -1 && length < this.#limits.maxHeadBytes) {
        searchFrom = Math.max(0, length - HEAD_END.length + 1);
        return;
      }
      const buffer = Buffer.concat([received.subarray(0, length), chunk.subarray(copied)]);
      stop();
      const read = readProxyRequestHead(buffer, this.#limits.maxHeadBytes);
      switch (read.status) {
        case "incomplete":
        case "too-large":
          this.#malformedRequests += 1;
          respond(socket, 431, "octant-egress-refused: request-head-too-large");
          return;
        case "malformed":
          this.#malformedRequests += 1;
          respond(socket, 400, `octant-egress-refused: malformed-request (${read.detail})`);
          return;
        case "read":
          // A failure the proxy did not foresee shuts the connection; it never
          // escapes as an unhandled rejection or leaves the request half-decided.
          this.#handle(socket, read.head, buffer.subarray(read.headBytes)).catch(() =>
            socket.destroy(),
          );
      }
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
  }

  /**
   * Token, then destination syntax and the rule match (one decision), then
   * resolution, then the private check on every answer, then connect.
   */
  async #handle(socket: Socket, head: ProxyRequestHead, leftover: Buffer): Promise<void> {
    if (
      this.#options.authentication !== "none" &&
      !this.#tokenMatches(fieldValue(head.headers, "proxy-authorization"))
    ) {
      this.#refuse(socket, "token", UNAUTHENTICATED_DESTINATION);
      return;
    }
    const requested = { host: recordedHost(head.host), port: recordedPort(head.port) };
    if (this.#auditUnavailable) {
      this.#refuse(socket, "audit-unavailable", requested);
      return;
    }
    const port = destinationPort(head.port);
    let decision = this.#decide(head.host, port);
    if (decision.kind === "refuse" && "host" in decision) {
      decision = await this.#escalate(decision, head.host, port);
      if (this.#closed) {
        socket.destroy();
        return;
      }
    }
    if (decision.kind === "refuse") {
      this.#refuse(
        socket,
        decision.reason,
        "host" in decision ? { host: decision.host, port: decision.port } : requested,
      );
      return;
    }
    const destination = { host: decision.host, port: decision.port };
    // A pending request holds a tunnel slot too, so the tunnels it becomes stay within the limit.
    if (
      this.#tunnels.size + this.#pending >= this.#limits.maxTunnels ||
      this.#pending >= this.#limits.maxPending
    ) {
      this.#refuse(socket, "limit", destination);
      return;
    }

    this.#pending += 1;
    const connected = await this.#open(socket, destination).finally(() => {
      this.#pending -= 1;
    });
    if (connected === undefined) return;
    const { upstream, address, tally, ruleId } = connected;

    const tunnel: Tunnel = {
      client: socket,
      upstream,
      host: destination.host,
      port: destination.port,
      address,
      tally,
      expiry: undefined,
      closed: false,
    };
    try {
      this.#openTunnel(tunnel, head, leftover, ruleId);
    } catch {
      this.#closeTunnel(tunnel);
    }
  }

  #openTunnel(
    tunnel: Tunnel,
    head: ProxyRequestHead,
    leftover: Buffer,
    ruleId: ToolEgressRuleId | undefined,
  ): void {
    const { client: socket, upstream } = tunnel;
    this.#tunnels.add(tunnel);
    this.#scheduleExpiry(tunnel, ruleId);
    upstream.on("error", () => this.#closeTunnel(tunnel));
    socket.on("error", () => this.#closeTunnel(tunnel));
    socket.once("close", () => this.#endTunnel(tunnel));
    upstream.once("close", () => this.#endTunnel(tunnel));
    this.#relay(tunnel, upstream, socket, "received");

    if (head.kind === "connect") {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      this.#relayClientHello(tunnel, leftover);
    } else {
      this.#forwardRequest(tunnel, head, leftover);
    }
    socket.resume();
  }

  /**
   * Resolves, refuses when any answer is private, decides again (a rule may
   * have expired or been revoked while the name resolved), and connects to an
   * address it checked. Answers the client itself on every path that does not
   * return a connection.
   */
  async #open(
    socket: Socket,
    destination: { readonly host: string; readonly port: number },
  ): Promise<
    | {
        readonly upstream: Duplex;
        readonly address: string;
        readonly tally: Tally;
        readonly ruleId: ToolEgressRuleId | undefined;
      }
    | undefined
  > {
    const addresses = await this.#resolve(destination.host);
    if (this.#closed) {
      socket.destroy();
      return undefined;
    }
    if (addresses === undefined || addresses.length === 0) {
      this.#refuse(socket, "resolve-failed", destination);
      return undefined;
    }
    const current = this.#decide(destination.host, destination.port);
    if (current.kind === "refuse") {
      this.#refuse(socket, current.reason, destination);
      return undefined;
    }
    // A private answer passes only where the person trusted that place or a
    // runtime's launch serves that loopback port; every other private,
    // loopback, and link-local answer refuses, whatever rule named the host.
    if (
      addresses.some(
        (address) =>
          isPrivateAddress(address) &&
          !this.#privateAddressAllowed(address, destination.port, current.by),
      )
    ) {
      this.#refuse(socket, "private-destination", destination);
      return undefined;
    }
    const tally = this.#count({ ...destination, decision: "allowed" }, { requests: 1 });
    const connected = await this.#connect(addresses, destination.port);
    if (connected === undefined || this.#closed) {
      connected?.socket.destroy();
      respond(
        socket,
        502,
        `octant-egress-failed: connect ${destination.host}:${String(destination.port)}`,
      );
      return undefined;
    }
    return {
      upstream: connected.socket,
      address: connected.address,
      tally,
      ruleId: current.ruleId,
    };
  }

  /**
   * Forwards one request: its head and exactly the content its framing
   * declares. Bytes after that are dropped, because a second request on the
   * same connection would reach the origin undecided, under whatever `Host`
   * it named. Content that does not frame the way its head said shuts the
   * connection.
   */
  #forwardRequest(
    tunnel: Tunnel,
    head: Extract<ProxyRequestHead, { kind: "forward" }>,
    leftover: Buffer,
  ): void {
    const content = new RequestContent(head);
    let complete = content.empty;
    const take = (chunk: Buffer): Buffer | undefined => {
      if (complete || chunk.length === 0) return Buffer.alloc(0);
      const read = content.read(chunk);
      if (read.status === "malformed") return undefined;
      if (read.status === "more") return chunk;
      complete = true;
      return chunk.subarray(0, read.length);
    };
    const first = take(leftover);
    if (first === undefined) {
      this.#closeTunnel(tunnel);
      return;
    }
    this.#send(tunnel, Buffer.concat([forwardedRequestHead(head), first]));
    tunnel.client.on(
      "data",
      this.#guarded(tunnel, (chunk: Buffer) => {
        const part = take(chunk);
        if (part === undefined) {
          this.#closeTunnel(tunnel);
          return;
        }
        this.#send(tunnel, part);
      }),
    );
    tunnel.client.on("end", () => tunnel.upstream.end());
  }

  /**
   * Holds the tunnel's first client bytes until they show whether they are a
   * TLS ClientHello. One that names a server other than the `CONNECT` host,
   * or that cannot be read to the end, closes the tunnel before a byte of it
   * reaches the destination; bytes that are not TLS pass.
   */
  #relayClientHello(tunnel: Tunnel, leftover: Buffer): void {
    // Held bytes are joined only once they can complete the next record, so
    // a hello that trickles in is not recopied for every byte.
    const held: Buffer[] = leftover.length > 0 ? [leftover] : [];
    let heldBytes = leftover.length;
    let needed = 1;
    let checked = false;
    const onData = this.#guarded(tunnel, (chunk: Buffer) => {
      if (checked) return;
      held.push(chunk);
      heldBytes += chunk.length;
      inspect();
    });
    const inspect = () => {
      if (heldBytes < needed) return;
      const buffer = Buffer.concat(held, heldBytes);
      held.splice(0, held.length, buffer);
      const read = readClientHelloServerName(buffer, this.#limits.maxClientHelloBytes);
      if (read.status === "incomplete") {
        needed = read.needed;
        return;
      }
      checked = true;
      tunnel.client.off("data", onData);
      tunnel.client.off("end", onEnd);
      const serverName = read.status === "read" ? read.serverName : undefined;
      const named = serverName === undefined ? undefined : canonicalToolEgressHost(serverName);
      // A name no rule could hold (`localhost`, which only a provider
      // runtime's trusted loopback reaches) must still be the tunnel's own.
      const sameHost =
        named === undefined ||
        (named.kind === "name"
          ? named.host === tunnel.host
          : serverName?.toLowerCase().replace(/\.$/, "") === tunnel.host);
      if (read.status === "unreadable" || !sameHost) {
        this.#count(
          { host: tunnel.host, port: tunnel.port, decision: "refused", reason: "sni-mismatch" },
          { requests: 1 },
        );
        this.#closeTunnel(tunnel);
        return;
      }
      this.#send(tunnel, buffer);
      this.#relay(tunnel, tunnel.client, tunnel.upstream, "sent");
    };
    const onEnd = () => {
      if (checked) return;
      checked = true;
      tunnel.client.off("data", onData);
      if (heldBytes > 0) {
        this.#count(
          { host: tunnel.host, port: tunnel.port, decision: "refused", reason: "sni-mismatch" },
          { requests: 1 },
        );
        this.#closeTunnel(tunnel);
        return;
      }
      tunnel.upstream.end();
    };
    tunnel.client.on("data", onData);
    tunnel.client.on("end", onEnd);
    if (heldBytes > 0) inspect();
  }

  #relay(tunnel: Tunnel, from: Duplex, to: Duplex, direction: "sent" | "received"): void {
    from.on(
      "data",
      this.#guarded(tunnel, (chunk: Buffer) => {
        if (direction === "sent") {
          this.#send(tunnel, chunk);
          return;
        }
        if (!this.#recheckTunnel(tunnel)) return;
        this.#addBytes(tunnel.tally, 0, chunk.length);
        if (!to.write(chunk)) {
          from.pause();
          to.once("drain", () => from.resume());
        }
      }),
    );
    from.on("end", () => to.end());
  }

  #send(tunnel: Tunnel, chunk: Buffer): void {
    if (chunk.length === 0 || !this.#recheckTunnel(tunnel)) return;
    this.#addBytes(tunnel.tally, chunk.length, 0);
    if (!tunnel.upstream.write(chunk)) {
      tunnel.client.pause();
      tunnel.upstream.once("drain", () => tunnel.client.resume());
    }
  }

  /** Decides an open tunnel's destination again; one no live rule allows closes now. */
  #recheckTunnel(tunnel: Tunnel): boolean {
    if (tunnel.closed) return false;
    if (this.#closed) {
      this.#closeTunnel(tunnel);
      return false;
    }
    const decision = this.#decide(tunnel.host, tunnel.port);
    // A tunnel to a private address stays only while what let that address
    // through still does: a person who stops trusting the network it is on
    // closes the tunnel, whatever the name's allowance says.
    const reason =
      decision.kind === "refuse"
        ? decision.reason
        : isPrivateAddress(tunnel.address) &&
            !this.#privateAddressAllowed(tunnel.address, tunnel.port, decision.by)
          ? "private-destination"
          : undefined;
    if (reason === undefined) return true;
    this.#count(
      { host: tunnel.host, port: tunnel.port, decision: "refused", reason },
      { requests: 1 },
    );
    this.#closeTunnel(tunnel);
    return false;
  }

  /**
   * Wakes an idle tunnel at its rule's expiry; the per-chunk decision stays
   * the authority. An allowance no rule made has no expiry to wake for.
   */
  #scheduleExpiry(tunnel: Tunnel, ruleId: ToolEgressRuleId | undefined): void {
    if (ruleId === undefined) return;
    const rule = this.#rules().find((candidate) => String(candidate.id) === String(ruleId));
    const remaining = rule === undefined ? 0 : Date.parse(rule.expiresAt) - Date.parse(this.#now());
    const delay = Number.isFinite(remaining) ? Math.min(Math.max(remaining, 0), MAX_TIMER_MS) : 0;
    tunnel.expiry = setTimeout(
      this.#guarded(tunnel, () => {
        if (!this.#recheckTunnel(tunnel)) return;
        const decision = this.#decide(tunnel.host, tunnel.port);
        if (decision.kind === "allow") this.#scheduleExpiry(tunnel, decision.ruleId);
      }),
      delay,
    );
    tunnel.expiry.unref();
  }

  /**
   * Runs a tunnel's event handler so that anything it throws shuts the
   * tunnel. An exception escaping a socket or timer callback would otherwise
   * take down the server, or leave the tunnel relaying undecided bytes.
   */
  #guarded<A extends ReadonlyArray<unknown>>(
    tunnel: Tunnel,
    handler: (...args: A) => void,
  ): (...args: A) => void {
    return (...args) => {
      try {
        handler(...args);
      } catch {
        this.#closeTunnel(tunnel);
      }
    };
  }

  /** A policy close: both sides go at once, nothing buffered is delivered. */
  #closeTunnel(tunnel: Tunnel): void {
    if (!tunnel.closed) {
      tunnel.closed = true;
      if (tunnel.expiry !== undefined) clearTimeout(tunnel.expiry);
      this.#tunnels.delete(tunnel);
    }
    tunnel.client.destroy();
    tunnel.upstream.destroy();
  }

  /** One side closed on its own; the other finishes what it was sending, then closes. */
  #endTunnel(tunnel: Tunnel): void {
    if (tunnel.closed) return;
    tunnel.closed = true;
    if (tunnel.expiry !== undefined) clearTimeout(tunnel.expiry);
    this.#tunnels.delete(tunnel);
    for (const socket of [tunnel.client, tunnel.upstream]) {
      if (!socket.destroyed) socket.end(() => socket.destroy());
    }
  }

  #runtimeDecider(): ProviderRuntimeEgressDecider | undefined {
    const decision = this.#options.decision;
    return decision === undefined || decision === "tool-rules" ? undefined : decision;
  }

  #privateAddressAllowed(
    address: string,
    port: number,
    by: RuntimeEgressAllowedBy | undefined,
  ): boolean {
    const runtime = this.#runtimeDecider();
    try {
      if (runtime !== undefined) {
        return by !== undefined && runtime.privateAddressAllowed({ address, port, by });
      }
      // A harness command reaches a private address only through a place:
      // a name the person trusted, or a rule's host whose answer lies in a
      // trusted range or tag. Its thread has no loopback ports of its own.
      return runtimeEgressPrivateAddressAllowed({
        address,
        port,
        by: by ?? "project-rule",
        places: this.#places(),
        launchLoopbackPorts: [],
      });
    } catch {
      return false;
    }
  }

  /** The places a harness command's rules fall back to; none while either thread is tainted. */
  #places(): ReadonlyArray<SafeNetworkPlace> {
    const places = this.#options.places;
    if (places === undefined) return [];
    try {
      const taint = this.#options.taint();
      return taint.threadTainted || taint.parentTainted ? [] : places();
    } catch {
      return [];
    }
  }

  /**
   * Gives the reviewer hook one chance at an unlisted host, then decides
   * again. A harness command's refusals that still stand go to learn mode.
   */
  async #escalate(refused: ProxyDecision, host: string, port: number): Promise<ProxyDecision> {
    const runtime = this.#runtimeDecider();
    const escalate = runtime === undefined ? this.#options.escalate : runtime.escalate;
    if (escalate === undefined || refused.kind !== "refuse" || !("host" in refused)) return refused;
    if (this.#pending >= this.#limits.maxPending) return refused;
    this.#pending += 1;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        escalate({ host: refused.host, port: refused.port }).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#limits.escalateTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.#pending -= 1;
    }
    return this.#decide(host, port);
  }

  #decide(host: string, port: number): ProxyDecision {
    const runtime = this.#runtimeDecider();
    if (runtime !== undefined) {
      let decision: RuntimeEgressDecision;
      try {
        decision = runtime.decide({ host, port });
      } catch {
        // A decider that throws allows nothing.
        return { kind: "refuse", reason: "invalid-name" };
      }
      if (decision.kind === "refuse") return decision;
      return {
        kind: "allow",
        host: decision.host,
        port: decision.port,
        ruleId: decision.ruleId,
        by: decision.by,
      };
    }
    const decision = decideToolEgress({
      launch: this.#facts(),
      destination: { host, port },
      rules: this.#rules(),
      now: this.#now(),
    });
    const placed = safeNetworkPlaceAllows({ host, port }, this.#places());
    // A place the person named keeps its trust when a rule also matches, so
    // adding a rule never takes away a private answer the place let through.
    if (decision.kind === "allow")
      return placed === undefined ? decision : { ...decision, by: "place" };
    return placed === undefined
      ? decision
      : { kind: "allow", host: placed.host, port: placed.port, ruleId: undefined, by: "place" };
  }

  /**
   * The clock as the decision reads it. A clock that throws reads as no time
   * at all, which the decision treats as expired, never as live.
   */
  #now(): string {
    try {
      return this.#options.clock();
    } catch {
      return "";
    }
  }

  /** A journal timestamp, or `undefined` when the clock cannot give one. */
  #timestamp(): UtcTimestamp | undefined {
    return Option.getOrUndefined(decodeUtcTimestampOption(this.#now()));
  }

  /**
   * An append that throws, rejects, or does not answer in time is
   * `unavailable`, so a hung journal cannot hold a batch in flight forever
   * (requests flowing unrecorded) or hold the launch's close.
   */
  async #append(append: () => Promise<ToolEgressRecordAppend>): Promise<ToolEgressRecordAppend> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        append(),
        new Promise<ToolEgressRecordAppend>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "unavailable" }),
            this.#limits.recordTimeoutMs,
          );
        }),
      ]);
    } catch {
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  #facts(): ToolEgressLaunchFacts {
    const launch = this.#options.launch;
    let taint: { readonly threadTainted: boolean; readonly parentTainted: boolean };
    try {
      taint = this.#options.taint();
    } catch {
      taint = { threadTainted: true, parentTainted: true };
    }
    return {
      launchId: launch.launchId,
      threadId: launch.threadId,
      projectId: launch.projectId,
      threadTainted: taint.threadTainted,
      ...(launch.parentThreadId === undefined
        ? {}
        : { parent: { threadId: launch.parentThreadId, tainted: taint.parentTainted } }),
    };
  }

  #rules(): ReadonlyArray<ToolEgressRule> {
    try {
      return this.#options.rules();
    } catch {
      return [];
    }
  }

  #tokenMatches(authorization: string | undefined): boolean {
    const match = /^basic +([A-Za-z0-9+/]+={0,2})$/i.exec(authorization ?? "");
    if (match === null) return false;
    const presented = Buffer.from(match[1] ?? "", "base64");
    return (
      presented.length === this.#credentials.length && timingSafeEqual(presented, this.#credentials)
    );
  }

  async #resolve(host: string): Promise<ReadonlyArray<string> | undefined> {
    const resolveAll = this.#options.resolveAll ?? defaultResolveAll;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answers = await Promise.race([
        resolveAll(host),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.#limits.resolveTimeoutMs);
        }),
      ]);
      return answers === undefined ? undefined : answers.map(String);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tries each checked address in turn; the socket never resolves a name itself. */
  async #connect(
    addresses: ReadonlyArray<string>,
    port: number,
  ): Promise<{ readonly socket: Duplex; readonly address: string } | undefined> {
    const dial = this.#options.connect ?? defaultConnect;
    for (const address of addresses) {
      if (this.#closed) return undefined;
      let socket: Duplex;
      try {
        socket = dial({ address, port });
      } catch {
        continue;
      }
      socket.on("error", () => socket.destroy());
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, this.#limits.connectTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (connected) {
        if (socket instanceof Socket) socket.setNoDelay(true);
        return { socket, address };
      }
    }
    return undefined;
  }

  #refuse(
    socket: Socket,
    reason: ToolEgressRefusalReason,
    destination: { readonly host: string; readonly port: number },
  ): void {
    this.#count({ ...destination, decision: "refused", reason }, { requests: 1 });
    if (reason === "no-rule" || reason === "expired") this.#propose({ ...destination, reason });
    if (reason === "token") {
      respond(
        socket,
        407,
        "octant-egress-refused: token",
        'Proxy-Authenticate: Basic realm="octant"',
      );
      return;
    }
    respond(
      socket,
      403,
      `octant-egress-refused: ${reason} ${destination.host}:${String(destination.port)}`,
    );
  }

  #propose(refusal: ToolEgressProposableRefusal): void {
    try {
      this.#options.onProposable?.(refusal);
    } catch {
      // A proposal is a suggestion for a person; failing to note one changes nothing here.
    }
  }

  #count(
    entry: {
      readonly host: string;
      readonly port: number;
      readonly decision: "allowed" | "refused";
      readonly reason?: ToolEgressRefusalReason;
    },
    change: { readonly requests: number },
  ): Tally {
    const keyOf = (host: string, port: number) =>
      `${entry.decision} ${entry.reason ?? ""} ${host} ${String(port)}`;
    let key = keyOf(entry.host, entry.port);
    let tally = this.#tallies.get(key);
    if (tally === undefined) {
      const allowed = entry.decision === "allowed";
      const full = allowed
        ? this.#allowedDestinations >= MAX_ALLOWED_DESTINATIONS
        : this.#refusedDestinations >= MAX_REFUSED_DESTINATIONS;
      const destination = full ? OVERFLOW_DESTINATION : entry;
      key = keyOf(destination.host, destination.port);
      tally = this.#tallies.get(key);
      if (tally === undefined) {
        tally = {
          key,
          host: destination.host,
          port: destination.port,
          decision: entry.decision,
          reason: entry.reason,
          requests: 0,
          bytesSent: 0,
          bytesReceived: 0,
        };
        this.#tallies.set(key, tally);
        this.#fresh.add(key);
        if (!full && allowed) this.#allowedDestinations += 1;
        if (!full && !allowed) this.#refusedDestinations += 1;
      }
    }
    tally.requests += change.requests;
    this.#markDirty(tally);
    return tally;
  }

  #addBytes(tally: Tally, sent: number, received: number): void {
    tally.bytesSent += sent;
    tally.bytesReceived += received;
    this.#bytesSent += sent;
    this.#bytesReceived += received;
    this.#markDirty(tally);
  }

  #markDirty(tally: Tally): void {
    this.#dirty.add(tally.key);
    this.#flush(false);
  }

  /**
   * Records once 16 entries are decided for the first time, and every changed
   * entry on the interval. Count changes wait for the interval, so with at
   * most 64 entries a launch writes at most four batches beyond one per
   * interval, however many requests it makes. A batch that cannot be recorded
   * stops new requests (`audit-unavailable`); tunnels already open run to
   * their end.
   */
  #flush(onInterval: boolean): void {
    if (this.#flushing !== undefined || this.#auditUnavailable || this.#dirty.size === 0) return;
    if (!onInterval && this.#fresh.size < MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES) return;
    this.#flushing = this.#writeBatches().finally(() => {
      this.#flushing = undefined;
    });
  }

  async #writeBatches(): Promise<void> {
    do {
      // First decisions go first, so a batch triggered by them carries them.
      const keys = [...new Set([...this.#fresh, ...this.#dirty])].slice(
        0,
        MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES,
      );
      for (const key of keys) {
        this.#dirty.delete(key);
        this.#fresh.delete(key);
      }
      const entries = keys.flatMap((key) => {
        const tally = this.#tallies.get(key);
        return tally === undefined ? [] : [decisionEntry(tally)];
      });
      if (entries.length === 0) return;
      const appended = await this.#append(() =>
        this.#options.records.decisionsRecorded({
          launch: this.#options.launch,
          entries,
          threadTainted: this.#facts().threadTainted,
        }),
      );
      if (appended.status !== "appended") {
        this.#auditUnavailable = true;
        return;
      }
    } while (this.#fresh.size >= MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES);
  }
}

function decisionEntry(tally: Tally): ToolEgressDecisionEntry {
  if (tally.decision === "allowed" || tally.reason === undefined) {
    return {
      host: tally.host,
      port: tally.port,
      decision: "allowed",
      requests: tally.requests,
      bytesSent: tally.bytesSent,
      bytesReceived: tally.bytesReceived,
    };
  }
  return {
    host: tally.host,
    port: tally.port,
    decision: "refused",
    reason: tally.reason,
    requests: tally.requests,
  };
}

function listen(
  server: Server,
  options: {
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
    readonly exclusive: boolean;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function defaultConnect(destination: { readonly address: string; readonly port: number }): Socket {
  return netConnect({
    host: destination.address,
    port: destination.port,
    allowHalfOpen: true,
    // The address was checked already; a lookup here could answer differently.
    lookup: (_hostname, _options, callback) =>
      callback(new Error("egress-proxy-never-resolves-at-connect"), "", 0),
  });
}

function respond(
  socket: Socket,
  status: ProxyFailureStatus,
  line: string,
  extraHeader?: string,
): void {
  const body = `${line}\n`;
  const head = [
    `HTTP/1.1 ${String(status)} ${STATUS_TEXT[status]}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "Connection: close",
    ...(extraHeader === undefined ? [] : [extraHeader]),
    "",
    "",
  ].join("\r\n");
  if (socket.destroyed) return;
  socket.end(`${head}${body}`, () => socket.destroy());
}

function destinationPort(raw: string): number {
  return /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * The destination a refusal record names. It never carries a path, query,
 * credentials, or anything that is not host syntax; a name that cannot be
 * recorded as written is recorded as `invalid`, a reserved name that never
 * resolves.
 */
function recordedHost(raw: string): string {
  const host = raw
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  // Names under `.invalid` are the proxy's own markers; a request never writes one.
  if (host === "invalid" || host.endsWith(".invalid")) return "invalid";
  return /^[a-z0-9._:-]{1,253}$/.test(host) ? host : "invalid";
}

function recordedPort(raw: string): number {
  return /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
}
