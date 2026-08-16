import type {
  GithubAuthenticationSnapshot,
  GithubCloneFailureCode,
  GithubCloneMode,
  GithubCloneState,
} from "@octant/contracts";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ManagedRepositoryIdentity {
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
}

export interface ManagedRepositoryObservation extends ManagedRepositoryIdentity {
  readonly defaultBranch?: string;
}

/**
 * The only allowed managed-clone lifecycle transitions. `verifying` follows
 * `awaiting-confirmation` directly only on the explicit attach-existing path,
 * which stages nothing and clones nothing.
 */
const CLONE_TRANSITIONS: Readonly<Record<GithubCloneState, readonly GithubCloneState[]>> = {
  "awaiting-confirmation": ["reserved", "verifying", "failed", "cancelled"],
  reserved: ["cloning", "failed", "cancelled"],
  cloning: ["verifying", "failed", "cancelled"],
  verifying: ["attaching", "failed", "cancelled", "recovery-required"],
  attaching: ["completed", "failed", "cancelled", "recovery-required"],
  completed: [],
  failed: [],
  cancelled: [],
  "recovery-required": ["cancelled"],
};

export function isGithubCloneTransitionAllowed(
  from: GithubCloneState,
  to: GithubCloneState,
): boolean {
  return CLONE_TRANSITIONS[from].includes(to);
}

export type ManagedRepositorySegmentsDecision =
  | { readonly kind: "derived"; readonly segments: readonly [string, string, string] }
  | { readonly kind: "refused"; readonly code: "invalid-repository-identity" };

/**
 * Derive the inventory-relative destination segments from strict GitHub
 * identity, never display text. Traversal, separators, reserved names, and
 * `.git` suffixes are refused before any path exists.
 */
export function deriveManagedRepositorySegments(input: {
  readonly owner: string;
  readonly name: string;
}): ManagedRepositorySegmentsDecision {
  if (
    !OWNER_PATTERN.test(input.owner) ||
    !NAME_PATTERN.test(input.name) ||
    /\.git$/i.test(input.name)
  ) {
    return { kind: "refused", code: "invalid-repository-identity" };
  }
  return { kind: "derived", segments: ["github.com", input.owner, input.name] };
}

export type GithubCloneAuthorizationDecision =
  | { readonly decision: "allow"; readonly repository: ManagedRepositoryObservation }
  | {
      readonly decision: "deny";
      readonly code: Extract<
        GithubCloneFailureCode,
        | "unauthorized"
        | "non-https-git-protocol"
        | "stale-read"
        | "node-identity-mismatch"
        | "invalid-repository-identity"
      >;
    };

/**
 * Authorize one managed clone or attach against the live authentication
 * snapshot and one fresh normalized repository observation. Stale catalogue
 * data and renamed or substituted repositories never authorize an effect.
 */
export function decideGithubCloneAuthorization(input: {
  readonly snapshot: Pick<GithubAuthenticationSnapshot, "state" | "account">;
  readonly freshness: "fresh" | "stale";
  readonly observed: ManagedRepositoryObservation | undefined;
  readonly expected: ManagedRepositoryIdentity;
}): GithubCloneAuthorizationDecision {
  const state = input.snapshot.state;
  if (state !== "ready" && state !== "scope-limited") {
    return { decision: "deny", code: "unauthorized" };
  }
  if (input.snapshot.account?.gitProtocol !== "https") {
    return { decision: "deny", code: "non-https-git-protocol" };
  }
  if (input.freshness !== "fresh" || input.observed === undefined) {
    return { decision: "deny", code: "stale-read" };
  }
  if (input.observed.nodeId !== input.expected.nodeId) {
    return { decision: "deny", code: "node-identity-mismatch" };
  }
  if (
    input.observed.owner !== input.expected.owner ||
    input.observed.name !== input.expected.name
  ) {
    return { decision: "deny", code: "invalid-repository-identity" };
  }
  return { decision: "allow", repository: input.observed };
}

export type GithubCloneConfirmationDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny";
      readonly code: "state" | "node-identity-mismatch" | "destination-digest-mismatch";
    };

