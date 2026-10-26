import {
  decodeProviderProbeResult,
  type ProviderFailure,
  type ProviderFailureCategory,
  type ProviderInstanceId,
  type ProviderModel,
  type ProviderModelId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  decodeOutsideDriverFailureData,
  decodeOutsideDriverInitializeResult,
  decodeOutsideDriverProbeResult,
  decodeOutsideDriverSessionOpenResult,
  decodeOutsideDriverSessionSendResult,
  decodeOutsideDriverToHostMessage,
  HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
  OUTSIDE_DRIVER_METHODS,
  type OutsideDriverCapabilityClaims,
  type OutsideDriverHttpRequestParams,
  type OutsideDriverMessageId,
  type OutsideDriverRequest,
  type OutsideDriverStreamEvent,
  type OutsideDriverUsage,
} from "@octant/contracts/outside-driver-protocol";
import { normalizeOpenAiCompatibleBaseUrl } from "@octant/domain";
import { validateChatTurnInput } from "@octant/provider-sdk/chat-conformance";
import type {
  HarnessEndpointDriver,
  HarnessEndpointRequest,
  HarnessEndpointResponse,
  HarnessEndpointSession,
  HarnessEndpointStreamEvent,
  HarnessEndpointUsage,
} from "@octant/provider-sdk/harness-endpoint";
import { Effect } from "effect";
import { CONTEXT_OVERFLOW_FAILURE_MESSAGE } from "./contextOverflowRefusal";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { carryModelContextWindowFacts } from "./modelContextWindowFacts";
import { clampOutsideDriverCapabilities } from "./outsideDriverCeiling";
import { acquireProviderCredential, reportKeyRejection } from "./providerApiKeyPool";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * The host side of an outside provider driver: a `HarnessEndpointDriver` whose
 * every call crosses a line-delimited JSON-RPC channel to the driver's own
 * process, so `runOnNativeHarness` runs an outside driver exactly as it runs a
 * bundled endpoint.
 *
 * The driver is untrusted. Every line it writes is size-capped and decoded; an
 * unreadable or unexpected one stops it and leaves the instance `incompatible`
 * with a closed reason. Every failure that leaves this module is one Octant
 * wrote: a driver's own words never reach the provider service or a client.
 * Its probe claims are clamped to the family's ceiling, `admitTurn` and `fits`
 * are decided here from host-held facts, a cancel or release is answered by
 * the host without waiting on the driver, and the brokered `http/request` is
 * its only egress: this instance's key, leased by the host, sent only to the
 * instance's configured origin.
 */

/** One driver's stdin and stdout, as lines. */
export interface OutsideDriverChannel {
  /** Writes one line to the driver. */
  readonly write: (line: string) => void;
  /** Receives each line the driver writes, in order, until the channel stops. */
  readonly onLine: (listener: (line: string) => void) => void;
  /** Stops the driver; no line crosses either way afterwards. */
  readonly stop: () => void;
}

export interface OutsideDriverLimits {
  /** The largest line a driver may write. */
  readonly messageBytes: number;
  /** How long `initialize`, `probe`, and `session/open` may take. */
  readonly callTimeoutMs: number;
  /** How long one `session/send` may take. */
  readonly sendTimeoutMs: number;
  /** Brokered requests one instance may have in flight. */
  readonly httpConcurrency: number;
  readonly httpConnectionTimeoutMs: number;
  readonly httpIdleTimeoutMs: number;
  readonly httpResponseBytes: number;
}

const DEFAULT_LIMITS: OutsideDriverLimits = {
  messageBytes: 4_194_304,
  callTimeoutMs: 30_000,
  sendTimeoutMs: 600_000,
  httpConcurrency: 8,
  httpConnectionTimeoutMs: 10_000,
  httpIdleTimeoutMs: 120_000,
  httpResponseBytes: 16_777_216,
};

export type OutsideDriverFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OutsideHarnessEndpointProxyOptions {
  readonly instanceId: ProviderInstanceId;
  readonly channel: OutsideDriverChannel;
  /** The address the person configured; a brokered request reaches only its origin. */
  readonly baseUrl: string;
  /** The models the person listed; the instance offers no other. */
  readonly modelIds: ReadonlyArray<ProviderModelId>;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: OutsideDriverFetch;
  readonly limits?: Partial<OutsideDriverLimits>;
  readonly clock?: () => string;
}

