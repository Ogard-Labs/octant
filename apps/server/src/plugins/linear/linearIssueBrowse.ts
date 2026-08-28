import type { IntegrationExecutionResult } from "@octant/contracts/integration";
import {
  decodeLinearIssueGetInput,
  decodeLinearIssueListInput,
  LINEAR_ISSUE_FILTERS_OPERATION,
  LINEAR_ISSUE_GET_OPERATION,
  LINEAR_ISSUE_LIST_OPERATION,
  type LinearIssueDetail,
  type LinearIssueFilterOption,
  type LinearIssueFilterOptions,
  type LinearIssueListFilter,
  type LinearIssueListPage,
  type LinearIssueRow,
} from "@octant/contracts/linear-issues";
import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import {
  boundUtf8,
  isRecord,
  LINEAR_ISSUE_FORBIDDEN,
  LINEAR_ISSUE_NOT_FOUND,
  LINEAR_ISSUE_RATE_LIMITED,
  LINEAR_ISSUE_UNAVAILABLE,
  linearGraphql,
  readName,
  reconnectReason,
  type LinearGraphqlResult,
} from "./linearGraphql";

const DEFAULT_PAGE_SIZE = 25;
const ISSUE_BODY_MAX_BYTES = 8 * 1024;
const IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]{0,9})-(\d{1,9})$/;

const ISSUES_QUERY = `query BrowseIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      url
      state { name type }
      assignee { name }
    }
  }
}`;

const ISSUE_QUERY = `query IssueDetail($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    state { name type }
    assignee { name }
  }
}`;

const FILTERS_QUERY = `query IssueFilters {
  teams(first: 50) { nodes { id name key } }
  users(first: 49) { nodes { id name } }
  workflowStates(first: 100) { nodes { id name type team { key } } }
  projects(first: 50) { nodes { id name } }
}`;

export async function executeLinearIssueOperation(
  hostPort: IntegrationHostPort,
  operationId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  if (operationId === LINEAR_ISSUE_LIST_OPERATION) {
    return listIssues(hostPort, input, signal);
  }
  if (operationId === LINEAR_ISSUE_GET_OPERATION) {
    return getIssue(hostPort, input, signal);
  }
  if (operationId === LINEAR_ISSUE_FILTERS_OPERATION) {
    return listFilters(hostPort, signal);
  }
  return refused("Linear issue operations are not available.");
}

async function listIssues(
  hostPort: IntegrationHostPort,
  input: unknown,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  let request;
  try {
    request = decodeLinearIssueListInput(input ?? {});
  } catch {
    return refused("The Linear issue list request is invalid.");
  }
  const filter = buildIssueFilter(request.search, request.filter);
  const variables: Record<string, unknown> = {
    first: request.pageSize ?? DEFAULT_PAGE_SIZE,
  };
  if (request.cursor !== undefined) variables.after = request.cursor;
  if (filter !== undefined) variables.filter = filter;
  const result = await linearGraphql(hostPort, ISSUES_QUERY, variables, signal);
  if (result.kind !== "ok") return graphqlFailure(result);
  const page = readIssuePage(result.body);
  if (page === undefined) return failed(LINEAR_ISSUE_UNAVAILABLE, true);
  return { kind: "ok", value: page };
}

async function getIssue(
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
  const result = await linearGraphql(hostPort, ISSUE_QUERY, { id: request.id }, signal);
  if (result.kind !== "ok") return graphqlFailure(result);
  const detail = readIssueDetail(result.body);
  if (detail === undefined) return refused(LINEAR_ISSUE_NOT_FOUND);
  return { kind: "ok", value: detail };
}

async function listFilters(
  hostPort: IntegrationHostPort,
  signal?: AbortSignal,
): Promise<IntegrationExecutionResult> {
  const result = await linearGraphql(hostPort, FILTERS_QUERY, undefined, signal);
  if (result.kind !== "ok") return graphqlFailure(result);
  const options = readFilterOptions(result.body);
  if (options === undefined) return failed(LINEAR_ISSUE_UNAVAILABLE, true);
  return { kind: "ok", value: options };
}