/**
 * Bind one explicit user confirmation to the exact pending operation: same
 * repository node identity and the exact previewed destination digest.
 */
export function decideGithubCloneConfirmation(input: {
  readonly operation: {
    readonly state: GithubCloneState;
    readonly nodeId: string;
    readonly destinationDigest: string;
  };
  readonly command: { readonly nodeId: string; readonly destinationDigest: string };
}): GithubCloneConfirmationDecision {
  if (input.operation.state !== "awaiting-confirmation") {
    return { decision: "deny", code: "state" };
  }
  if (input.command.nodeId !== input.operation.nodeId) {
    return { decision: "deny", code: "node-identity-mismatch" };
  }
  if (input.command.destinationDigest !== input.operation.destinationDigest) {
    return { decision: "deny", code: "destination-digest-mismatch" };
  }
  return { decision: "allow" };
}

export interface ManagedDestinationObservation {
  readonly exists: boolean;
  readonly kind?: "directory" | "symlink" | "file" | "other";
  readonly checkout?:
    | "matching-verified"
    | "bare"
    | "submodule"
    | "wrong-origin"
    | "different"
    | "unverifiable";
}

export type ManagedDestinationClassification =
  | { readonly kind: "available" }
  | { readonly kind: "attachable" }
  | {
      readonly kind: "collision";
      readonly code: Extract<
        GithubCloneFailureCode,
        | "destination-collision"
        | "path-confinement"
        | "bare-repository"
        | "submodule-root"
        | "wrong-origin"
      >;
    };

/**
 * Octant never overwrites, empties, repairs, or adopts an existing
 * destination implicitly. Only a verified checkout of the selected repository
 * is attachable, and only through the explicit attach flow.
 */
export function classifyManagedDestination(
  observation: ManagedDestinationObservation,
): ManagedDestinationClassification {
  if (!observation.exists) return { kind: "available" };
  if (observation.kind === "symlink") return { kind: "collision", code: "path-confinement" };
  if (observation.kind !== "directory") {
    return { kind: "collision", code: "destination-collision" };
  }
  switch (observation.checkout) {
    case "matching-verified":
      return { kind: "attachable" };
    case "bare":
      return { kind: "collision", code: "bare-repository" };
    case "submodule":
      return { kind: "collision", code: "submodule-root" };
    case "wrong-origin":
      return { kind: "collision", code: "wrong-origin" };
    default:
      return { kind: "collision", code: "destination-collision" };
  }
}

/**
 * Normalize one Git remote URL to a GitHub owner/name pair. Anything except
 * exactly `https://github.com/<owner>/<name>[.git]` — including userinfo,
 * query strings, fragments, other hosts, and other protocols — is rejected.
 */