// ── closed failures ────────────────────────────────────────────────────────

/** Failures this module wrote. Anything else that reaches a caller is replaced. */
const authored = new WeakSet<object>();

function failure(
  category: ProviderFailureCategory,
  message: string,
  extra: Pick<ProviderFailure, "reason" | "retryAfterMs"> = {},
): ProviderFailure {
  const value: ProviderFailure = { category, message, ...extra };
  authored.add(value);
  return value;
}

/** The only failures that leave the proxy: ones it wrote, or a fixed protocol failure. */
function closed(error: unknown): ProviderFailure {
  return typeof error === "object" && error !== null && authored.has(error)
    ? (error as ProviderFailure)
    : failure("protocol", "The provider driver returned an invalid response.");
}

/** Octant's words for each category a driver may report; its own text is never kept. */
const DRIVER_FAILURE_MESSAGES: Readonly<Record<ProviderFailureCategory, string>> = {
  unavailable: "The provider endpoint is unavailable.",
  unauthenticated: "The provider refused the credential.",
  incompatible: "The provider endpoint is incompatible with this driver.",
  unsupported: "The provider does not support this request.",
  unauthorized: "The provider denied this request.",
  interrupted: "The provider request was cancelled.",
  "stale-resume": "The provider session state is stale.",
  "invalid-configuration": "The provider configuration is invalid.",
  protocol: "The provider driver returned an invalid response.",
  "rate-limited": "The provider is limiting requests.",
  "provider-failed": "The provider request failed.",
};

const driverStopped = () =>
  failure(
    "incompatible",
    "The provider driver sent a message Octant could not read, so Octant stopped it.",
    { reason: "driver-incompatible" },
  );
const noAgreedProtocol = () =>
  failure("incompatible", "The provider driver does not speak a protocol version Octant speaks.", {
    reason: "driver-incompatible",
  });
const interrupted = () => failure("interrupted", "The provider request was cancelled.");
const notAnswered = () => failure("unavailable", "The provider driver did not answer in time.");

/** The failure a driver's JSON-RPC error becomes: its structure, Octant's words. */
function failureFromDriver(data: unknown): ProviderFailure {
  const decoded = decodeOutsideDriverFailureData(data);
  if (decoded._tag === "Left") {
    return failure("protocol", "The provider driver returned an invalid response.");
  }
  const { category, retryAfterMs, contextOverflow } = decoded.right;
  // The host learns a model's window from the overflow sentence it reads back,
  // so the driver's structured window becomes Octant's own sentence.
  if (contextOverflow !== undefined) {
    const window = contextOverflow.contextWindowTokens;
    return failure(
      "provider-failed",
      window === undefined
        ? CONTEXT_OVERFLOW_FAILURE_MESSAGE
        : `The provider rejected the request because it exceeded the model's context length of ${window} tokens.`,
    );
  }
  return failure(
    category,
    DRIVER_FAILURE_MESSAGES[category],
    retryAfterMs === undefined ? {} : { retryAfterMs },
  );
}

// ── the channel ────────────────────────────────────────────────────────────

interface PendingCall {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (failure: ProviderFailure) => void;
  readonly onEvent: ((event: OutsideDriverStreamEvent) => void) | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
}

type BrokeredRequest = (
  params: OutsideDriverHttpRequestParams,
  signal: AbortSignal,
) => Promise<Response>;

/**
 * The JSON-RPC conversation with one driver. It numbers the host's calls,
 * holds what is pending, answers the driver's `http/request` through the
 * broker, and stops the driver at the first message it cannot read.
 */
class OutsideDriverLink {
  readonly #channel: OutsideDriverChannel;
  readonly #limits: OutsideDriverLimits;
  readonly #broker: BrokeredRequest;
  readonly #onStopped: (failure: ProviderFailure) => void;
  readonly #pending = new Map<number, PendingCall>();
  readonly #http = new Map<number, AbortController>();
  #nextId = 1;
  #stopped: ProviderFailure | undefined;

