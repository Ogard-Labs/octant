import {
  decodeOutsideDriverFailureData,
  decodeOutsideDriverInitializeResult,
  decodeOutsideDriverProbeResult,
  decodeOutsideDriverSessionOpenResult,
  decodeOutsideDriverSessionSendResult,
  decodeOutsideDriverToHostMessage,
  HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
  OUTSIDE_DRIVER_METHODS,
  type OutsideDriverHttpRequestParams,
  type OutsideDriverRequest,
} from "./outsideDriver";

/**
 * The out-of-process conformance kit for an outside provider driver: it plays
 * the host's part of the harness endpoint protocol against a driver's own
 * process (or, in a test, its modules over an in-memory channel) and holds
 * every line the driver writes to the schemas the host reads.
 *
 * Its evidence is advisory. The host enforces the same rules itself on every
 * line, clamps whatever a driver claims, and runs Verify tools on its own, so
 * passing this kit installs, trusts, or enables nothing; it tells an author,
 * in their own CI, that the host will not stop the driver.
 */

/** A driver's stdin and stdout, as lines. */
export interface OutsideDriverConformanceChannel {
  /** Writes one line to the driver. */
  readonly write: (line: string) => void;
  /** Receives each line the driver writes. */
  readonly onLine: (listener: (line: string) => void) => void;
}

export type OutsideDriverConformanceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OutsideDriverConformanceFixture {
  readonly channel: OutsideDriverConformanceChannel;
  /** What the host would send in `initialize`: the address and the listed models. */
  readonly configuration: {
    readonly baseUrl: string;
    readonly modelIds: ReadonlyArray<string>;
  };
  /**
   * Where the provider sends its key, or undefined when it sends none. The kit
   * stands in for the host's broker and sends a placeholder credential there.
   */
  readonly key?: { readonly header: string; readonly scheme?: "Bearer" } | undefined;
  /** Reaches the model service the driver translates for, usually a fake one. */
  readonly fetch: OutsideDriverConformanceFetch;
  /** A request the driver answers, with no tools unless the service takes them. */
  readonly request: typeof OutsideDriverRequest.Encoded;
  /** How long one call may take; 30 seconds when absent, as for the host's handshake. */
  readonly timeoutMs?: number;
}

export interface OutsideDriverConformanceEvidence {
  readonly agreedOnAHostProtocolVersion: true;
  readonly probeReportedAListedModel: true;
  readonly answeredWithASettledResponse: true;
  readonly keptServingAfterACancel: true;
  readonly keptServingAfterAMidBodyCancel: true;
  readonly keptServingAfterARelease: true;
  readonly everyMessageDecoded: true;
  readonly brokeredCallsStayedOnTheConfiguredOrigin: true;
}

/** The placeholder the kit sends where the host would put the person's key. */
export const OUTSIDE_DRIVER_CONFORMANCE_CREDENTIAL = "octant-conformance-placeholder";

const MESSAGE_BYTES = 4_194_304;

/** Headers a driver may not set; the host refuses a request that does. */
const REFUSED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
]);

/** Response headers the host never relays, beside the key's own header. */
const WITHHELD_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "set-cookie",
]);

const CHUNK_CHARACTERS = 7;