export function normalizeGithubOriginUrl(
  url: string,
): { readonly owner: string; readonly name: string } | undefined {
  const match = /^https:\/\/github\.com\/([^/@:?#]+)\/([^/@:?#]+?)(?:\.git)?$/.exec(url);
  if (match === null) return undefined;
  const owner = match[1] ?? "";
  const name = match[2] ?? "";
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return undefined;
  return { owner, name };
}

export interface ClonedRepositoryVerificationInput {
  /** The staging root realpath remains beneath the reserved inventory. */
  readonly stagingConfined: boolean;
  readonly bare: boolean;
  /** The canonical Git common directory is the staging checkout's own `.git`. */
  readonly commonDirectoryConfined: boolean;
  readonly submodule: boolean;
  readonly worktreeCount: number;
  readonly originUrl: string | undefined;
  readonly expected: ManagedRepositoryIdentity;
  readonly freshObservation: ManagedRepositoryObservation | undefined;
  readonly remoteRefsPresent: boolean;
  readonly remoteHeadBranch: string | undefined;
  readonly resolvedHeadOid: string | undefined;
}

export type ClonedRepositoryVerificationDecision =
  | {
      readonly decision: "verified";
      readonly empty: false;
      readonly oid: string;
      readonly defaultBranch: string;
    }
  | { readonly decision: "verified"; readonly empty: true; readonly defaultBranch?: string }
  | {
      readonly decision: "failed";
      readonly code: Extract<
        GithubCloneFailureCode,
        | "path-confinement"
        | "bare-repository"
        | "submodule-root"
        | "worktree-conflict"
        | "wrong-origin"
        | "stale-read"
        | "node-identity-mismatch"
        | "invalid-repository-identity"
        | "default-branch-mismatch"
        | "verification-failed"
      >;
    };

/**
 * Prove the staged clone's identity before any working-tree content is
 * materialized. Every check fails closed; a verified empty repository is an
 * explicit outcome with no object to check out.
 */
export function verifyClonedRepository(
  input: ClonedRepositoryVerificationInput,
): ClonedRepositoryVerificationDecision {
  if (!input.stagingConfined || !input.commonDirectoryConfined) {
    return { decision: "failed", code: "path-confinement" };
  }
  if (input.bare) return { decision: "failed", code: "bare-repository" };
  if (input.submodule) return { decision: "failed", code: "submodule-root" };
  if (input.worktreeCount !== 1) return { decision: "failed", code: "worktree-conflict" };
  const origin =
    input.originUrl === undefined ? undefined : normalizeGithubOriginUrl(input.originUrl);
  if (
    origin === undefined ||
    origin.owner !== input.expected.owner ||
    origin.name !== input.expected.name
  ) {
    return { decision: "failed", code: "wrong-origin" };
  }
  const fresh = input.freshObservation;
  if (fresh === undefined) return { decision: "failed", code: "stale-read" };
  if (fresh.nodeId !== input.expected.nodeId) {
    return { decision: "failed", code: "node-identity-mismatch" };
  }
  if (fresh.owner !== input.expected.owner || fresh.name !== input.expected.name) {
    return { decision: "failed", code: "invalid-repository-identity" };
  }
  if (!input.remoteRefsPresent) {
    return {
      decision: "verified",
      empty: true,
      ...(fresh.defaultBranch === undefined ? {} : { defaultBranch: fresh.defaultBranch }),
    };
  }
  if (input.remoteHeadBranch === undefined || input.remoteHeadBranch !== fresh.defaultBranch) {
    return { decision: "failed", code: "default-branch-mismatch" };
  }
  if (input.resolvedHeadOid === undefined || !OID_PATTERN.test(input.resolvedHeadOid)) {
    return { decision: "failed", code: "verification-failed" };
  }
  return {
    decision: "verified",
    empty: false,
    oid: input.resolvedHeadOid,
    defaultBranch: input.remoteHeadBranch,
  };
}

export type GithubCloneRecoveryAction =
  | { readonly action: "retain" }
  | { readonly action: "fail"; readonly code: "restart-interrupted" }
  | { readonly action: "quarantine-and-fail"; readonly code: "restart-interrupted" }
  | { readonly action: "recovery-required" };

/**
 * Reconcile one operation after restart. Recovery is deterministic and
 * non-destructive: partial staging is quarantined, a possibly promoted
 * destination requires explicit user attention, and nothing is re-run or
 * reported successful silently.
 */
export function decideGithubCloneRecovery(input: {
  readonly state: GithubCloneState;
  readonly mode: GithubCloneMode;
  readonly stagingExists: boolean;
  readonly destinationExists: boolean;
}): GithubCloneRecoveryAction {
  switch (input.state) {
    case "awaiting-confirmation":
    case "completed":
    case "failed":
    case "cancelled":
    case "recovery-required":
      return { action: "retain" };
    case "reserved":
    case "cloning":
      return input.stagingExists
        ? { action: "quarantine-and-fail", code: "restart-interrupted" }
        : { action: "fail", code: "restart-interrupted" };
    case "verifying":
    case "attaching": {
      if (input.mode === "attach-existing") {
        return { action: "fail", code: "restart-interrupted" };
      }
      if (input.destinationExists) return { action: "recovery-required" };
      return input.stagingExists
        ? { action: "quarantine-and-fail", code: "restart-interrupted" }
        : { action: "fail", code: "restart-interrupted" };
    }
  }
}
