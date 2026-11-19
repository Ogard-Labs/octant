import type { CredentialOperation } from "./credentialRequest";
import type {
  IntegrationCommand,
  IntegrationCredentialRequestResult,
  IntegrationObservation,
} from "@octant/contracts/integration";
import type { ActivityKind, ActivityRecord } from "@octant/contracts/code-home-activity";

/**
 * Typed server port for the Integration plugin kind.
 *
 * Integration plugins run inside the host process and receive only the host
 * ports their declared capabilities allow. These types are the wire contract
 * between a plugin's runtime and the host.
 */
export * from "@octant/contracts/integration";

/** Read-only contributed sources. Discovery and event data never grant execution authority. */
export interface IntegrationEventSourceProvider {
  readonly choices: () => Promise<
    ReadonlyArray<import("@octant/contracts").AutomationEventSourceChoice>
  >;
  readonly bind: (
    selection: import("@octant/contracts").AutomationIntegrationEventTrigger,
    signal: AbortSignal,
  ) => Promise<IntegrationEventSource | undefined>;
}

export interface IntegrationEventSource {
  readonly identity: string;
  readonly label: string;
  /** Assignment sets detect absent-to-present transitions; append sources retain seen event ids. */
  readonly semantics: "assignment-set" | "append";
  readonly current: () => boolean;
  readonly read: (signal: AbortSignal) => Promise<
    | {
        readonly kind: "complete";
        readonly events: ReadonlyArray<import("@octant/contracts").AutomationIntegrationEvent>;
        /** The complete bounded observation before event filters are applied. */
        readonly window?: import("@octant/contracts").AutomationEventSourceWindow;
      }
    | {
        readonly kind: "unavailable";
        readonly reason: "source-unavailable" | "source-limit";
        readonly retryAfterSeconds?: number;
      }
  >;
}

/**
 * Request header a plugin uses to ask the host fetch interceptor to attach
 * the named credential reference as an Authorization bearer token. The header
 * is stripped before the request leaves the host; its value is an opaque
 * reference, never raw token material.
 */
export const INTEGRATION_CREDENTIAL_REF_HEADER = "x-octant-credential-ref";

/**
 * Host-owned PKCE authorization request. The plugin names the external
 * endpoints and public client id; the host generates the verifier, stores it,
 * and never returns token material.
 */
export interface IntegrationPkceAuthorizationRequest {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly extraParams?: Readonly<Record<string, string>>;
}

export type IntegrationPkceBeginResult =
  | { readonly kind: "redirect"; readonly authorizationUrl: string }
  | { readonly kind: "refused"; readonly reason: string };

export type IntegrationPkceRefreshResult =
  | { readonly kind: "ready" }
  | { readonly kind: "invalid_grant" }
  | { readonly kind: "failed"; readonly reason: string };

export type IntegrationRevokeResult = { readonly kind: "revoked" } | { readonly kind: "cleared" };

/** The delivery cards a repository activity source answers; runs stay journal-local. */
export type IntegrationActivityCard = Exclude<ActivityKind, "runs">;

/**
 * How a repository activity source reports its account: the connection it
 * reads as, a labeled non-connection, or an honest refusal. A source never
 * answers account availability it has not itself observed.
 */
export type IntegrationActivityAccount =
  | { readonly status: "connected"; readonly account: string }
  | { readonly status: "disconnected" | "insecure-storage" }
  | {
      readonly status: "unavailable";
      readonly reason: "not-connected" | "not-checked" | "rate-limited" | "read-failed";
    };

/**
 * One repository's activity for one card and range: validated records for the
 * signed-in person's own deliveries, an access loss that invalidates earlier
 * reads of that repository, or an honest refusal.
 */
export type IntegrationActivityObservation =
  | {
      readonly status: "ready";
      readonly records: ReadonlyArray<Exclude<ActivityRecord, { kind: "runs" }>>;
    }
  | {
      readonly status: "partial";
      readonly reason: "incomplete" | "read-failed";
      readonly records: ReadonlyArray<Exclude<ActivityRecord, { kind: "runs" }>>;
    }
  | { readonly status: "repository-missing" }
  | {
      readonly status: "unavailable";
      readonly reason: "rate-limited" | "read-failed" | "not-checked" | "not-connected";
    };

/**
 * A read-only repository history contribution. It holds no credential, shell,
 * or filesystem handle: the host asks for account availability, then for one
 * repository's records inside an established range as the already-reported
 * account.
 */
export interface IntegrationActivitySource {
  readonly account: (
    card: IntegrationActivityCard,
    signal: AbortSignal,
  ) => Promise<IntegrationActivityAccount>;
  readonly readRepository: (input: {
    readonly owner: string;
    readonly name: string;
    readonly card: IntegrationActivityCard;
    readonly since: string | undefined;
    readonly until: string | undefined;
    readonly account: string;
    readonly signal: AbortSignal;
  }) => Promise<IntegrationActivityObservation>;
}

/**
 * The host port passed to an Integration plugin. It exposes only the narrow
 * capabilities the plugin declared: outbound network requests as a configured
 * fetch, opaque credential references through the host's credential broker, and
 * host-owned PKCE authorization that never returns raw tokens. Raw tokens,
 * filesystem handles, and shell access are never handed over.
 */
export interface IntegrationHostPort {
  /** Register a fixed one-use operation. Availability never grants consent. */
  readonly registerCredentialOperation?: (
    operation: CredentialOperation,
  ) => { readonly kind: "registered"; readonly release: () => void } | { readonly kind: "refused" };
  /** Register the integration's one read-only repository activity source. */
  readonly registerActivitySource?: (
    source: IntegrationActivitySource,
  ) => { readonly kind: "registered"; readonly release: () => void } | { readonly kind: "refused" };
  readonly fetch: (input: Request) => Promise<Response>;
  readonly requestCredential: (scope: string) => Promise<IntegrationCredentialRequestResult>;
  readonly beginPkceAuthorization: (
    request: IntegrationPkceAuthorizationRequest,
  ) => Promise<IntegrationPkceBeginResult>;
  readonly refreshPkceAuthorization: (request: {
    readonly scope: string;
    readonly tokenEndpoint: string;
    readonly clientId: string;
  }) => Promise<IntegrationPkceRefreshResult>;
  readonly revokeCredential: (request: {
    readonly scope: string;
    readonly revokeEndpoint: string;
  }) => Promise<IntegrationRevokeResult>;
}

/**
 * Runtime an Integration plugin returns after being constructed with a host
 * port. The host routes authentication and operation commands here and receives
 * observations in return.
 */
export interface IntegrationRuntime {
  readonly observe: (
    command: IntegrationCommand,
    signal?: AbortSignal,
  ) => Promise<IntegrationObservation>;
  readonly execute: (
    command: IntegrationCommand,
    signal?: AbortSignal,
  ) => Promise<IntegrationObservation>;
  readonly close: () => Promise<void>;
}