interface PendingCall {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Runs the driver through what the host relies on: a handshake on a version
 * the host speaks; a probe that decodes and reports a listed model; a send
 * whose events and answer decode and that settles with text or tool calls;
 * a cancel (once at the start, once in the middle of a brokered body, which
 * the brokered call must name its send for) and a release after which it still
 * answers; failures written as
 * the structure the host reads; and brokered requests only to the configured
 * origin, with the key asked for only where the provider sends it.
 */
export async function runOutsideDriverConformance(
  fixture: OutsideDriverConformanceFixture,
): Promise<OutsideDriverConformanceEvidence> {
  const timeoutMs = fixture.timeoutMs ?? 30_000;
  const origin = originOf(fixture.configuration.baseUrl);
  if (origin === undefined) fail("the configured address is not an HTTP or HTTPS URL");
  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let violation: Error | undefined;

  const violate = (message: string) => {
    violation ??= conformanceError(message);
    for (const call of pending.values()) call.reject(violation);
    pending.clear();
  };
  const write = (message: unknown) => fixture.channel.write(JSON.stringify(message));
  const call = (method: string, params: unknown): { id: number; settled: Promise<unknown> } => {
    const id = nextId;
    nextId += 1;
    const settled = new Promise<unknown>((resolve, reject) => {
      if (violation !== undefined) {
        reject(violation);
        return;
      }
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(conformanceError(`${method} was not answered in time`));
      }, timeoutMs);
      pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      write({ jsonrpc: "2.0", id, method, params });
    });
    return { id, settled };
  };
  const notify = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params });

  const sendIds = new Set<number>();
  // The kit holds the first brokered body a driver asks for while this is set,
  // so a cancel can land in the middle of it.
  let holding:
    | { readonly sendId: number; readonly relayed: (httpId: number) => void; held: boolean }
    | undefined;

  const broker = async (httpId: number, params: OutsideDriverHttpRequestParams) => {
    if (params.requestId !== undefined && !sendIds.has(params.requestId)) {
      return violate("a brokered request named a send the host never issued");
    }
    const holder = holding !== undefined && !holding.held ? holding : undefined;
    if (holder !== undefined && params.requestId !== holder.sendId) {
      return violate("a brokered request made for a send did not name it with requestId");
    }
    const refusal = brokeredRequestRefusal(params, origin, fixture.key);
    if (refusal !== undefined) return violate(refusal);
    const headers = new Headers();
    for (const [name, value] of params.headers ?? []) headers.append(name, value);
    if (params.auth !== undefined) {
      headers.set(
        params.auth.header,
        params.auth.scheme === "Bearer"
          ? `Bearer ${OUTSIDE_DRIVER_CONFORMANCE_CREDENTIAL}`
          : OUTSIDE_DRIVER_CONFORMANCE_CREDENTIAL,
      );
    }
    let response: Response;
    try {
      response = await fixture.fetch(params.url, {
        method: params.method,
        headers,
        ...(params.body === undefined ? {} : { body: params.body }),
        redirect: "manual",
      });
    } catch {
      write({
        jsonrpc: "2.0",
        id: httpId,
        error: { code: -32000, message: "unavailable", data: { category: "unavailable" } },
      });
      return;
    }
    const relayed: Array<readonly [string, string]> = [];
    const keyHeader = params.auth?.header.toLowerCase();
    response.headers.forEach((value, name) => {
      const lowered = name.toLowerCase();
      if (lowered === keyHeader || WITHHELD_RESPONSE_HEADERS.has(lowered)) return;
      relayed.push([lowered, value]);
    });
    write({ jsonrpc: "2.0", id: httpId, result: { status: response.status, headers: relayed } });
    // The host relays a body in pieces wherever its reads end, so the kit cuts
    // it small: a driver that parses only whole lines per chunk fails here
    // rather than on the first long answer.
    const text = await response.text();
    if (holder !== undefined && text.length > 0) {
      holder.held = true;
      notify(OUTSIDE_DRIVER_METHODS.httpChunk, {
        httpId,
        data: text.slice(0, CHUNK_CHARACTERS),
      });
      holder.relayed(httpId);
      return;
    }
    for (let offset = 0; offset < text.length; offset += CHUNK_CHARACTERS) {
      notify(OUTSIDE_DRIVER_METHODS.httpChunk, {
        httpId,
        data: text.slice(offset, offset + CHUNK_CHARACTERS),
      });
    }
    notify(OUTSIDE_DRIVER_METHODS.httpEnd, { httpId, outcome: "complete" });
  };

  const brokeredIds = new Set<number>();
  fixture.channel.onLine((line) => {
    if (violation !== undefined) return;
    if (new TextEncoder().encode(line).byteLength > MESSAGE_BYTES) {
      return violate("a line was over the 4 MiB message cap");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return violate("a line was not JSON; console output belongs on stderr");
    }
    const decoded = decodeOutsideDriverToHostMessage(parsed);
    if (decoded._tag === "Left") {
      return violate(`a message did not decode: ${line.slice(0, 200)}`);
    }
    const message = decoded.right;
    if ("result" in message || "error" in message) {
      if (message.id >= nextId) return violate("an answer named a call the host never made");
      const waiting = pending.get(message.id);
      if (waiting === undefined) return;
      pending.delete(message.id);
      if ("result" in message) {
        waiting.resolve(message.result);
        return;
      }
      if (decodeOutsideDriverFailureData(message.error.data)._tag === "Left") {
        return violate(
          `${waiting.method} failed without a category the host reads; the host reports it as a protocol failure`,
        );
      }
      waiting.reject(conformanceError(`${waiting.method} failed`));
      return;
    }
    if (message.method === OUTSIDE_DRIVER_METHODS.sessionEvent) {
      const { requestId } = message.params;
      if (requestId >= nextId) return violate("an event named a call the host never made");
      const waiting = pending.get(requestId);
      if (waiting !== undefined && waiting.method !== OUTSIDE_DRIVER_METHODS.sessionSend) {
        return violate(`an event streamed for ${waiting.method}, which streams nothing`);
      }
      return;
    }
    if (brokeredIds.has(message.id)) return violate("a brokered request reused an id");
    brokeredIds.add(message.id);
    void broker(message.id, message.params);
  });

  const read = <A>(
    what: string,
    decoded: { readonly _tag: "Left" } | { readonly _tag: "Right"; readonly right: A },
  ): A => {
    if (decoded._tag === "Right") return decoded.right;
    return fail(`${what} did not decode`);
  };

  const initialized = read(
    "the initialize answer",
    decodeOutsideDriverInitializeResult(
      await call(OUTSIDE_DRIVER_METHODS.initialize, {
        protocolVersions: HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
        configuration: fixture.configuration,
      }).settled,
    ),
  );
  if (!HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS.includes(initialized.protocolVersion)) {
    fail("the handshake settled on a version the host does not speak");
  }

  const probe = async () =>
    read(
      "the probe answer",
      decodeOutsideDriverProbeResult(await call(OUTSIDE_DRIVER_METHODS.probe, {}).settled),
    );
  const probed = await probe();
  const listed = new Set(fixture.configuration.modelIds);
  if (!probed.models.some((model) => listed.has(String(model.id)))) {
    fail("the probe reported none of the listed models");
  }

  const sessionRef = "s1";
  read(
    "the session/open answer",
    decodeOutsideDriverSessionOpenResult(
      await call(OUTSIDE_DRIVER_METHODS.sessionOpen, {
        sessionRef,
        modelId: fixture.request.modelId,
      }).settled,
    ),
  );
  const send = () => {
    const sent = call(OUTSIDE_DRIVER_METHODS.sessionSend, { sessionRef, request: fixture.request });
    sendIds.add(sent.id);
    return sent;
  };
  // The host answers a cancel itself and ignores the driver's late reply, so
  // the driver only has to keep serving.
  const cancel = (sent: { id: number; settled: Promise<unknown> }) => {
    sent.settled.catch(() => undefined);
    const cancelledCall = pending.get(sent.id);
    pending.delete(sent.id);
    cancelledCall?.reject(conformanceError("the send was cancelled"));
    notify(OUTSIDE_DRIVER_METHODS.sessionCancel, { requestId: sent.id });
  };
  const answer = read(
    "the session/send answer",
    decodeOutsideDriverSessionSendResult(await send().settled),
  );
  if (answer.text.length === 0 && answer.toolCalls.length === 0) {
    fail("a send settled with neither text nor tool calls");
  }

  cancel(send());
  await probe();

  // A driver that makes a brokered call is cancelled with its body half read.
  // The host then ends the call as interrupted; a late event from the driver
  // reaches nothing, so only the driver's staying alive is checked.
  const midBody = send();
  const relayed = new Promise<number>((resolve) => {
    holding = { sendId: midBody.id, relayed: resolve, held: false };
  });
  const reached = await Promise.race([relayed, midBody.settled.then(() => undefined)]);
  holding = undefined;
  if (reached !== undefined) {
    cancel(midBody);
    notify(OUTSIDE_DRIVER_METHODS.httpEnd, {
      httpId: reached,
      outcome: "failed",
      category: "interrupted",
    });
    await probe();
  }

  notify(OUTSIDE_DRIVER_METHODS.sessionRelease, { sessionRef });
  await probe();

  if (violation !== undefined) throw violation;
  return {
    agreedOnAHostProtocolVersion: true,
    probeReportedAListedModel: true,
    answeredWithASettledResponse: true,
    keptServingAfterACancel: true,
    keptServingAfterAMidBodyCancel: true,
    keptServingAfterARelease: true,
    everyMessageDecoded: true,
    brokeredCallsStayedOnTheConfiguredOrigin: true,
  };
}