function buildIssueFilter(
  search: string | undefined,
  filter: LinearIssueListFilter | undefined,
): Record<string, unknown> | undefined {
  const clauses: Record<string, unknown>[] = [];
  if (search !== undefined) {
    const identifier = IDENTIFIER_PATTERN.exec(search.trim().toUpperCase());
    const searchClauses: Record<string, unknown>[] = [{ title: { containsIgnoreCase: search } }];
    if (identifier !== null) {
      const teamKey = identifier[1];
      const number = Number(identifier[2]);
      if (teamKey !== undefined && Number.isInteger(number)) {
        searchClauses.push({
          number: { eq: number },
          team: { key: { eqIgnoreCase: teamKey } },
        });
      }
    }
    clauses.push({ or: searchClauses });
  }
  if (filter?.teamId !== undefined) clauses.push({ team: { id: { eq: filter.teamId } } });
  if (filter?.stateId !== undefined) clauses.push({ state: { id: { eq: filter.stateId } } });
  if (filter?.projectId !== undefined) {
    clauses.push({ project: { id: { eq: filter.projectId } } });
  }
  if (filter?.assigneeId === "unassigned") clauses.push({ assignee: { null: true } });
  else if (filter?.assigneeId !== undefined) {
    clauses.push({ assignee: { id: { eq: filter.assigneeId } } });
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

function readIssuePage(body: unknown): LinearIssueListPage | undefined {
  const connection = readConnection(body, "issues");
  if (connection === undefined) return undefined;
  const rows: LinearIssueRow[] = [];
  for (const node of connection.nodes) {
    const row = readIssueRow(node);
    if (row !== undefined) rows.push(row);
  }
  const page: {
    rows: LinearIssueRow[];
    hasNextPage: boolean;
    endCursor?: string;
  } = {
    rows,
    hasNextPage: connection.hasNextPage,
  };
  if (connection.endCursor !== undefined) page.endCursor = connection.endCursor;
  return page;
}

function readIssueDetail(body: unknown): LinearIssueDetail | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const issue = isRecord(body.data.issue) ? body.data.issue : undefined;
  if (issue === undefined || issue === null) return undefined;
  const row = readIssueRow(issue);
  if (row === undefined) return undefined;
  const descriptionSource = typeof issue.description === "string" ? issue.description : "";
  const description = boundUtf8(descriptionSource, ISSUE_BODY_MAX_BYTES);
  return {
    ...row,
    description: description.text,
    descriptionTruncated: description.truncated,
  };
}

function readIssueRow(value: unknown): LinearIssueRow | undefined {
  if (!isRecord(value)) return undefined;
  const id = readName(value.id, 128);
  const identifier = readName(value.identifier, 16);
  const title = readName(value.title, 256);
  const url = readLinearUrl(value.url);
  const stateValue = isRecord(value.state) ? value.state : undefined;
  const stateName = readName(stateValue?.name, 64);
  const stateType = readName(stateValue?.type, 32);
  if (
    id === undefined ||
    identifier === undefined ||
    title === undefined ||
    url === undefined ||
    stateName === undefined ||
    stateType === undefined
  ) {
    return undefined;
  }
  if (!/^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/.test(identifier)) return undefined;
  const assigneeRecord = isRecord(value.assignee) ? value.assignee : undefined;
  const assignee = readName(assigneeRecord?.name, 128);
  return {
    id,
    identifier,
    title,
    state: { name: stateName, type: stateType },
    url,
    ...(assignee === undefined ? {} : { assignee }),
  };
}

function readFilterOptions(body: unknown): LinearIssueFilterOptions | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const teams = readNamedNodes(body.data.teams, 50, (node) => {
    const key = readName(node.key, 16);
    const name = readName(node.name, 128);
    if (name === undefined) return undefined;
    return key === undefined ? name : `${name} (${key})`;
  });
  const states = readNamedNodes(body.data.workflowStates, 100, (node) => {
    const name = readName(node.name, 64);
    if (name === undefined) return undefined;
    const team = isRecord(node.team) ? readName(node.team.key, 16) : undefined;
    return team === undefined ? name : `${name} (${team})`;
  });
  const users = readNamedNodes(body.data.users, 49, (node) => readName(node.name, 128));
  const projects = readNamedNodes(body.data.projects, 50, (node) => readName(node.name, 128));
  if (
    teams === undefined ||
    states === undefined ||
    users === undefined ||
    projects === undefined
  ) {
    return undefined;
  }
  return {
    teams,
    states,
    assignees: [{ id: "unassigned", label: "Unassigned" }, ...users],
    projects,
  };
}

