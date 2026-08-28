import type {
  TrackerReference,
  TrackerReferenceResolution,
  TrackerReferenceUnavailableReason,
} from "@octant/contracts";

/**
 * Narrow ports the renderer uses to resolve tracker tags. Callers bind these
 * to the existing Linear/GitHub clients — this module never opens a second
 * credential path or sees raw upstream payloads.
 */
export interface TrackerReferenceResolvePorts {
  readonly github?: {
    readonly available: boolean;
    readonly readIssue: (input: {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
    }) => Promise<TrackerReferenceLookup>;
  };
  readonly linear?: {
    readonly available: boolean;
    readonly getIssue: (key: string) => Promise<TrackerReferenceLookup>;
  };
}

export type TrackerReferenceLookup =
  | {
      readonly kind: "resolved";
      readonly title: string;
      readonly url: string;
      readonly state: "open" | "closed";
    }
  | {
      readonly kind: "unavailable";
      readonly reason: TrackerReferenceUnavailableReason;
      readonly remediation?: string;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "not-found" };

/** Stable identity for cache keys; display still uses `reference.raw`. */
export function trackerReferenceIdentity(reference: TrackerReference): string {
  if (reference.patternKind === "github-issue-or-pull") {
    return `github:${reference.owner}/${reference.name}#${reference.number}`;
  }
  return `tracker:${reference.key}`;
}

/**
 * Resolve a bounded batch of recognized references through the connected
 * tracker ports. Missing, disabled, or unauthorized integrations fail closed
 * to `unclaimed` / `unavailable` / `not-found` — never throws for expected
 * tracker failure.
 */
export async function resolveTrackerReferences(
  references: ReadonlyArray<TrackerReference>,
  ports: TrackerReferenceResolvePorts,
): Promise<ReadonlyArray<TrackerReferenceResolution>> {
  const results: TrackerReferenceResolution[] = [];
  for (const reference of references) {
    results.push(await resolveOne(reference, ports));
  }
  return results;
}

async function resolveOne(
  reference: TrackerReference,
  ports: TrackerReferenceResolvePorts,
): Promise<TrackerReferenceResolution> {
  if (reference.patternKind === "github-issue-or-pull") {
    const github = ports.github;
    if (github === undefined || !github.available) {
      return { status: "unclaimed", reference };
    }
    let lookup: TrackerReferenceLookup;
    try {
      lookup = await github.readIssue({
        owner: reference.owner,
        name: reference.name,
        number: reference.number,
      });
    } catch {
      return { status: "unavailable", reference, reason: "unavailable" };
    }
    return mapLookup(reference, lookup);
  }

  const linear = ports.linear;
  if (linear === undefined || !linear.available) {
    return { status: "unclaimed", reference };
  }
  let lookup: TrackerReferenceLookup;
  try {
    lookup = await linear.getIssue(reference.key);
  } catch {
    return { status: "unavailable", reference, reason: "unavailable" };
  }
  return mapLookup(reference, lookup);
}

function mapLookup(
  reference: TrackerReference,
  lookup: TrackerReferenceLookup,
): TrackerReferenceResolution {
  if (lookup.kind === "resolved") {
    return {
      status: "resolved",
      reference,
      kind: "issue",
      title: lookup.title,
      url: lookup.url,
      state: lookup.state,
    };
  }
  if (lookup.kind === "not-found") {
    return { status: "not-found", reference };
  }
  return {
    status: "unavailable",
    reference,
    reason: lookup.reason,
    ...(lookup.remediation === undefined ? {} : { remediation: lookup.remediation }),
    ...(lookup.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: lookup.retryAfterSeconds }),
  };
}

/** Map Linear workflow state types onto the two-state chip contract. */
export function linearStateToChipState(type: string): "open" | "closed" {
  return type === "completed" || type === "canceled" ? "closed" : "open";
}

/**
 * Map Linear operation failure text onto the closed resolution reasons. The
 * client never receives credentials or GraphQL bodies — only these short
 * reasons from the existing integration seam.
 */
export function linearFailureToLookup(reason: string): TrackerReferenceLookup {
  if (/not available|not found/i.test(reason)) return { kind: "not-found" };
  if (/rate limited/i.test(reason)) return { kind: "unavailable", reason: "rate-limited" };
  if (/cannot read|forbidden|scope/i.test(reason)) {
    return { kind: "unavailable", reason: "scope-limited" };
  }
  if (/connect linear|authorize|unauthorized|reconnect/i.test(reason)) {
    return { kind: "unavailable", reason: "unauthorized" };
  }
  return { kind: "unavailable", reason: "unavailable" };
}

/** Narrow GitHub catalogue reasons that the tracker contract does not name. */
export function githubUnavailableReason(reason: string): TrackerReferenceUnavailableReason {
  if (
    reason === "unauthorized" ||
    reason === "scope-limited" ||
    reason === "rate-limited" ||
    reason === "unavailable"
  ) {
    return reason;
  }
  return "unavailable";
}
