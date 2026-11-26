import type {
  ProviderInstance,
  ProviderServiceLimits,
  ProviderUsageLimitsEntry,
} from "@octant/contracts";

/**
 * One account's reading in one limit window, or the honest absence of one.
 * `remainingPercent` is absent when the account reported the window without
 * a share left, and the whole reading is `missing` when the account reported
 * nothing for this window: never zero, which would read as spent.
 */
export type PooledSegment =
  | {
      readonly kind: "reading";
      readonly providerInstanceId: string;
      readonly account: string;
      readonly remainingPercent?: number;
      readonly exhausted: boolean;
      readonly resetsAt?: string;
      /**
       * The reading's reset has passed, so it says nothing about what is left
       * now until a fresh reading arrives; never an assumed refill.
       */
      readonly awaitingUpdate: boolean;
      /** The reading is the last one before a refresh failed. */
      readonly stale: boolean;
    }
  | {
      readonly kind: "missing";
      readonly providerInstanceId: string;
      readonly account: string;
    };

/** One bar: a limit window across every account of one provider. */
export interface PooledWindow {
  readonly window: string;
  /** Ordered by the soonest reset first; accounts with no reset, then no reading, last. */
  readonly segments: ReadonlyArray<PooledSegment>;
  /** The soonest reset still ahead among the readings, when any account named one. */
  readonly soonestResetAt?: string;
}

export interface PooledProvider {
  readonly driverKind: string;
  readonly accounts: ReadonlyArray<ProviderInstance>;
  readonly windows: ReadonlyArray<PooledWindow>;
}

interface WindowReading {
  readonly window: string;
  readonly remainingPercent?: number;
  readonly exhausted: boolean;
  readonly resetsAt?: string;
}

/** The windows an account's limits name, in the order the account reported them. */
function windowReadings(limits: ProviderServiceLimits): ReadonlyArray<WindowReading> {
  const buckets = (
    [
      ["requests", limits.requests],
      ["tokens", limits.tokens],
      ["concurrent", limits.concurrency],
    ] as const
  ).flatMap(([window, bucket]): ReadonlyArray<WindowReading> => {
    if (bucket.status === "unavailable") return [];
    return [
      {
        window,
        remainingPercent: Math.floor((bucket.remaining / bucket.limit) * 100),
        exhausted: bucket.remaining <= 0,
        ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
      },
    ];
  });
  const windows = (limits.rateLimitWindows ?? []).map(
    (window): WindowReading => ({
      window: window.window,
      ...(window.utilization === undefined
        ? {}
        : { remainingPercent: Math.floor((1 - window.utilization) * 100 + 1e-9) }),
      exhausted: window.status === "exhausted",
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    }),
  );
  return [...windows, ...buckets];
}

/**
 * Driver kinds whose accounts are all accounts of one service, so their
 * windows can share a bar. A compatible endpoint (OpenAI-compatible,
 * Anthropic-compatible, Azure Foundry) names a protocol, not a service: two
 * of them are often different services with their own quotas, and pooling
 * them presented two independent request limits as one window.
 */
const ONE_SERVICE_KINDS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "devin",
  "mistral-vibe",
]);

/**
 * Whether an entry belongs in its provider's pool. An account that can report
 * limits but has not yet (`unsupported` keeps that meaning, `not-ready` waits
 * on an account endpoint) stays in as a No reading segment; dropping it made
 * a provider with one reporting account lose its pooled row.
 */
const poolable = (entry: ProviderUsageLimitsEntry | undefined): boolean =>
  entry !== undefined &&
  (entry.status !== "unavailable" ||
    entry.reason === "unsupported" ||
    entry.reason === "not-ready");

const readingOf = (
  entry: ProviderUsageLimitsEntry | undefined,
): { readonly limits: ProviderServiceLimits; readonly stale: boolean } | undefined => {
  if (entry?.status === "available") return { limits: entry.limits, stale: false };
  if (entry?.status === "failed" && entry.staleLimits !== undefined) {
    return { limits: entry.staleLimits, stale: true };
  }
  return undefined;
};

