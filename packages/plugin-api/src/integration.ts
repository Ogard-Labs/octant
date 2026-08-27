import type {
  IntegrationCommand,
  IntegrationCredentialRequestResult,
  IntegrationObservation,
} from "@octant/contracts/integration";

/**
 * Typed server port for the Integration plugin kind.
 *
 * Integration plugins run inside the host process and receive only the host
 * ports their declared capabilities allow. These types are the wire contract
 * between a plugin's runtime and the host.
 */
export * from "@octant/contracts/integration";

/**
 * The host port passed to an Integration plugin. It exposes only the narrow
 * capabilities the plugin declared: outbound network requests as a configured
 * fetch, and opaque credential references through the host's credential broker.
 * Raw tokens, filesystem handles, and shell access are never handed over.
 */
export interface IntegrationHostPort {
  readonly fetch: (input: Request) => Promise<Response>;
  readonly requestCredential: (scope: string) => Promise<IntegrationCredentialRequestResult>;
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
