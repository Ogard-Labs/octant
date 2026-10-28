import type { ProviderFailureCategory } from "@octant/contracts";
import type {
  OutsideDriverHttpRequestParams,
  OutsideDriverInitializeParams,
  OutsideDriverProbeResult,
  OutsideDriverSessionOpenParams,
  OutsideDriverSessionOpenResult,
  OutsideDriverSessionSendParams,
  OutsideDriverSessionSendResult,
  OutsideDriverStreamEvent,
} from "./outsideDriver";

/**
 * Types for `outsideDriverServe.mjs`, which a driver package carries as plain
 * JavaScript. Every shape is the wire form, as JSON carries it.
 */

export declare const HARNESS_ENDPOINT_PROTOCOL_VERSION: "harness-endpoint/1";

export interface OutsideDriverFailureDetails {
  readonly retryAfterMs?: number | undefined;
  readonly contextOverflow?: { readonly contextWindowTokens?: number | undefined } | undefined;
}

export declare class OutsideDriverFailure extends Error {
  readonly category: ProviderFailureCategory;
  readonly retryAfterMs: number | undefined;
  readonly contextOverflow: { readonly contextWindowTokens: number | undefined } | undefined;
  constructor(category: ProviderFailureCategory, details?: OutsideDriverFailureDetails);
}

export type OutsideDriverConfiguration =
  (typeof OutsideDriverInitializeParams.Encoded)["configuration"];

/** A response the host fetched for the driver, without the credential header. */
export interface OutsideDriverBrokeredResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly header: (name: string) => string | undefined;
  /** The body as the host streams it; it can be read once, through this or `text`. */
  readonly chunks: () => AsyncIterable<string>;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

export interface OutsideDriverHost {
  /** What the host sent in `initialize`; undefined before the handshake. */
  readonly configuration: OutsideDriverConfiguration | undefined;
  /** Asks the host to make one request to the configured origin. */
  readonly http: (
    request: typeof OutsideDriverHttpRequestParams.Encoded,
  ) => Promise<OutsideDriverBrokeredResponse>;
}

export interface OutsideDriverTurn {
  /** Aborted when the host cancels the send. */
  readonly signal: AbortSignal;
  readonly emit: (event: typeof OutsideDriverStreamEvent.Encoded) => void;
  readonly host: OutsideDriverHost;
}

type MaybePromise<A> = A | Promise<A>;

export interface OutsideDriverImplementation {
  readonly initialize?: (
    configuration: OutsideDriverConfiguration,
    host: OutsideDriverHost,
  ) => MaybePromise<void>;
  readonly probe: (
    host: OutsideDriverHost,
  ) => MaybePromise<typeof OutsideDriverProbeResult.Encoded>;
  readonly open?: (
    params: typeof OutsideDriverSessionOpenParams.Encoded,
    host: OutsideDriverHost,
  ) => MaybePromise<typeof OutsideDriverSessionOpenResult.Encoded | undefined>;
  readonly send: (
    params: typeof OutsideDriverSessionSendParams.Encoded,
    turn: OutsideDriverTurn,
  ) => MaybePromise<typeof OutsideDriverSessionSendResult.Encoded>;
  readonly release?: (sessionRef: string) => void;
}

/** One line channel: the host's lines in, the driver's lines out. */
export interface OutsideDriverLineIo {
  readonly onLine: (listener: (line: string) => void) => void;
  readonly write: (line: string) => void;
}

export declare function serveOutsideDriver(
  driver: OutsideDriverImplementation,
  io?: OutsideDriverLineIo,
): void;
