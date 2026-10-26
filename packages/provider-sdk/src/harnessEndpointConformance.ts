import {
  decodeProviderFailure,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderTurnInput,
} from "@octant/contracts";
import type {
  HarnessEndpointRequest,
  HarnessEndpointResponse,
  ProviderHarnessEndpoint,
} from "./harnessEndpoint";

export interface HarnessEndpointConformanceFixture {
  readonly endpoint: ProviderHarnessEndpoint;
  readonly modelId: ProviderModelId;
  /** A request the endpoint answers. The harness supplies its own signal. */
  readonly request: HarnessEndpointRequest;
  /** A turn offering tools to a model the endpoint has not verified for them. */
  readonly unverifiedToolTurn: ProviderTurnInput;
}

export interface HarnessEndpointConformanceEvidence {
  readonly unverifiedToolsRefusedBeforeAnyRequest: true;
  readonly answeredWithASettledResponse: true;
  readonly cancelledRequestInterrupted: true;
  readonly releasedSessionRefused: true;
}

/**
 * Proves an endpoint keeps the promises the host's harness relies on. The host
 * classifies every failure it retries or reports, so a rejection that is not a
 * decodable `ProviderFailure` would surface as an unexplained crash; a cancel
 * must read as `interrupted` so it is never retried or reported as an outage.
 */
export async function runHarnessEndpointConformance(
  fixture: HarnessEndpointConformanceFixture,
): Promise<HarnessEndpointConformanceEvidence> {
  const refusal = fixture.endpoint.admitTurn(fixture.unverifiedToolTurn, fixture.modelId);
  assert(refusal !== undefined, "a turn with unverified tools was admitted");
  decodeProviderFailure(refusal);

  const session = await fixture.endpoint.open(fixture.modelId);
  const response: HarnessEndpointResponse = await session.send(fixture.request, {
    signal: new AbortController().signal,
    onEvent: () => undefined,
  });
  assert(
    response.text.length > 0 || response.toolCalls.length > 0,
    "a request settled with neither text nor tool calls",
  );

  const cancel = new AbortController();
  cancel.abort();
  const cancelled = await rejection(
    session.send(fixture.request, { signal: cancel.signal, onEvent: () => undefined }),
  );
  assert(cancelled?.category === "interrupted", "a cancelled request was not interrupted");

  session.release();
  const released = await rejection(
    session.send(fixture.request, {
      signal: new AbortController().signal,
      onEvent: () => undefined,
    }),
  );
  assert(released !== undefined, "a released session still sent a request");

  return {
    unverifiedToolsRefusedBeforeAnyRequest: true,
    answeredWithASettledResponse: true,
    cancelledRequestInterrupted: true,
    releasedSessionRefused: true,
  };
}

/** The failure a send rejected with, or undefined when it resolved. */
async function rejection(
  send: Promise<HarnessEndpointResponse>,
): Promise<ProviderFailure | undefined> {
  try {
    await send;
    return undefined;
  } catch (error) {
    try {
      return decodeProviderFailure(error);
    } catch {
      throw new Error(
        "Harness endpoint conformance failed: a send rejected with no provider failure",
      );
    }
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Harness endpoint conformance failed: ${message}`);
}