  constructor(input: {
    readonly channel: OutsideDriverChannel;
    readonly limits: OutsideDriverLimits;
    readonly broker: BrokeredRequest;
    readonly onStopped: (failure: ProviderFailure) => void;
  }) {
    this.#channel = input.channel;
    this.#limits = input.limits;
    this.#broker = input.broker;
    this.#onStopped = input.onStopped;
    input.channel.onLine((line) => this.#receive(line));
  }

  get stopped(): ProviderFailure | undefined {
    return this.#stopped;
  }

  /** Sends one call and settles with its raw result, or with a closed failure. */
  call(
    method: string,
    params: unknown,
    options: {
      readonly timeoutMs: number;
      readonly onEvent?: (event: OutsideDriverStreamEvent) => void;
    },
  ): { readonly id: number; readonly settled: Promise<unknown> } {
    const id = this.#nextId;
    this.#nextId += 1;
    const settled = new Promise<unknown>((resolve, reject) => {
      if (this.#stopped !== undefined) {
        reject(this.#stopped);
        return;
      }
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        if (method === OUTSIDE_DRIVER_METHODS.sessionSend) {
          this.notify(OUTSIDE_DRIVER_METHODS.sessionCancel, { requestId: id });
        }
        reject(notAnswered());
      }, options.timeoutMs);
      this.#pending.set(id, { method, resolve, reject, onEvent: options.onEvent, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
    return { id, settled };
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Answers a pending send as interrupted at once and tells the driver; a
   * late answer from the driver is then ignored.
   */
  cancel(id: number): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(interrupted());
    this.notify(OUTSIDE_DRIVER_METHODS.sessionCancel, { requestId: id });
  }

  /** Stops the driver: every pending call and brokered request ends with `failure`. */
  stop(reason: ProviderFailure): void {
    if (this.#stopped !== undefined) return;
    this.#stopped = reason;
    this.#channel.stop();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    for (const controller of this.#http.values()) controller.abort();
    this.#http.clear();
    this.#onStopped(reason);
  }

  #write(message: unknown): void {
    if (this.#stopped !== undefined) return;
    this.#channel.write(JSON.stringify(message));
  }

  #violate(): void {
    this.stop(driverStopped());
  }

  #receive(line: string): void {
    if (this.#stopped !== undefined) return;
    if (Buffer.byteLength(line, "utf8") > this.#limits.messageBytes) return this.#violate();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.#violate();
    }
    const decoded = decodeOutsideDriverToHostMessage(parsed);
    if (decoded._tag === "Left") return this.#violate();
    const message = decoded.right;
    if ("result" in message || "error" in message) {
      // An id the host never issued is not a late answer; it is a forgery.
      if (message.id >= this.#nextId) return this.#violate();
      const pending = this.#pending.get(message.id);
      // A call the host already answered (cancelled, timed out) takes no late reply.
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("result" in message) pending.resolve(message.result);
      else pending.reject(failureFromDriver(message.error.data));
      return;
    }
    if (message.method === OUTSIDE_DRIVER_METHODS.sessionEvent) {
      const { requestId, event } = message.params;
      if (requestId >= this.#nextId) return this.#violate();
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return;
      if (pending.onEvent === undefined) return this.#violate();
      pending.onEvent(event);
      return;
    }
    this.#serveHttp(message.id, message.params);
  }

  #serveHttp(httpId: OutsideDriverMessageId, params: OutsideDriverHttpRequestParams): void {
    if (this.#http.has(httpId)) return this.#violate();
    if (this.#http.size >= this.#limits.httpConcurrency) {
      this.#refuseHttp(httpId, failure("rate-limited", "Too many provider requests are open."));
      return;
    }
    const controller = new AbortController();
    this.#http.set(httpId, controller);
    void this.#relayHttp(httpId, params, controller).finally(() => {
      if (this.#http.get(httpId) === controller) this.#http.delete(httpId);
    });
  }

  async #relayHttp(
    httpId: OutsideDriverMessageId,
    params: OutsideDriverHttpRequestParams,
    controller: AbortController,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.#broker(params, controller.signal);
    } catch (error) {
      this.#refuseHttp(httpId, closed(error));
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id: httpId,
      result: { status: response.status, headers: relayedHeaders(response.headers, params) },
    });
    const outcome = await this.#relayBody(httpId, response, controller.signal);
    this.notify(
      OUTSIDE_DRIVER_METHODS.httpEnd,
      outcome === undefined
        ? { httpId, outcome: "complete" }
        : { httpId, outcome: "failed", category: outcome.category },
    );
  }

