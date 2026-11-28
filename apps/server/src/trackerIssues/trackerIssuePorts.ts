import type { IntegrationExecutionResult } from "@octant/contracts/integration";
import {
  decodeLinearIssueDetail,
  decodeLinearIssueWorkflow,
  LINEAR_ISSUE_COMMENT_OPERATION,
  LINEAR_ISSUE_GET_BY_IDENTIFIER_OPERATION,
  LINEAR_ISSUE_SET_STATE_OPERATION,
  LINEAR_ISSUE_WORKFLOW_OPERATION,
  LINEAR_MISSING_WRITE_SCOPE,
} from "@octant/contracts/linear-issues";
import type { GhIssueWritePort, GhIssueWriteResult } from "../github/ghIssueWritePort";
import type { TrackerIssuePort, TrackerWriteResult } from "./trackerIssueWrites";

/** Runs one operation of the Linear integration plugin through the host's integration service. */
export type LinearOperationRunner = (
  operationId: string,
  input: unknown,
  signal: AbortSignal,
  accountRef?: string,
) => Promise<IntegrationExecutionResult>;

/**
 * The tracker port from the two integration seams: Linear's plugin
 * operations and the host's `gh` issue port. A host without `gh`, or with
 * Octant's GitHub integration turned off, answers every GitHub write
 * `not-connected`: the `gh` login alone never authorizes a write.
 */
export function createTrackerIssuePort(input: {
  readonly linear: LinearOperationRunner;
  readonly github: GhIssueWritePort | undefined;
  readonly githubIsEffective: () => boolean;
}): TrackerIssuePort {
  const signalOf = (signal?: AbortSignal) => signal ?? new AbortController().signal;
  const reachableGithub = input.github;
  const githubOf = () => (input.githubIsEffective() ? reachableGithub : undefined);
  const noGithub = { status: "refused", reason: "not-connected" } as const;
  return {
    linearWorkflow: async (issueId, signal, accountRef) => {
      const result = await input.linear(
        LINEAR_ISSUE_WORKFLOW_OPERATION,
        { id: issueId },
        signalOf(signal),
        accountRef,
      );
      if (result.kind !== "ok") return linearFailure(result);
      try {
        return { status: "read", value: decodeLinearIssueWorkflow(result.value) };
      } catch {
        return { status: "failed", reason: "unavailable" };
      }
    },
    linearSetState: async (issueId, stateId, signal, accountRef) =>
      linearWrite(
        await input.linear(
          LINEAR_ISSUE_SET_STATE_OPERATION,
          { id: issueId, stateId },
          signalOf(signal),
          accountRef,
        ),
      ),
    linearComment: async (issueId, body, signal, accountRef) =>
      linearWrite(
        await input.linear(
          LINEAR_ISSUE_COMMENT_OPERATION,
          { id: issueId, body },
          signalOf(signal),
          accountRef,
        ),
      ),
    githubOpen: async (issue, signal) => {
      const github = githubOf();
      if (github === undefined) return noGithub;
      const result = await github.readState(issue, signal);
      return result.status === "read"
        ? { status: "read", value: result.open }
        : githubFailure(result);
    },
    githubComment: async (issue, body, signal) => {
      const github = githubOf();
      return github === undefined
        ? noGithub
        : githubResult(await github.comment({ ...issue, body }, signal));
    },
    githubClose: async (issue, signal) => {
      const github = githubOf();
      return github === undefined ? noGithub : githubResult(await github.close(issue, signal));
    },
  };
}

/** A Linear identifier's node id, read through the plugin; it also proves the issue exists. */
export async function resolveLinearIdentifier(
  linear: LinearOperationRunner,
  identifier: string,
  signal: AbortSignal,
  accountRef?: string,
): Promise<
  | { readonly status: "found"; readonly issueId: string }
  | { readonly status: "not-found" | "unavailable" }
> {
  const result = await linear(
    LINEAR_ISSUE_GET_BY_IDENTIFIER_OPERATION,
    { identifier },
    signal,
    accountRef,
  );
  // A disconnected or unauthorized Linear refuses too; that is not an answer
  // about the issue, and the person's remedy is Integrations, not the identifier.
  if (result.kind === "refused") {
    return isConnectionRefusal(result.reason) ? { status: "unavailable" } : { status: "not-found" };
  }
  if (result.kind !== "ok") return { status: "unavailable" };
  try {
    return { status: "found", issueId: decodeLinearIssueDetail(result.value).id };
  } catch {
    return { status: "unavailable" };
  }
}

/** Linear's plugin and the host say "connect" or "authorize" in every refusal that a sign-in fixes. */
function isConnectionRefusal(reason: string): boolean {
  return /connect|authori/i.test(reason);
}

function linearWrite(result: IntegrationExecutionResult): TrackerWriteResult {
  return result.kind === "ok" ? { status: "applied" } : linearFailure(result);
}

function linearFailure(
  result: Exclude<IntegrationExecutionResult, { readonly kind: "ok" }>,
): Exclude<TrackerWriteResult, { readonly status: "applied" }> {
  if (result.kind === "refused") {
    if (result.reason === LINEAR_MISSING_WRITE_SCOPE) {
      return { status: "refused", reason: "missing-scope" };
    }
    return isConnectionRefusal(result.reason)
      ? { status: "refused", reason: "not-connected", message: result.reason }
      : { status: "refused", reason: "unavailable", message: result.reason };
  }
  return /rate limited/i.test(result.reason)
    ? { status: "failed", reason: "rate-limited" }
    : { status: "failed", reason: "unavailable" };
}

function githubResult(result: GhIssueWriteResult): TrackerWriteResult {
  return result.status === "applied" ? { status: "applied" } : githubFailure(result);
}

function githubFailure(
  result: Exclude<GhIssueWriteResult, { readonly status: "applied" }>,
): Exclude<TrackerWriteResult, { readonly status: "applied" }> {
  if (result.status === "refused") {
    return {
      status: "refused",
      reason: result.reason === "missing-capability" ? "missing-capability" : "unavailable",
    };
  }
  return { status: "failed", reason: result.reason };
}