/**
 * Groups this computer's accounts by provider and each provider's limits by
 * window: one bar per window, one segment per account. There is no averaged
 * share across accounts, because Octant does not know each account's plan
 * size; the segments sit side by side, ordered by which refills first. Each
 * account is counted on its own: Octant has no account identity, so two
 * entries for one real account are two segments.
 *
 * A provider none of whose accounts has a reading is left out, and so is a
 * kind that is not one service; the panel lists their accounts on their
 * own rows or in its closing row.
 */
export function poolProviderLimits(input: {
  readonly entries: ReadonlyArray<ProviderUsageLimitsEntry>;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly now: number;
}): ReadonlyArray<PooledProvider> {
  const byId = new Map(input.entries.map((entry) => [String(entry.providerInstanceId), entry]));
  const groups = new Map<string, ProviderInstance[]>();
  for (const instance of input.instances) {
    const kind = String(instance.driverKind);
    if (!ONE_SERVICE_KINDS.has(kind) || !poolable(byId.get(String(instance.id)))) continue;
    groups.set(kind, [...(groups.get(kind) ?? []), instance]);
  }
  // Accounts that have all yet to report stay in the closing row.
  for (const [kind, accounts] of groups) {
    if (!accounts.some((account) => readingOf(byId.get(String(account.id))) !== undefined)) {
      groups.delete(kind);
    }
  }
  return [...groups.entries()].map(([driverKind, accounts]) => {
    const readings = new Map(
      accounts.map((account) => [String(account.id), readingOf(byId.get(String(account.id)))]),
    );
    const windowNames: string[] = [];
    for (const reading of readings.values()) {
      for (const window of reading === undefined ? [] : windowReadings(reading.limits)) {
        if (!windowNames.includes(window.window)) windowNames.push(window.window);
      }
    }
    const windows = windowNames.map((window): PooledWindow => {
      const segments = accounts.map((account): PooledSegment => {
        const reading = readings.get(String(account.id));
        const found = reading === undefined ? undefined : windowReadings(reading.limits);
        const match = found?.find((candidate) => candidate.window === window);
        if (reading === undefined || match === undefined) {
          return {
            kind: "missing",
            providerInstanceId: String(account.id),
            account: account.displayName,
          };
        }
        // A reset already past says nothing about what is left now.
        const expired = match.resetsAt !== undefined && Date.parse(match.resetsAt) <= input.now;
        // A provider's own "limit reached" outranks the share it reported:
        // Codex can say a window is spent below 100% utilization.
        return {
          kind: "reading",
          providerInstanceId: String(account.id),
          account: account.displayName,
          ...(match.remainingPercent === undefined || expired
            ? {}
            : { remainingPercent: match.exhausted ? 0 : match.remainingPercent }),
          exhausted: match.exhausted && !expired,
          ...(match.resetsAt === undefined || expired ? {} : { resetsAt: match.resetsAt }),
          awaitingUpdate: expired,
          stale: reading.stale,
        };
      });
      const ordered = [...segments].sort((a, b) => resetRank(a) - resetRank(b));
      const soonest = ordered.find(
        (
          segment,
        ): segment is Extract<PooledSegment, { kind: "reading" }> & {
          readonly resetsAt: string;
        } => segment.kind === "reading" && segment.resetsAt !== undefined,
      );
      return {
        window,
        segments: ordered,
        ...(soonest === undefined ? {} : { soonestResetAt: soonest.resetsAt }),
      };
    });
    return { driverKind, accounts, windows };
  });
}

function resetRank(segment: PooledSegment): number {
  if (segment.kind === "missing") return Number.MAX_SAFE_INTEGER;
  if (segment.resetsAt === undefined) return Number.MAX_SAFE_INTEGER - 1;
  return Date.parse(segment.resetsAt);
}