  /** Streams the body as text in bounded chunks; the failure that cut it short, if any. */
  async #relayBody(
    httpId: OutsideDriverMessageId,
    response: Response,
    signal: AbortSignal,
  ): Promise<ProviderFailure | undefined> {
    if (response.body === null) return undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    const chunkCharacters = Math.max(1, Math.floor(this.#limits.messageBytes / 8));
    try {
      for (;;) {
        if (signal.aborted) return interrupted();
        const read = await readWithin(reader, this.#limits.httpIdleTimeoutMs, signal);
        if (read === "timeout") return failure("unavailable", "The provider response stalled.");
        if (read === "aborted") return interrupted();
        if (read.done) break;
        bytes += read.value.byteLength;
        if (bytes > this.#limits.httpResponseBytes) {
          return failure("protocol", "The provider response exceeded the size limit.");
        }
        const text = decoder.decode(read.value, { stream: true });
        for (let offset = 0; offset < text.length; offset += chunkCharacters) {
          this.notify(OUTSIDE_DRIVER_METHODS.httpChunk, {
            httpId,
            data: text.slice(offset, offset + chunkCharacters),
          });
        }
      }
      const rest = decoder.decode();
      if (rest.length > 0) this.notify(OUTSIDE_DRIVER_METHODS.httpChunk, { httpId, data: rest });
      return undefined;
    } catch {
      return failure("unavailable", "The provider response could not be read.");
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  #refuseHttp(httpId: OutsideDriverMessageId, refusal: ProviderFailure): void {
    this.#write({
      jsonrpc: "2.0",
      id: httpId,
      error: { code: -32000, message: refusal.message, data: { category: refusal.category } },
    });
  }
}

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<
  Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> | "timeout" | "aborted"
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
      new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

// ── the broker ─────────────────────────────────────────────────────────────

/**
 * Headers a driver may not set: it holds no credential, so any credential
 * header it writes is one it should not have, and the host decides the
 * request's target.
 */
const REFUSED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
]);

/** Response headers that never go back to the driver, beside the credential header itself. */
const WITHHELD_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "set-cookie",
]);

function relayedHeaders(
  headers: Headers,
  params: OutsideDriverHttpRequestParams,
): ReadonlyArray<readonly [string, string]> {
  const credentialHeader = params.auth?.header.toLowerCase();
  const relayed: Array<readonly [string, string]> = [];
  headers.forEach((value, name) => {
    const lowered = name.toLowerCase();
    if (lowered === credentialHeader || WITHHELD_RESPONSE_HEADERS.has(lowered)) return;
    relayed.push([lowered, value]);
  });
  return relayed;
}

/**
 * Makes one brokered call for the instance. The origin is checked before the
 * key is read, the key is leased for this instance alone, redirects are never
 * followed (so the key never reaches another target), and a refusal of the
 * key is reported to the pool by the host's own status check.
 */
function makeBroker(input: {
  readonly instanceId: ProviderInstanceId;
  readonly origin: string | undefined;
  readonly credentialResolver: ProviderCredentialResolver | undefined;
  readonly fetch: OutsideDriverFetch;
  readonly limits: OutsideDriverLimits;
}): BrokeredRequest {
  return async (params, signal) => {
    if (input.origin === undefined) {
      throw failure("invalid-configuration", "The provider address is not a valid endpoint.");
    }
    if (!isConfiguredOrigin(params.url, input.origin)) {
      throw failure(
        "unauthorized",
        "The provider driver asked for an address outside the configured endpoint.",
      );
    }
    const headers = new Headers();
    for (const [name, value] of params.headers ?? []) {
      const lowered = name.toLowerCase();
      if (REFUSED_REQUEST_HEADERS.has(lowered) || lowered === params.auth?.header.toLowerCase()) {
        throw failure("unauthorized", "The provider driver may not set that header.");
      }
      headers.append(name, value);
    }
    let lease: Awaited<ReturnType<typeof acquireProviderCredential>>["lease"];
    if (params.auth !== undefined) {
      let credential = "";
      try {
        const acquired = await acquireProviderCredential(
          input.credentialResolver,
          String(input.instanceId),
        );
        credential = acquired.credential;
        lease = acquired.lease;
      } catch {
        credential = "";
      }
      if (credential.length === 0) {
        throw failure("unauthenticated", "The provider credential is missing or unavailable.");
      }
      headers.set(
        params.auth.header,
        params.auth.scheme === "Bearer" ? `Bearer ${credential}` : credential,
      );
    }
    // The connection deadline ends when the headers arrive; a fetch signal
    // that stayed armed past then would cut off a streamed answer that runs
    // longer than the deadline. The body is bounded between chunks instead.
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    const connecting = setTimeout(abort, input.limits.httpConnectionTimeoutMs);
    let response: Response;
    try {
      response = await input.fetch(params.url, {
        method: params.method,
        headers,
        ...(params.body === undefined ? {} : { body: params.body }),
        redirect: "manual",
        signal: request.signal,
      });
    } catch {
      if (signal.aborted) throw interrupted();
      throw failure("unavailable", "The provider endpoint could not be reached.");
    } finally {
      clearTimeout(connecting);
    }
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => undefined);
      throw failure("invalid-configuration", "The configured endpoint returned a redirect.");
    }
    await reportKeyRejection(lease, response);
    return response;
  };
}