function readNamedNodes(
  value: unknown,
  limit: number,
  label: (node: Record<string, unknown>) => string | undefined,
): ReadonlyArray<LinearIssueFilterOption> | undefined {
  const nodes = readNodes(value);
  if (nodes === undefined) return undefined;
  const options: LinearIssueFilterOption[] = [];
  for (const node of nodes) {
    if (options.length >= limit) break;
    if (!isRecord(node)) continue;
    const id = readName(node.id, 128);
    const optionLabel = label(node);
    if (id === undefined || optionLabel === undefined) continue;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    options.push({ id, label: optionLabel });
  }
  return options;
}

function readConnection(
  body: unknown,
  key: string,
):
  | {
      readonly nodes: ReadonlyArray<unknown>;
      readonly hasNextPage: boolean;
      readonly endCursor?: string;
    }
  | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const connection = isRecord(body.data[key]) ? body.data[key] : undefined;
  if (connection === undefined) return undefined;
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : undefined;
  const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : undefined;
  if (nodes === undefined || pageInfo === undefined) return undefined;
  if (typeof pageInfo.hasNextPage !== "boolean") return undefined;
  const endCursor =
    typeof pageInfo.endCursor === "string" && /^[A-Za-z0-9+/=_-]{1,600}$/.test(pageInfo.endCursor)
      ? pageInfo.endCursor
      : undefined;
  return {
    nodes,
    hasNextPage: pageInfo.hasNextPage,
    ...(endCursor === undefined ? {} : { endCursor }),
  };
}

function readNodes(value: unknown): ReadonlyArray<unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return undefined;
  return value.nodes;
}

function readLinearUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    /^https:\/\/linear\.app\/[A-Za-z0-9_.\-\/]*$/.test(trimmed) &&
    !trimmed.includes("@") &&
    trimmed.length <= 512
  ) {
    return trimmed;
  }
  return undefined;
}

function graphqlFailure(
  result: Exclude<LinearGraphqlResult, { kind: "ok" }>,
): IntegrationExecutionResult {
  if (result.kind === "unauthorized") {
    return refused(reconnectReason(result.reconnect));
  }
  if (result.kind === "rate-limited") {
    return failed(LINEAR_ISSUE_RATE_LIMITED, true);
  }
  if (result.kind === "forbidden") return refused(LINEAR_ISSUE_FORBIDDEN);
  return failed(LINEAR_ISSUE_UNAVAILABLE, true);
}

function refused(reason: string): IntegrationExecutionResult {
  return { kind: "refused", reason };
}

function failed(reason: string, retryable: boolean): IntegrationExecutionResult {
  return { kind: "failed", reason, retryable };
}

export function linearIssueBrowseCapabilities(): ReadonlyArray<{
  readonly operationId: string;
  readonly available: boolean;
}> {
  return [
    { operationId: LINEAR_ISSUE_LIST_OPERATION, available: true },
    { operationId: LINEAR_ISSUE_GET_OPERATION, available: true },
    { operationId: LINEAR_ISSUE_FILTERS_OPERATION, available: true },
  ];
}

export { LINEAR_ISSUE_NOT_FOUND, LINEAR_ISSUE_RATE_LIMITED, LINEAR_ISSUE_UNAVAILABLE };