/** Why the host would refuse this brokered request, or undefined when it would make it. */
function brokeredRequestRefusal(
  params: OutsideDriverHttpRequestParams,
  origin: string,
  key: OutsideDriverConformanceFixture["key"],
): string | undefined {
  let target: URL;
  try {
    target = new URL(params.url);
  } catch {
    return "a brokered request named an address that is not a URL";
  }
  if (
    target.username !== "" ||
    target.password !== "" ||
    `${target.protocol}//${target.host}` !== origin
  ) {
    return "a brokered request named an address outside the configured origin";
  }
  const keyHeader = params.auth?.header.toLowerCase();
  if (params.auth !== undefined) {
    if (key === undefined) return "a brokered request asked for a key the provider does not send";
    if (keyHeader !== key.header.toLowerCase() || params.auth.scheme !== key.scheme) {
      return "a brokered request asked to send the key where the provider does not send it";
    }
  }
  for (const [name] of params.headers ?? []) {
    const lowered = name.toLowerCase();
    if (REFUSED_REQUEST_HEADERS.has(lowered) || lowered === keyHeader) {
      return `a brokered request set the ${lowered} header, which only the host sets`;
    }
  }
  return undefined;
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function conformanceError(message: string): Error {
  return new Error(`Outside driver conformance failed: ${message}`);
}

function fail(message: string): never {
  throw conformanceError(message);
}
