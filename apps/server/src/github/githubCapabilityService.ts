import type { GithubAuthenticationCommand, GithubAuthenticationSnapshot } from "@octant/contracts";
import { decodeGithubAuthenticationSnapshot } from "@octant/contracts";
import { classifyGithubAuthentication } from "@octant/domain";
import type { GhAuthenticationPortLike } from "./ghAuthenticationPort";
import type { GhOperationProbePort, GhOperationProbeResults } from "./ghRepositoryCataloguePort";

const DEFAULT_PROBE_TTL_MS = 30_000;

export class GithubCapabilityService {
  readonly #port: GhAuthenticationPortLike;
  readonly #probes: GhOperationProbePort | undefined;
  readonly #now: () => number;
  readonly #probeTtlMs: number;
  #cachedProbes: { readonly results: GhOperationProbeResults; readonly at: number } | undefined;
  constructor(
    port: GhAuthenticationPortLike,
    options: {
      readonly probes?: GhOperationProbePort;
      readonly now?: () => number;
      readonly probeTtlMs?: number;
    } = {},
  ) {
    this.#port = port;
    this.#probes = options.probes;
    this.#now = options.now ?? Date.now;
    this.#probeTtlMs = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
  }
  async snapshot(signal: AbortSignal): Promise<GithubAuthenticationSnapshot> {
    const observation = await this.#port.observe(signal);
    if (observation.kind === "observed") {
      const operationProbes = await this.#observeOperationProbes(signal);
      return decodeOrUnavailable(
        classifyGithubAuthentication({
          accounts: observation.accounts.map((account) => ({
            ...account,
            ...(operationProbes === undefined ? {} : { operationProbes }),
          })),
        }),
      );
    }
    if (observation.kind === "unauthorized")
      return decodeOrUnavailable(classifyGithubAuthentication({ accounts: [] }));
    if (observation.kind === "external-token") {
      return decodeOrUnavailable(classifyGithubAuthentication({ externalToken: true }));
    }
    if (observation.kind === "rate-limited")
      return decodeOrUnavailable(classifyGithubAuthentication({ rateLimited: true }));
    return decodeOrUnavailable(classifyGithubAuthentication({ unavailable: true }));
  }
  async execute(
    command: GithubAuthenticationCommand,
    signal: AbortSignal,
  ): Promise<GithubAuthenticationSnapshot> {
    const execution = await this.#port.execute(command, signal);
    // Setup, scope refresh, and logout all change what live probes would
    // prove; drop the bounded cache instead of advertising pre-command state.
    this.#cachedProbes = undefined;
    if (execution.kind === "device-flow") {
      return decodeOrUnavailable({
        state: "unauthorized",
        capabilities: [],
        interaction: {
          kind: "device-flow",
          verificationUri: "https://github.com/login/device",
          userCode: execution.userCode,
        },
      });
    }
    return this.snapshot(signal);
  }

  /**
   * Capability is proved per operation with bounded, briefly cached live
   * probes. No probe port means no capability can be advertised.
   */
  async #observeOperationProbes(signal: AbortSignal): Promise<GhOperationProbeResults | undefined> {
    if (this.#probes === undefined) return undefined;
    const cached = this.#cachedProbes;
    if (cached !== undefined && this.#now() - cached.at < this.#probeTtlMs) {
      return cached.results;
    }
    let results: GhOperationProbeResults;
    try {
      results = await this.#probes.probeOperations(signal);
    } catch {
      return undefined;
    }
    this.#cachedProbes = { results, at: this.#now() };
    return results;
  }
}

function decodeOrUnavailable(snapshot: GithubAuthenticationSnapshot): GithubAuthenticationSnapshot {
  try {
    return decodeGithubAuthenticationSnapshot(snapshot);
  } catch {
    return decodeGithubAuthenticationSnapshot(classifyGithubAuthentication({ unavailable: true }));
  }
}
