import { Schema } from "effect";
import {
  GithubRepositoryName,
  GithubRepositoryNodeId,
  GithubRepositoryOwner,
  GithubRepositoryVisibility,
} from "./githubCatalogue";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/i;
const safeText = (limit: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(limit),
    Schema.filter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );
const isoTimestamp = Schema.String.pipe(
  Schema.filter((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)),
);
const branchName = safeText(255).pipe(
  Schema.filter((value) => !/\s/.test(value) && !value.includes("..")),
);

export const GithubCloneRequestId = Schema.String.pipe(
  Schema.filter((value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  ),
);
export type GithubCloneRequestId = typeof GithubCloneRequestId.Type;

/**
 * The durable managed-clone lifecycle. `requested` collapses directly into
 * `awaiting-confirmation`: no filesystem or network side effect exists before
 * the user confirms, so the first journaled state is already confirmable.
 */
export const GithubCloneState = Schema.Literal(
  "awaiting-confirmation",
  "reserved",
  "cloning",
  "verifying",
  "attaching",
  "completed",
  "failed",
  "cancelled",
  "recovery-required",
);
export type GithubCloneState = typeof GithubCloneState.Type;

export const GithubCloneFailureCode = Schema.Literal(
  "unauthorized",
  "capability-unavailable",
  "stale-read",
  "non-https-git-protocol",
  "invalid-repository-identity",
  "inventory-unavailable",
  "destination-collision",
  "case-fold-collision",
  "path-confinement",
  "reservation-conflict",
  "clone-failed",
  "clone-timeout",
  "wrong-origin",
  "node-identity-mismatch",
  "default-branch-mismatch",
  "bare-repository",
  "submodule-root",
  "worktree-conflict",
  "verification-failed",
  "checkout-failed",
  "promotion-failed",
  "revalidation-failed",
  "binding-unavailable",
  "restart-interrupted",
  "unavailable",
);
export type GithubCloneFailureCode = typeof GithubCloneFailureCode.Type;

/**
 * A server-derived absolute POSIX path inside the managed inventory. Paths
 * never carry traversal segments, NUL bytes, or credential-shaped material.
 */
const managedPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1024),
  Schema.filter(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\0") &&
      !SECRETISH.test(value) &&
      !value.split("/").some((segment) => segment === "." || segment === ".."),
  ),
);

const destinationDigest = Schema.String.pipe(
  Schema.filter((value) => /^[a-f0-9]{64}$/.test(value)),
);

export const GithubCloneDestination = Schema.Struct({
  inventoryPath: managedPath,
  destinationPath: managedPath,
  digest: destinationDigest,
}).annotations(strict);
export type GithubCloneDestination = typeof GithubCloneDestination.Type;