/** The configured address's origin, when it is one an endpoint may have: HTTPS or loopback HTTP. */
function configuredOrigin(baseUrl: string): string | undefined {
  try {
    return new URL(normalizeOpenAiCompatibleBaseUrl(baseUrl)).origin;
  } catch {
    return undefined;
  }
}

function isConfiguredOrigin(url: string, origin: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return target.username === "" && target.password === "" && target.origin === origin;
}

// ── the driver ─────────────────────────────────────────────────────────────

/**
 * An outside driver as the host's harness reaches it. It has no
 * `verifyToolCapability`: Verify tools is run by the host itself, so no
 * driver certifies its own models.
 */
export function makeOutsideHarnessEndpointProxy(
  options: OutsideHarnessEndpointProxyOptions,
): HarnessEndpointDriver {
  const limits: OutsideDriverLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const clock = options.clock ?? (() => new Date().toISOString());
  const registry = options.runtimeRegistry;
  const instanceId = options.instanceId;
  const listed = new Set(options.modelIds.map(String));
  let claims: OutsideDriverCapabilityClaims | undefined;
  let handshake: Promise<void> | undefined;
  let nextSession = 1;

  const link = new OutsideDriverLink({
    channel: options.channel,
    limits,
    broker: makeBroker({
      instanceId,
      origin: configuredOrigin(options.baseUrl),
      credentialResolver: options.credentialResolver,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      limits,
    }),
    // A stopped driver contributes no models, tools, or capabilities.
    onStopped: (reason) => {
      registry.setObservedState(
        decodeProviderProbeResult({
          instanceId,
          readiness: "incompatible",
          processState: "stopped",
          models: [],
          capabilities: allUnavailable(),
          message: reason.message,
          ...(reason.reason === undefined ? {} : { reason: reason.reason }),
          observedAt: clock() as UtcTimestamp,
        }),
      );
    },
  });

  /** Reads a result the driver wrote; one that does not decode stops it. */
  const read = <A>(
    decoded: { readonly _tag: "Left" } | { readonly _tag: "Right"; readonly right: A },
  ): A => {
    if (decoded._tag === "Right") return decoded.right;
    link.stop(driverStopped());
    throw link.stopped ?? driverStopped();
  };

  const initialize = async () => {
    const { settled } = link.call(
      OUTSIDE_DRIVER_METHODS.initialize,
      {
        protocolVersions: HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
        configuration: { baseUrl: options.baseUrl, modelIds: options.modelIds },
      },
      { timeoutMs: limits.callTimeoutMs },
    );
    const agreed = read(decodeOutsideDriverInitializeResult(await settled));
    if (!HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS.includes(agreed.protocolVersion)) {
      link.stop(noAgreedProtocol());
      throw link.stopped ?? noAgreedProtocol();
    }
  };
  const ensureInitialized = async () => {
    if (link.stopped !== undefined) throw link.stopped;
    handshake ??= initialize().catch((error: unknown) => {
      // A handshake that did not stop the driver (a timeout) may be tried again.
      handshake = undefined;
      throw error;
    });
    await handshake;
  };

  const shownBefore = () => {
    const capabilities = registry.observedState(instanceId)?.capabilities;
    return {
      streaming: capabilities?.streaming === "supported",
      reasoning: capabilities?.reasoning === "supported",
      usage: capabilities?.usage === "supported",
    };
  };

  const probe = async () => {
    await ensureInitialized();
    const { settled } = link.call(
      OUTSIDE_DRIVER_METHODS.probe,
      {},
      {
        timeoutMs: limits.callTimeoutMs,
      },
    );
    const result = read(decodeOutsideDriverProbeResult(await settled));
    claims = result.claims;
    const prior = registry.observedState(instanceId);
    const seen = new Set<string>();
    // Only models the person listed: the id is then text the person wrote,
    // never a name the driver chose.
    const models: ReadonlyArray<ProviderModel> = result.models.flatMap((model) => {
      const id = String(model.id);
      if (!listed.has(id) || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id: model.id,
          displayName: id,
          source: "manual" as const,
          verification: "verified" as const,
          reasoning: "unavailable" as const,
          inputModalities: ["text" as const],
          options: [],
          ...(model.contextWindowTokens === undefined
            ? {}
            : { contextLimit: model.contextWindowTokens }),
        },
      ];
    });
    const observedAt = clock() as UtcTimestamp;
    const observed = decodeProviderProbeResult({
      instanceId,
      readiness: models.length > 0 ? "ready" : "unavailable",
      processState: "stopped",
      models: carryModelContextWindowFacts(models, prior?.models),
      capabilities: clampOutsideDriverCapabilities(claims, shownBefore()),
      // Tool reach is the host's record alone; a probe never adds to it.
      ...(prior?.verifiedToolModelIds === undefined
        ? {}
        : { verifiedToolModelIds: prior.verifiedToolModelIds }),
      ...(models.length > 0
        ? {}
        : {
            reason: "no-usable-model",
            message: "The provider driver reported none of the models listed for this provider.",
          }),
      lastSuccessfulProbeAt: observedAt,
      observedAt,
    });
    registry.setObservedState(observed);
    return observed;
  };

  const recordObservedTurn = (shown: {
    readonly streaming: boolean;
    readonly reasoning: boolean;
    readonly usage: boolean;
  }) => {
    const observed = registry.observedState(instanceId);
    if (observed === undefined || link.stopped !== undefined) return;
    const before = shownBefore();
    registry.setObservedState(
      decodeProviderProbeResult({
        ...observed,
        capabilities: clampOutsideDriverCapabilities(claims, {
          streaming: before.streaming || shown.streaming,
          reasoning: before.reasoning || shown.reasoning,
          usage: before.usage || shown.usage,
        }),
        observedAt: clock() as UtcTimestamp,
      }),
    );
  };

  const open = async (modelId: ProviderModelId): Promise<HarnessEndpointSession> => {
    await ensureInitialized();
    const sessionRef = `s${nextSession}`;
    nextSession += 1;
    const { settled } = link.call(
      OUTSIDE_DRIVER_METHODS.sessionOpen,
      { sessionRef, modelId },
      { timeoutMs: limits.callTimeoutMs },
    );
    const opened = read(decodeOutsideDriverSessionOpenResult(await settled));
    const contextWindow = opened.bounds?.contextWindowTokens;
    let released = false;

    const send = async (
      request: HarnessEndpointRequest,
      stream: {
        readonly signal: AbortSignal;
        readonly onEvent: (event: HarnessEndpointStreamEvent) => void;
      },
    ): Promise<HarnessEndpointResponse> => {
      // Answered by the host: the driver is not asked after a release.
      if (released) throw failure("protocol", "Provider session is not active.");
      if (link.stopped !== undefined) throw link.stopped;
      if (stream.signal.aborted) throw interrupted();
      const wire = wireRequest(request);
      if (wire === undefined) throw failure("unsupported", "Native attachments are unsupported.");
      const shown = { streaming: false, reasoning: false, usage: false };
      const call = link.call(
        OUTSIDE_DRIVER_METHODS.sessionSend,
        { sessionRef, request: wire },
        {
          timeoutMs: limits.sendTimeoutMs,
          onEvent: (event) => {
            if (event.kind === "text-delta") shown.streaming = true;
            if (event.kind === "reasoning-delta") shown.reasoning = true;
            if (event.kind === "usage") shown.usage = true;
            stream.onEvent(
              event.kind === "usage" ? { kind: "usage", ...harnessUsage(event) } : event,
            );
          },
        },
      );
      // Answered by the host too: a cancel rejects at once, whatever the driver does.
      const onAbort = () => link.cancel(call.id);
      stream.signal.addEventListener("abort", onAbort, { once: true });
      let raw: unknown;
      try {
        raw = await call.settled;
      } finally {
        stream.signal.removeEventListener("abort", onAbort);
      }
      const answer = read(decodeOutsideDriverSessionSendResult(raw));
      recordObservedTurn({ ...shown, usage: shown.usage || answer.usage !== undefined });
      return {
        text: answer.text,
        toolCalls: answer.toolCalls,
        ...(answer.usage === undefined ? {} : { usage: harnessUsage(answer.usage) }),
        ...(answer.outputStopReason === undefined || answer.toolCalls.length > 0
          ? {}
          : { outputStopReason: answer.outputStopReason }),
      };
    };

    return {
      fits: (request) => contextWindow === undefined || estimatedTokens(request) <= contextWindow,
      send: async (request, stream) => {
        try {
          return await send(request, stream);
        } catch (error) {
          throw closed(error);
        }
      },
      release: () => {
        if (released) return;
        released = true;
        link.notify(OUTSIDE_DRIVER_METHODS.sessionRelease, { sessionRef });
      },
    };
  };

  return {
    kind: "outside-harness-endpoint",
    harnessEndpoint: {
      open: async (modelId) => {
        try {
          return await open(modelId);
        } catch (error) {
          throw closed(error);
        }
      },
      // Decided on the host from its own records, never asked of the driver.
      admitTurn: (turn, modelId) => {
        if (link.stopped !== undefined) return link.stopped;
        const observed = registry.observedState(instanceId);
        const model = observed?.models.find(
          (candidate) => String(candidate.id) === String(modelId),
        );
        const verified =
          observed?.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) ?? false;
        return validateChatTurnInput(
          turn,
          {
            nativeAttachments: observed?.capabilities.nativeAttachments ?? "unsupported",
            appManagedTools: verified ? "supported" : "unsupported",
          },
          model,
        );
      },
    },
    probe: (input) =>
      String(input.instanceId) !== String(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({ try: probe, catch: closed }),
  };
}

