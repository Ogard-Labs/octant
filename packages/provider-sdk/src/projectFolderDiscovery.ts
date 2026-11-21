import {
  DiscoveredFolderProvider as DiscoveredFolderProviderSchema,
  type DiscoveredFolderProvider,
  type ProviderFolderScanStopReason,
  type ProviderInstance,
} from "@octant/contracts";
import { Either, Schema } from "effect";

const decodeDiscoveredFolderProvider = Schema.decodeUnknownEither(DiscoveredFolderProviderSchema);

/**
 * One normalized folder observation contributed by a provider adapter.
 *
 * Vendor storage paths, JSONL payloads, and database schemas stop at the
 * adapter; the host owns canonicalization, symlink/worktree/Downloads
 * filtering, Git remote parsing, scan bounds, and Project import.
 */
export interface ProviderProjectFolderObservation {
  /** Absolute working directory recorded by the provider session. */
  readonly workingDirectory: string;
  /** Stable session identifier within this provider for deduplication. */
  readonly sessionKey: string;
  /** Last observed session activity timestamp, in epoch milliseconds. */
  readonly lastActivityMs: number;
}

/**
 * Host-owned read-only scan context passed to each provider folder discovery
 * adapter. The host enforces global file, entry, and wall-clock budgets,
 * cancellation, and Strict gating through these callbacks.
 */
export interface ProviderProjectFolderDiscoveryContext {
  /** Canonical home directory for the current host user. */
  readonly homeDirectory: string;
  /** Host environment variables available for provider-home resolution. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Currently configured provider instances on this host. */
  readonly providerInstances: ReadonlyArray<ProviderInstance>;
  /** Returns true once the host has canceled, superseded, or Strict-gated the scan. */
  readonly isCancelled: () => boolean;
  /**
   * Returns how many file or row reads remain in the host's inspection budget
   * (0 once exhausted or expired), so database-backed adapters can bound queries.
   */
  readonly remainingItemBudget: () => number;
  /**
   * Claims one unit of the host's file/row inspection budget before reading a
   * session artifact. Returns false when the scan must stop (budget exhausted,
   * time expired, or scan canceled).
   */
  readonly consumeItemBudget: () => boolean;
  /**
   * Reports one normalized folder observation to the host. Returns false when
   * the host stops discovery (entry limit reached, time expired, or canceled).
   */
  readonly observe: (observation: ProviderProjectFolderObservation) => boolean;
}

/**
 * Discriminated outcome returned by a provider folder discovery adapter.
 * Expected failures and truncations are values, never thrown exceptions.
 */
export type ProviderProjectFolderDiscoveryResult =
  | { readonly status: "completed" }
  | { readonly status: "stopped"; readonly reason: ProviderFolderScanStopReason }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable"; readonly reason?: string };

/**
 * Optional provider capability for read-only discovery of folders the person
 * already used with a provider during first run.
 *
 * Both built-in provider adapters and third-party provider plugins implement
 * this same port. Discovery is strictly read-only and grants no authority.
 */
export interface ProviderProjectFolderDiscoveryPort {
  readonly providerId: DiscoveredFolderProvider;
  readonly discoverFolders: (
    context: ProviderProjectFolderDiscoveryContext,
  ) => Promise<ProviderProjectFolderDiscoveryResult>;
}

/**
 * Deduplicates and validates provider folder discovery ports by `providerId`,
 * preserving first-registration order and ignoring malformed provider IDs.
 */
export function collectProviderProjectFolderDiscoveryPorts(
  ports: ReadonlyArray<ProviderProjectFolderDiscoveryPort>,
): ReadonlyArray<ProviderProjectFolderDiscoveryPort> {
  const seen = new Set<string>();
  const collected: ProviderProjectFolderDiscoveryPort[] = [];
  for (const port of ports) {
    const decoded = decodeDiscoveredFolderProvider(port.providerId);
    if (Either.isLeft(decoded)) continue;
    const key = decoded.right;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push(port);
  }
  return collected;
}