export const GithubCloneRepositoryFacts = Schema.Struct({
  nodeId: GithubRepositoryNodeId,
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  visibility: GithubRepositoryVisibility,
  defaultBranch: Schema.optional(branchName),
  /** An explicitly verified empty repository; there is no object to check out. */
  empty: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type GithubCloneRepositoryFacts = typeof GithubCloneRepositoryFacts.Type;

export const GithubCloneFailure = Schema.Struct({
  code: GithubCloneFailureCode,
  remediation: Schema.optional(safeText(256)),
}).annotations(strict);
export type GithubCloneFailure = typeof GithubCloneFailure.Type;

/** Bounded, redacted in-flight progress; never journaled and never raw CLI output. */
export const GithubCloneProgress = Schema.Struct({
  phase: Schema.Literal("cloning", "verifying", "attaching"),
  message: Schema.optional(safeText(160)),
}).annotations(strict);
export type GithubCloneProgress = typeof GithubCloneProgress.Type;

export const GithubCloneMode = Schema.Literal("clone", "attach-existing");
export type GithubCloneMode = typeof GithubCloneMode.Type;

/**
 * One durable managed-clone operation. The binding receipt itself is a
 * one-time capability and deliberately absent: journaled state records only
 * the `bindingIssued` fact.
 */
export const GithubCloneOperation = Schema.Struct({
  requestId: GithubCloneRequestId,
  state: GithubCloneState,
  mode: GithubCloneMode,
  repository: GithubCloneRepositoryFacts,
  destination: GithubCloneDestination,
  failure: Schema.optional(GithubCloneFailure),
  bindingIssued: Schema.optional(Schema.Boolean),
  version: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  requestedAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).annotations(strict);
export type GithubCloneOperation = typeof GithubCloneOperation.Type;

export const GithubCloneRequested = Schema.Struct({
  operation: GithubCloneOperation,
}).annotations(strict);
export type GithubCloneRequested = typeof GithubCloneRequested.Type;

export const GithubCloneTransitioned = Schema.Struct({
  requestId: GithubCloneRequestId,
  fromState: GithubCloneState,
  toState: GithubCloneState,
  version: Schema.Int.pipe(Schema.greaterThanOrEqualTo(2)),
  failure: Schema.optional(GithubCloneFailure),
  /** Updated verification facts (for example the observed default branch). */
  repository: Schema.optional(GithubCloneRepositoryFacts),
  bindingIssued: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type GithubCloneTransitioned = typeof GithubCloneTransitioned.Type;

export const GithubCloneCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("request-clone"),
    requestId: GithubCloneRequestId,
    nodeId: GithubRepositoryNodeId,
    expectedOwner: GithubRepositoryOwner,
    expectedName: GithubRepositoryName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("confirm-clone"),
    requestId: GithubCloneRequestId,
    nodeId: GithubRepositoryNodeId,
    confirmation: Schema.Literal("confirm-github-managed-clone"),
    destinationDigest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-clone"),
    requestId: GithubCloneRequestId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("attach-existing"),
    requestId: GithubCloneRequestId,
    nodeId: GithubRepositoryNodeId,
    confirmation: Schema.Literal("confirm-github-attach-existing"),
    destinationDigest,
  }).annotations(strict),
);
export type GithubCloneCommand = typeof GithubCloneCommand.Type;

/** One ordinary Code Project binding receipt reference, live-response only. */
export const GithubCloneBindingReceipt = Schema.Struct({
  receiptId: Schema.String.pipe(Schema.filter((value) => /^[A-Za-z0-9_-]{43}$/.test(value))),
  projectType: Schema.Literal("code"),
  expiresAt: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type GithubCloneBindingReceipt = typeof GithubCloneBindingReceipt.Type;

export const GithubCloneRefusalReason = Schema.Literal(
  "unauthorized",
  "capability-unavailable",
  "stale-read",
  "non-https-git-protocol",
  "invalid",
  "conflict",
  "not-found",
  "collision",
  "unavailable",
);
export type GithubCloneRefusalReason = typeof GithubCloneRefusalReason.Type;

export const GithubCloneCommandResponse = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("operation"),
    operation: GithubCloneOperation,
    progress: Schema.optional(GithubCloneProgress),
    binding: Schema.optional(GithubCloneBindingReceipt),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: GithubCloneRefusalReason,
    remediation: Schema.optional(safeText(256)),
  }).annotations(strict),
);
export type GithubCloneCommandResponse = typeof GithubCloneCommandResponse.Type;

export const GithubCloneOperationList = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      operation: GithubCloneOperation,
      progress: Schema.optional(GithubCloneProgress),
    }).annotations(strict),
  ).pipe(Schema.maxItems(100)),
}).annotations(strict);
export type GithubCloneOperationList = typeof GithubCloneOperationList.Type;

export const decodeGithubCloneCommand = Schema.decodeUnknownSync(GithubCloneCommand);
export const decodeGithubCloneCommandResponse = Schema.decodeUnknownSync(
  GithubCloneCommandResponse,
);
export const decodeGithubCloneOperation = Schema.decodeUnknownSync(GithubCloneOperation);
export const decodeGithubCloneOperationList = Schema.decodeUnknownSync(GithubCloneOperationList);
export const decodeGithubCloneRequested = Schema.decodeUnknownSync(GithubCloneRequested);
export const decodeGithubCloneTransitioned = Schema.decodeUnknownSync(GithubCloneTransitioned);