/**
 * The request as it crosses to the driver, or undefined when it carries a
 * person's attachments, which the ceiling keeps from an outside driver.
 */
function wireRequest(request: HarnessEndpointRequest): OutsideDriverRequest | undefined {
  if (request.history.some((message) => (message.attachments?.length ?? 0) > 0)) return undefined;
  return {
    sessionId: request.sessionId,
    modelId: request.modelId,
    ...(request.system === undefined ? {} : { system: request.system }),
    history: request.history.map(({ attachments: _attachments, ...message }) => ({
      role: message.role,
      text: message.text,
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      ...(message.toolResults === undefined
        ? {}
        : {
            toolResults: message.toolResults.map((result) => ({
              toolCallId: result.toolCallId,
              resultJson: result.resultJson,
              isError: result.isError,
              ...(result.images === undefined ? {} : { images: result.images }),
            })),
          }),
    })),
    tools: request.tools,
  };
}

/** Usage as the harness keeps it: a figure the driver did not report is absent, never zero. */
function harnessUsage(usage: OutsideDriverUsage): HarnessEndpointUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  };
}

/**
 * Roughly four characters per token of the request as sent, less its images,
 * which a model reads as a fixed embedding rather than as base64 text.
 */
function estimatedTokens(request: HarnessEndpointRequest): number {
  const withoutImages = request.history.map(({ attachments: _attachments, ...message }) =>
    message.toolResults === undefined
      ? message
      : {
          ...message,
          toolResults: message.toolResults.map(({ images: _images, ...result }) => result),
        },
  );
  return JSON.stringify({ ...request, history: withoutImages }).length / 4;
}

function allUnavailable() {
  return {
    streaming: "unavailable",
    resume: "unavailable",
    interruption: "unavailable",
    approvals: "unavailable",
    userQuestions: "unavailable",
    reasoning: "unavailable",
    usage: "unavailable",
    toolActivity: "unavailable",
    fileChanges: "unavailable",
    diffs: "unavailable",
    taskProgress: "unavailable",
    nativeChildAgents: "unavailable",
    nativeAttachments: "unavailable",
    nativeWebResearch: "unavailable",
    appManagedTools: "unavailable",
    citations: "unavailable",
    harnessAutoReview: "unavailable",
  } as const;
}
