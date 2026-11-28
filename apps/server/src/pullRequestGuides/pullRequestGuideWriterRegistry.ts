import {
  PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
  type PullRequestGuideHostPort,
  type PullRequestGuideWriteOutcome,
  type PullRequestGuideWriteRequest,
  type PullRequestGuideWriter,
} from "@octant/plugin-api/pull-request-guide-writer";
import {
  offeredPullRequestGuideWriters,
  type OfferedPullRequestGuideWriter,
  type PullRequestGuideWriterActivationFacts,
} from "@octant/plugin-host/pull-request-guide-writers";

export interface PullRequestGuideWriterRegistration {
  readonly writerId: string;
  readonly displayName: string;
  /** Evaluated live on every lookup and mid-run check so disabling takes effect at once. */
  readonly activation: () => PullRequestGuideWriterActivationFacts;
  readonly writer: PullRequestGuideWriter;
}

export type PullRequestGuideWriterRegisterResult =
  | { readonly kind: "registered"; readonly release: () => void }
  | { readonly kind: "refused" };

interface RegistrationRecord {
  readonly identity: object;
  readonly entry: PullRequestGuideWriterRegistration;
}

/**
 * Host registry for pull request guide writer plugin contributions.
 *
 * Every listing, resolution, and run passes through `@octant/plugin-host`'s
 * pure activation and collision policy (`offeredPullRequestGuideWriters`). A
 * writer runs with a scoped host port bound to the exact registration instance
 * that started it; disabling, untrusting, or releasing the plugin revokes the
 * port at once and refuses further diff reads, model turns, or guide output.
 */
export class PullRequestGuideWriterRegistry {
  readonly #registrations: Array<RegistrationRecord> = [];

  register(entry: PullRequestGuideWriterRegistration): PullRequestGuideWriterRegisterResult {
    if (entry.writer.kind !== PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND) {
      return { kind: "refused" };
    }
    const identity = {};
    this.#registrations.push({ identity, entry });
    return {
      kind: "registered",
      release: () => {
        const index = this.#registrations.findIndex((record) => record.identity === identity);
        if (index !== -1) this.#registrations.splice(index, 1);
      },
    };
  }

  /** Currently offered guide writers (installed, trusted, enabled, and non-colliding). */
  list(): ReadonlyArray<OfferedPullRequestGuideWriter> {
    return offeredPullRequestGuideWriters(
      this.#registrations.map(({ entry }) => ({
        writerId: entry.writerId,
        displayName: entry.displayName,
        facts: entry.activation(),
        writer: entry.writer,
      })),
    );
  }

  /** Resolves one active writer by id, or the first active offered writer when omitted. */
  resolve(writerId?: string): OfferedPullRequestGuideWriter | undefined {
    const offered = this.list();
    if (writerId === undefined) return offered[0];
    return offered.find((entry) => entry.writerId === writerId);
  }

  #resolveOfferedRecord(writerId: string): RegistrationRecord | undefined {
    const offered = this.list().find((entry) => entry.writerId === writerId);
    if (offered === undefined) return undefined;
    // `offeredPullRequestGuideWriters` withholds colliding ids, so at most one
    // registration matches this id at any instant.
    return this.#registrations.find(
      (record) => record.entry.writerId === writerId && record.entry.writer === offered.writer,
    );
  }

  async run(input: {
    readonly writerId: string;
    readonly request: PullRequestGuideWriteRequest;
    readonly host: PullRequestGuideHostPort;
    readonly signal: AbortSignal;
  }): Promise<PullRequestGuideWriteOutcome> {
    const startingRecord = this.#resolveOfferedRecord(input.writerId);
    let settled = false;
    const isEffective = (): boolean => {
      if (settled || startingRecord === undefined) return false;
      const current = this.#resolveOfferedRecord(input.writerId);
      return current !== undefined && current.identity === startingRecord.identity;
    };
    if (startingRecord === undefined || !isEffective()) {
      return { status: "refused", detail: "The pull request guide writer plugin is not active." };
    }
    if (input.signal.aborted) return { status: "cancelled" };

    const scopedHost: PullRequestGuideHostPort = {
      readPullRequestDiff: async (diffSignal) => {
        if (input.signal.aborted || diffSignal?.aborted === true) {
          return { status: "unavailable", reason: "unavailable" };
        }
        if (!isEffective()) {
          return { status: "unavailable", reason: "not-effective" };
        }
        const diff = await input.host.readPullRequestDiff(diffSignal);
        if (!isEffective()) {
          return { status: "unavailable", reason: "not-effective" };
        }
        return diff;
      },
      runReadOnlyGuideTurn: async (turnInput, turnSignal) => {
        if (input.signal.aborted || turnSignal?.aborted === true) {
          return { status: "cancelled" };
        }
        if (!isEffective()) {
          return {
            status: "refused",
            reason: "not-effective",
            detail: "The pull request guide writer plugin is not active.",
          };
        }
        const result = await input.host.runReadOnlyGuideTurn(turnInput, turnSignal);
        if (!isEffective()) {
          return {
            status: "refused",
            reason: "not-effective",
            detail: "The pull request guide writer plugin is not active.",
          };
        }
        return result;
      },
    };

    let outcome: PullRequestGuideWriteOutcome;
    try {
      outcome = await startingRecord.entry.writer.write(input.request, scopedHost, input.signal);
    } finally {
      settled = true;
    }
    if (input.signal.aborted) return { status: "cancelled" };
    // Check live activation one final time before returning proposed stops.
    const current = this.#resolveOfferedRecord(input.writerId);
    if (current === undefined || current.identity !== startingRecord.identity) {
      return { status: "refused", detail: "The pull request guide writer plugin is not active." };
    }
    return outcome;
  }
}
