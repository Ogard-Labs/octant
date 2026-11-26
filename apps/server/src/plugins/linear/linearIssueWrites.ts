import type { IntegrationExecutionResult } from "@octant/contracts/integration";
import {
  decodeLinearIssueCommentInput,
  decodeLinearIssueGetInput,
  decodeLinearIssueSetStateInput,
  decodeLinearIssueWorkflow,
  LINEAR_MISSING_WRITE_SCOPE,
  type LinearIssueWorkflow,
} from "@octant/contracts/linear-issues";
import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import {
  graphqlWithReference,
  isRecord,
  LINEAR_ISSUE_FORBIDDEN,
  LINEAR_ISSUE_NOT_FOUND,
  LINEAR_ISSUE_RATE_LIMITED,
  LINEAR_ISSUE_UNAVAILABLE,
  linearGraphql,
  reconnectReason,
  requestLinearCredential,
  type LinearGraphqlResult,
} from "./linearGraphql";

const WORKFLOW_QUERY = `query IssueWorkflow($id: String!) {
  issue(id: $id) {
    id
    identifier
    url
    state { id name type position }
    team { states(first: 100) { nodes { id name type position } } }
  }
}`;

const SET_STATE_MUTATION = `mutation SetIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

const COMMENT_MUTATION = `mutation CommentIssue($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

/** Reads an issue's current state and its team's states. Needs only `read`. */
export async function readLinearIssueWorkflow(
  hostPort: IntegrationHostPort,
  input: unknown,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  let request;
  try {
    request = decodeLinearIssueGetInput(input);
  } catch {
    return refused("The Linear issue request is invalid.");
  }
  const result = await linearGraphql(hostPort, WORKFLOW_QUERY, { id: request.id }, signal);
  if (result.kind !== "ok") return failure(result);
  const workflow = readWorkflow(result.body);
  return workflow === undefined ? refused(LINEAR_ISSUE_NOT_FOUND) : { kind: "ok", value: workflow };
}

export async function setLinearIssueState(
  hostPort: IntegrationHostPort,
  input: unknown,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  let request;
  try {
    request = decodeLinearIssueSetStateInput(input);
  } catch {
    return refused("The Linear state change is invalid.");
  }
  return writeWithScope(hostPort, SET_STATE_MUTATION, request, "issueUpdate", signal);
}

export async function commentLinearIssue(
  hostPort: IntegrationHostPort,
  input: unknown,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  let request;
  try {
    request = decodeLinearIssueCommentInput(input);
  } catch {
    return refused("The Linear comment is invalid.");
  }
  return writeWithScope(
    hostPort,
    COMMENT_MUTATION,
    { issueId: request.id, body: request.body },
    "commentCreate",
    signal,
  );
}

/**
 * Runs one mutation only with a token that may write. An OAuth grant from
 * before Octant asked for `write` is refused here, before any call, so the
 * person learns to reconnect instead of meeting a vague Linear error. A
 * personal key carries no scope the host can see; Linear's own refusal of
 * it maps to the same answer.
 */
async function writeWithScope(
  hostPort: IntegrationHostPort,
  mutation: string,
  variables: Readonly<Record<string, unknown>>,
  field: "issueUpdate" | "commentCreate",
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  const credential = await requestLinearCredential(hostPort);
  if (credential.kind === "unauthorized") return refused(reconnectReason(credential.reconnect));
  if (credential.kind === "unavailable") return failed(LINEAR_ISSUE_UNAVAILABLE, true);
  if (credential.scopes !== undefined && !credential.scopes.includes("write")) {
    return refused(LINEAR_MISSING_WRITE_SCOPE);
  }
  const result = await graphqlWithReference(
    hostPort,
    credential.reference,
    credential.source,
    mutation,
    variables,
    signal,
  );
  if (result.kind === "forbidden") return refused(LINEAR_MISSING_WRITE_SCOPE);
  if (result.kind !== "ok") return failure(result);
  const data = isRecord(result.body) && isRecord(result.body.data) ? result.body.data : undefined;
  const payload = data !== undefined && isRecord(data[field]) ? data[field] : undefined;
  return payload?.success === true
    ? { kind: "ok", value: { applied: true } }
    : failed(LINEAR_ISSUE_UNAVAILABLE, true);
}

function readWorkflow(body: unknown): LinearIssueWorkflow | undefined {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.issue)) return undefined;
  const issue = body.data.issue;
  const team = isRecord(issue.team) ? issue.team : undefined;
  const states = team !== undefined && isRecord(team.states) ? team.states.nodes : undefined;
  try {
    return decodeLinearIssueWorkflow({
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      state: issue.state,
      teamStates: Array.isArray(states) ? states : [],
    });
  } catch {
    return undefined;
  }
}

function failure(
  result: Exclude<LinearGraphqlResult, { readonly kind: "ok" }>,
): IntegrationExecutionResult {
  if (result.kind === "unauthorized") return refused(reconnectReason(result.reconnect));
  if (result.kind === "forbidden") return refused(LINEAR_ISSUE_FORBIDDEN);
  if (result.kind === "rate-limited") return failed(LINEAR_ISSUE_RATE_LIMITED, true);
  return failed(LINEAR_ISSUE_UNAVAILABLE, true);
}

function refused(reason: string): IntegrationExecutionResult {
  return { kind: "refused", reason };
}

function failed(reason: string, retryable: boolean): IntegrationExecutionResult {
  return { kind: "failed", reason, retryable };
}
